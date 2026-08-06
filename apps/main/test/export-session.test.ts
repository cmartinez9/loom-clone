/**
 * `ExportSession`, driven end to end without an Electron window.
 *
 * The pixels are phase 8's gate and the muxing is `packages/mux/test/`. What is left
 * — and what has the most branches in it — is the *orchestration*: meta before
 * chunks, chunks before the writer is open, the finalize, §7.5's verification round
 * trip through a renderer, the `project.json` record, and captain decision 9's three
 * outcomes. Every one of those is a place where an export could report success
 * having done something else, and phase 9 deletes the user's only copy of the raw
 * sources on the strength of that report.
 *
 * So the store here is the **real** `ProjectStore` writing to a real temp bundle, and
 * only the two things that are genuinely Electron — a `BrowserWindow` and the
 * clipboard — are stood in for. The "renderer" is this file: it answers the commands
 * the session sends exactly as the export page would, with real encoded H.264 from
 * the committed capture fixture.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CHANNEL,
  exportFrameCount,
  type ExportCommand,
  type ExportJob,
  type ExportProgress,
  type ExportSettingsOverride,
} from '@loom/ipc';
import {
  currentSchemaId,
  newEditDocument,
  type EditDocument,
  type FrameIndexDoc,
  type ProjectDoc,
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import { parseMovie } from '@loom/mux';
import {
  ExportDestinationBusyError,
  ExportDestinationError,
  ProjectStore,
} from '../src/project-store.ts';
import { ExportSession, bitrateFor, safeFileName } from '../src/export/session.ts';
import { loadEncodedFixture } from '../../../packages/mux/test/helpers/fixture.ts';

const fixture = loadEncodedFixture();
/** How long the committed fixture is, as a CFR timeline. */
const FIXTURE_SEC = fixture.frames.length / fixture.fps;

/** AAC-LC, 48 kHz, stereo — the two bytes an `AudioSpecificConfig` is. */
const AUDIO_SPECIFIC_CONFIG = new Uint8Array([0x11, 0x90]);
const AUDIO_RATE = 48_000;
const AAC_FRAME = 1024;
/** What AAC-LC puts in front of the sound, and what the `elst` trims. */
const AAC_PRIMING = 2112;

/**
 * A `BrowserWindow` reduced to what `ExportSession` touches, plus a hook to see what
 * was sent to it. Deliberately not a mock of the class: the session uses four
 * members, and standing in for four members is honest where standing in for a window
 * is not.
 */
class FakeWindow extends EventEmitter {
  readonly sent: ExportCommand[] = [];
  destroyed = false;
  /** What `webContents.isLoading()` answers. The page is loaded unless a test says not. */
  loading = false;
  /** A real emitter, so a listener fires when the event happens and not before. */
  readonly contents = new EventEmitter();
  readonly webContents = {
    isLoading: (): boolean => this.loading,
    once: (event: string, listener: (...args: unknown[]) => void): void => {
      this.contents.once(event, listener);
    },
    send: (channel: string, payload: unknown): void => {
      expect(channel).toBe(CHANNEL.exportCommand);
      this.sent.push(payload as ExportCommand);
      this.emit('command', payload);
    },
  };
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface Harness {
  root: string;
  store: ProjectStore;
  session: ExportSession;
  window: FakeWindow;
  /** How many times the session asked for a window to be *created*. */
  opens: () => number;
  progress: ExportProgress[];
  clipboard: string[];
  revealed: string[];
  recordingId: RecordingId;
  bundleDir: string;
  exportsDir: string;
}

let harness: Harness;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'loom-export-session-'));
  const store = new ProjectStore({
    recordingsRoot: join(root, 'recordings'),
    settingsPath: join(root, 'settings.json'),
    appVersion: '0.0.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
  const created = await store.create('Q3 / demo');
  // A clip list covering the whole fixture, so the compiled timeline is as long as
  // the media the fake window below encodes. Without it every bundle here compiles to
  // a zero-length timeline, and §7.5's fourth check — the file against the *edit* —
  // would be comparing a ten-second export against an empty one.
  await writeFile(
    join(created.paths.dir, 'edit.json'),
    JSON.stringify({
      ...newEditDocument(),
      clips: [{ id: 'whole', sourceStart: 0, sourceEnd: FIXTURE_SEC, speed: 1 }],
    }),
    'utf8',
  );

  const window = new FakeWindow();
  const progress: ExportProgress[] = [];
  const clipboard: string[] = [];
  const revealed: string[] = [];
  let opens = 0;
  const session = new ExportSession({
    store,
    openWindow: () => {
      opens += 1;
      return window as unknown as Electron.BrowserWindow;
    },
    // The real registry answers `undefined` for a job with no window; this models
    // that, and never creates one.
    findWindow: () =>
      window.destroyed ? undefined : (window as unknown as Electron.BrowserWindow),
    closeWindow: () => {
      window.destroyed = true;
    },
    broadcast: (p) => progress.push(p),
    copyToClipboard: (path) => {
      clipboard.push(path);
      return true;
    },
    reveal: (path) => {
      revealed.push(path);
      return true;
    },
    newJobId: () => 'job-1',
  });

  harness = {
    root,
    store,
    session,
    window,
    opens: () => opens,
    progress,
    clipboard,
    revealed,
    recordingId: created.id,
    bundleDir: created.paths.dir,
    exportsDir: join(root, 'recordings', 'Exports'),
  };
});

afterEach(async () => {
  await harness.session.shutdown();
  await harness.store.closeAll();
  await rm(harness.root, { recursive: true, force: true });
});

/**
 * How many output frames the real export window would produce for this job.
 *
 * `ExportRenderLoop` runs `exportFrameCount(timeline.durationSec, fps)` frames and no
 * others, so a stand-in that encoded the whole fixture regardless would be producing
 * a file the timeline never asked for — and §7.5's fourth check exists to catch
 * exactly that.
 */
function framesFor(job: ExportJob): number {
  return Math.min(fixture.frames.length, exportFrameCount(job.durationSec, job.settings.fps));
}

/** Play the export page's part: announce the encoder, send its chunks, report done. */
function encodeLikeTheWindow(jobId: string, frames = fixture.frames.length): void {
  const { session } = harness;
  session.onMeta({
    jobId,
    kind: 'video',
    decoderConfig: {
      codec: 'avc1.640028',
      codedWidth: fixture.width,
      codedHeight: fixture.height,
      description: fixture.avcC,
    },
  });
  for (const [i, frame] of fixture.frames.slice(0, frames).entries()) {
    session.onChunk({
      jobId,
      kind: 'video',
      data: frame.data,
      isKey: frame.isKey,
      timestampUs: Math.round((i * 1e6) / fixture.fps),
    });
  }
  session.onPassDone({ jobId, kind: 'video', sampleCount: frames });
}

/**
 * The audio half of the export page, in the order the real one produces it.
 *
 * §5.7 runs the audio pass **to completion** before the video pass, and WebCodecs
 * hands the `decoderConfig` over with the first output chunk — so on the recompose
 * path every audio chunk of the export arrives before the video encoder has said
 * anything at all, which is what main has to be able to hold.
 */
function encodeAudioLikeTheWindow(jobId: string, frames: number): void {
  const { session } = harness;
  session.onMeta({
    jobId,
    kind: 'audio',
    decoderConfig: {
      codec: 'mp4a.40.2',
      sampleRate: AUDIO_RATE,
      numberOfChannels: 2,
      description: AUDIO_SPECIFIC_CONFIG,
    },
  });
  for (let i = 0; i < frames; i++) {
    session.onChunk({
      jobId,
      kind: 'audio',
      // The muxer writes the bytes it is handed; nothing in verification decodes
      // audio, so a recognisable pattern is more useful here than real AAC.
      data: new Uint8Array(96).fill(i % 251),
      isKey: true,
      timestampUs: Math.round((i * AAC_FRAME * 1e6) / AUDIO_RATE),
    });
  }
  session.onPassDone({ jobId, kind: 'audio', sampleCount: frames });
}

/** A `recording.json` on disk, so `audioSources()` and eligibility have something to read. */
async function seedRecording(doc: RecordingDoc): Promise<void> {
  await writeFile(join(harness.bundleDir, 'recording.json'), JSON.stringify(doc), 'utf8');
}

/** An `edit.json` on disk, so a test can trim the timeline without an editor. */
async function seedEdit(overrides: Partial<EditDocument>): Promise<void> {
  const doc: EditDocument = { ...newEditDocument(), ...overrides };
  await writeFile(join(harness.bundleDir, 'edit.json'), JSON.stringify(doc), 'utf8');
}

function micTrack(durationSec: number): RecordingDoc['tracks'] {
  return {
    mic: {
      kind: 'audio',
      parts: [
        {
          file: 'media/mic.000.m4a',
          codec: 'mp4a.40.2',
          startTimeSec: 0,
          durationSec,
          endedEarly: false,
          sampleRate: AUDIO_RATE,
          channels: 2,
          measuredSampleRate: AUDIO_RATE,
          gaps: [],
        },
      ],
    },
  };
}

function screenTrack(): RecordingDoc['tracks'] {
  return {
    screen: {
      kind: 'video',
      parts: [
        {
          file: 'media/screen.000.mp4',
          index: 'media/screen.000.index.json',
          codec: 'avc1.640028',
          startTimeSec: 0,
          durationSec: fixture.frames.length / fixture.fps,
          endedEarly: false,
          size: [fixture.width, fixture.height],
          frameCount: fixture.frames.length,
          rate: { mode: 'variable', nominalFps: fixture.fps, observedFps: fixture.fps },
        },
      ],
    },
  };
}

/** The fixture's own frames as a §2.4 sidecar — keyframes every 30, as it was encoded. */
function frameIndex(): FrameIndexDoc {
  const pts: number[] = [];
  const sizes: number[] = [];
  const offsets: number[] = [];
  const keyframes: number[] = [];
  let offset = 0;
  for (const [i, frame] of fixture.frames.entries()) {
    pts.push(Math.round((i * 1_000_000) / fixture.fps));
    sizes.push(frame.data.byteLength);
    offsets.push(offset);
    offset += frame.data.byteLength;
    if (frame.isKey) keyframes.push(i);
  }
  return {
    schema: currentSchemaId('loom.index'),
    timescale: 1_000_000,
    keyframes,
    pts,
    sizes,
    offsets,
  };
}

/** What is in the Exports folder — including "the folder was never created". */
async function exportsDirEntries(): Promise<string[]> {
  return readdir(harness.exportsDir).catch(() => []);
}

/**
 * Where a file of this name really lands.
 *
 * `resolveExportPath` realpaths the destination — a symlink standing where the
 * Exports folder should be must not be able to put the export somewhere else — and on
 * macOS the temp root itself is under `/var`, which *is* a symlink to `/private/var`.
 * So the recorded path is the resolved one, and a test that compared against the
 * unresolved temp path would be asserting that the resolution did not happen.
 */
async function exportedPath(name: string): Promise<string> {
  return join(await realpath(harness.exportsDir), name);
}

function recordingDoc(tracks: RecordingDoc['tracks']): RecordingDoc {
  return {
    schema: currentSchemaId('loom.recording'),
    clock: { kind: 'videoframe-timestamp-us', t0Us: 0 },
    display: {
      id: 1,
      name: 'Built-in',
      logicalSize: [1728, 1117],
      pixelSize: [fixture.width, fixture.height],
      scaleFactor: 2,
      colorSpace: 'srgb',
    },
    tracks,
    events: {},
    capture: {
      app: '0.0.0',
      os: '14.0',
      permissions: {
        screen: 'granted',
        camera: 'not-determined',
        microphone: 'granted',
        accessibility: false,
      },
      requestedFps: fixture.fps,
      resolutionClamp: '3840',
      droppedFrames: {},
    },
    integrity: { finalizedAt: null, recoveredFromCrash: false, truncatedToSec: null },
  };
}

/** Answer §7.5's decode check the way `verify-decode.ts` would. */
function answerVerification(ok = true): void {
  harness.window.on('command', (command: ExportCommand) => {
    if (command.kind !== 'verify') return;
    harness.session.onDecoded({
      jobId: command.jobId,
      ok,
      framesDecoded: ok ? command.request.chunks.length : 0,
      lastTimestampUs: ok ? command.request.expectLastTimestampUs : null,
      ...(ok ? {} : { error: 'the decoder produced no frames' }),
    });
  });
}

/** Wait for a terminal progress report. */
async function settled(): Promise<ExportProgress> {
  for (let i = 0; i < 2000; i++) {
    const last = harness.progress.at(-1);
    if (last !== undefined && ['done', 'failed', 'cancelled'].includes(last.phase)) return last;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(
    `the job never settled; saw ${JSON.stringify(harness.progress.map((p) => p.phase))}`,
  );
}

async function projectDoc(id: RecordingId): Promise<ProjectDoc> {
  const dir = await harness.store.directoryFor(id);
  return JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as ProjectDoc;
}

describe('ExportSession', () => {
  it('defaults the destination and the name without prompting for either', async () => {
    const defaults = await harness.session.defaults(harness.recordingId);
    // Captain decision 9: a sensible default location, changeable, never a modal.
    expect(defaults.outputDir).toBe(harness.exportsDir);
    // The recording is called "Q3 / demo"; a slash is not a directory here.
    expect(defaults.name).toBe('Q3 demo');
    expect(defaults.keepSources).toBe(false);
    // Size and rate come from `edit.json`'s own `output`, not from a guess.
    expect([defaults.width, defaults.height]).toEqual([1920, 1080]);
    expect(defaults.fps).toBe(30);
    expect(defaults.bitrate).toBe(bitrateFor(1920, 1080, 30));
  });

  it('carries a job from the first chunk to a file on disk, on the clipboard, revealed', async () => {
    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });

    const { jobId } = await harness.session.start(harness.recordingId, { name: 'Demo' });
    const outcome = await settled();

    expect(outcome.phase).toBe('done');
    const result = outcome.result;
    expect(result).toBeDefined();
    if (result === undefined) return;

    // Captain decision 9's whole contract, and each third of it separately.
    expect(result.path).toBe(await exportedPath('Demo.mp4'));
    expect(harness.clipboard).toEqual([result.path]);
    expect(harness.revealed).toEqual([result.path]);
    expect(await readdir(harness.exportsDir)).toEqual(['Demo.mp4']);

    // §7.5's five, all of them, recorded.
    expect(result.verified.exists).toBe(true);
    expect(result.verified.bytes).toBeGreaterThan(0);
    expect(result.verified.lastFrameDecodable).toBe(true);
    expect(result.verified.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sourcesKept).toBe(false);

    // And in `project.json`, which is where phase 9 reads them.
    const doc = await projectDoc(harness.recordingId);
    expect(doc.exports).toHaveLength(1);
    expect(doc.exports[0]?.id).toBe(jobId);
    expect(doc.exports[0]?.verified?.lastFrameDecodable).toBe(true);
    expect(doc.exports[0]?.error).toBeUndefined();
    // Phase 9 now acts on that record: a verified-good export hands the recording to
    // retention, which writes the record and sets the state. What it deletes, and
    // that a *failed* export deletes nothing, is `phase9-retention.test.ts`'s
    // question — this only pins that the two are wired together, because an export
    // that verified and then left the recording editable would be phase 9 silently
    // absent.
    expect(result.sourcesDeleted).toBe(true);
    expect(doc.state).toBe('exported');
    expect(doc.retention?.reason).toBe('export-verified');

    // Progress reached the end monotonically rather than jumping there.
    expect(harness.progress.map((p) => p.phase)).toContain('verifying');
    expect(outcome.completed).toBe(1);
  }, 60_000);

  it('records `sourcesKept` when the escape hatch is used', async () => {
    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });
    await harness.session.start(harness.recordingId, { name: 'Kept', keepSources: true });
    const outcome = await settled();
    expect(outcome.phase).toBe('done');
    expect(outcome.result?.sourcesKept).toBe(true);
    // §7.5 obligation 4 is one boolean and one branch, and this is the boolean phase
    // 9 branches on.
    const doc = await projectDoc(harness.recordingId);
    expect(doc.exports[0]?.sourcesKept).toBe(true);
  }, 60_000);

  it('fails the export, keeps the record, and leaves no file when the last frame will not decode', async () => {
    answerVerification(false);
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });
    await harness.session.start(harness.recordingId, { name: 'Broken' });
    const outcome = await settled();

    expect(outcome.phase).toBe('failed');
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toMatch(/does not decode/);
    // Not on the clipboard, not revealed, and not on disk — an unverified export must
    // not be there to be mistaken for one that passed.
    expect(harness.clipboard).toEqual([]);
    expect(harness.revealed).toEqual([]);
    expect(await readdir(harness.exportsDir)).toEqual([]);
    // But recorded, with the checks that did pass. "No record" and "a record saying
    // it failed" are different things to wake up to.
    const doc = await projectDoc(harness.recordingId);
    expect(doc.exports).toHaveLength(1);
    expect(doc.exports[0]?.error).toMatch(/does not decode/);
    expect(doc.exports[0]?.verified?.exists).toBe(true);
    expect(doc.exports[0]?.verified?.lastFrameDecodable).toBe(false);
  }, 60_000);

  it('refuses a pass that produced no samples', async () => {
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      const jobId = command.job.jobId;
      harness.session.onMeta({
        jobId,
        kind: 'video',
        decoderConfig: { codec: 'avc1.640028', description: fixture.avcC },
      });
      harness.session.onPassDone({ jobId, kind: 'video', sampleCount: 0 });
    });
    await harness.session.start(harness.recordingId, { name: 'Empty' });
    const outcome = await settled();
    expect(outcome.phase).toBe('failed');
    expect(outcome.error).toMatch(/no samples/);
    expect(await readdir(harness.exportsDir)).toEqual([]);
  }, 60_000);

  it('cancels mid-job and leaves nothing behind', async () => {
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      const jobId = command.job.jobId;
      // Half the frames and **no** `passDone`, then a cancel — the shape of a user
      // pressing the button while the encode is still running.
      encodeLikeTheWindowPartially(jobId);
      harness.session.cancel(jobId);
    });
    await harness.session.start(harness.recordingId, { name: 'Cancelled' });
    const outcome = await settled();

    expect(outcome.phase).toBe('cancelled');
    expect(outcome.result).toBeUndefined();
    expect(harness.clipboard).toEqual([]);
    expect(harness.revealed).toEqual([]);
    // Not "the output is absent" — *nothing* is, including the scratch streams a
    // later pass or a curious user could mistake for a shorter export.
    expect(await readdir(harness.exportsDir)).toEqual([]);
    // A cancel is not a failure, so nothing is recorded against the recording.
    expect((await projectDoc(harness.recordingId)).exports).toEqual([]);
  }, 60_000);

  it('exports a recording that has audio, whose whole audio pass precedes the video meta', async () => {
    // The bug this pins: `#openWriterWhenReady` cannot open until the video encoder
    // has announced its `avcC`, and WebCodecs only hands that over with the video
    // encoder's *first chunk* — which on the recompose path is after the entire audio
    // pass (§5.7's deliberate order). Every audio chunk therefore arrives before the
    // writer exists, and refusing them failed every export of a recording with audio
    // before a single sample reached disk.
    //
    // Both existing gates missed it for the same reason: `test/export-golden/` exports
    // video only, and every other case in this file uses a bundle with no tracks, so
    // `passes.audio` was never true.
    const durationSec = fixture.frames.length / fixture.fps;
    await seedRecording(recordingDoc(micTrack(durationSec)));
    // `runAudioPass` feeds `ceil(D * rate / 1024)` blocks and the encoder emits
    // `ceil(2112 / 1024) = 3` more for its own priming and flush — so a real audio
    // pass produces this many chunks, not the block count. Modelling the block count
    // alone was the single value with the most headroom against §7.5's duration
    // check, which is the opposite of what a test of that check should feed it.
    const audioFrames =
      Math.ceil((durationSec * AUDIO_RATE) / AAC_FRAME) + Math.ceil(AAC_PRIMING / AAC_FRAME);

    answerVerification();
    let passes: { audio: boolean; video: boolean } | null = null;
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      passes = command.job.passes;
      encodeAudioLikeTheWindow(command.job.jobId, audioFrames);
      encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });

    await harness.session.start(harness.recordingId, { name: 'WithAudio' });
    const outcome = await settled();

    expect(passes).toEqual({ audio: true, video: true });
    expect(outcome.error).toBeUndefined();
    expect(outcome.phase).toBe('done');
    expect(await readdir(harness.exportsDir)).toEqual(['WithAudio.mp4']);

    // And both tracks are in the finished file — the audio was held and written, not
    // merely tolerated. Read off the disk, because that is the only account of the
    // export that phase 9 may act on.
    const path = join(harness.exportsDir, 'WithAudio.mp4');
    const bytes = new Uint8Array(await readFile(path));
    const movie = parseMovie(bytes);
    const video = movie.tracks.find((track) => track.handler === 'vide');
    const audio = movie.tracks.find((track) => track.handler === 'soun');
    expect(video?.samples).toHaveLength(fixture.frames.length);
    expect(audio?.samples).toHaveLength(audioFrames);

    // §7.5's fourth check ran against this file and passed, so the margin is a
    // measurement rather than an assumption. `mvhd` is the longest track *presented*,
    // which here is the audio: the AAC blocks round up past the video and the priming
    // is subtracted. A `mvhd` that counted the priming would spend 44 ms of the 100 ms
    // budget on sound no player plays.
    expect(movie.durationSec).toBeCloseTo((audioFrames * AAC_FRAME - AAC_PRIMING) / AUDIO_RATE, 3);
    expect(Math.abs(movie.durationSec - durationSec)).toBeLessThan(0.1);

    // In the order they were produced, which is what "held, in arrival order" means:
    // each chunk's payload is stamped with its own index, so a buffer flushed
    // backwards is a file whose first audio sample is the last one encoded.
    const first = audio?.samples[0];
    const last = audio?.samples.at(-1);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;
    expect(bytes[first.offset]).toBe(0);
    expect(bytes[last.offset]).toBe((audioFrames - 1) % 251);
  }, 60_000);

  it('recomposes a mid-GOP trim rather than failing the copy it cannot make', async () => {
    // §5.3's fast path needs cut points on keyframes. A trim that misses one used to
    // be reported eligible, so the job committed to a copy with no video pass asked
    // for and `#copyVideo` then threw — a failed export where the recompose path
    // could have produced exactly the file the user asked for.
    const fps = fixture.fps;
    await seedRecording(recordingDoc(screenTrack()));
    await seedEdit({
      clips: [{ id: 'a', sourceStart: 3 / fps, sourceEnd: 20 / fps, speed: 1 }],
      output: { size: [fixture.width, fixture.height], fps, background: { kind: 'none' } },
    });
    await writeFile(
      join(harness.bundleDir, 'media', 'screen.000.index.json'),
      JSON.stringify(frameIndex()),
      'utf8',
    );

    // The button says why, and it names the cut rather than shrugging.
    const preview = await harness.session.previewMode(
      harness.recordingId,
      await harness.session.defaults(harness.recordingId),
    );
    expect(preview.mode).toBe('recompose');
    expect(preview.reasons.join(' ')).toMatch(/cut at 0\.100s is not on a keyframe/);

    answerVerification();
    let passes: { audio: boolean; video: boolean } | null = null;
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      passes = command.job.passes;
      encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });

    const outcome = await (async () => {
      await harness.session.start(harness.recordingId, { name: 'Trimmed' });
      return settled();
    })();

    // The window was asked for a video pass, which is what "falls back" means.
    expect(passes).toEqual({ audio: false, video: true });
    expect(outcome.error).toBeUndefined();
    expect(outcome.phase).toBe('done');
    expect(outcome.mode).toBe('recompose');
    expect(await readdir(harness.exportsDir)).toEqual(['Trimmed.mp4']);
  }, 60_000);

  it('fails a job whose window never loads instead of waiting for it for ever', async () => {
    // §10.2's named symptom: an export that hangs with no error. `did-finish-load`
    // was awaited unbounded, so a page that fails to load — or a window destroyed
    // under the await — left the job in `preparing` with its scratch on disk.
    harness.window.loading = true;
    await harness.session.start(harness.recordingId, { name: 'NeverLoads' });
    await new Promise((done) => setTimeout(done, 20));
    harness.window.contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND');

    const outcome = await settled();
    expect(outcome.phase).toBe('failed');
    expect(outcome.error).toMatch(/failed to load/);
    expect(await exportsDirEntries()).toEqual([]);
  }, 60_000);

  it('lets a cancel break a job out of a load that never finishes', async () => {
    harness.window.loading = true;
    const { jobId } = await harness.session.start(harness.recordingId, { name: 'Wedged' });
    await new Promise((done) => setTimeout(done, 20));
    harness.session.cancel(jobId);

    const outcome = await settled();
    expect(outcome.phase).toBe('cancelled');
    expect(await exportsDirEntries()).toEqual([]);
  }, 60_000);

  it('reports the failure from the window rather than hanging on it, and records it', async () => {
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      harness.session.onFailed({
        jobId: command.job.jobId,
        message: 'no VideoEncoder configuration supports 1920x1080 H.264 on this machine',
      });
    });
    const { jobId } = await harness.session.start(harness.recordingId, { name: 'NoEncoder' });
    const outcome = await settled();
    expect(outcome.phase).toBe('failed');
    expect(outcome.error).toMatch(/no VideoEncoder configuration/);

    // A failure *before* the file exists is recorded too. "No record" and "a record
    // saying it failed" are different things to wake up to, and an encoder this
    // machine cannot configure used to leave nothing at all behind: the job vanished
    // and the only trace was a broadcast no window subscribes to yet.
    const doc = await projectDoc(harness.recordingId);
    expect(doc.exports).toHaveLength(1);
    expect(doc.exports[0]?.id).toBe(jobId);
    expect(doc.exports[0]?.error).toMatch(/no VideoEncoder configuration/);
    // No `verified` block at all: nothing was checked, and an empty one would read as
    // five checks that failed rather than five that never ran.
    expect(doc.exports[0]?.verified).toBeUndefined();
    expect(await exportsDirEntries()).toEqual([]);
  }, 60_000);

  it('fails the job when the export window’s renderer dies mid-pass', async () => {
    // §10.2's named symptom, through the one path nothing else covered: a renderer
    // killed for memory sends no chunk, no `passDone` and no `exportFailed`, so
    // `#awaitPasses` waited for ever — the job stuck in `#jobs`, the writer and its
    // two `wx+` scratch streams open, the destination claimed, progress frozen.
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      // A few frames, so there is a real writer and real scratch on disk, and then
      // the process goes.
      encodeLikeTheWindowPartially(command.job.jobId);
      setTimeout(() => {
        harness.window.contents.emit('render-process-gone', {}, { reason: 'oom' });
      }, 10);
    });
    await harness.session.start(harness.recordingId, { name: 'Dead' });
    const outcome = await settled();

    expect(outcome.phase).toBe('failed');
    expect(outcome.error).toMatch(/renderer process is gone \(oom\)/);
    // And it left nothing — not the output, not the scratch streams.
    expect(await exportsDirEntries()).toEqual([]);
    const doc = await projectDoc(harness.recordingId);
    expect(doc.exports[0]?.error).toMatch(/renderer process is gone/);
  }, 60_000);

  it('does not build a window in order to cancel a job', async () => {
    // `#send` used to resolve its target with `openWindow`, which *creates* one. A
    // stream-copy job with no audio never opens a window at all, so cancelling it
    // constructed a hidden BrowserWindow, loaded export.html into it, sent a `cancel`
    // nobody was listening for, and destroyed it again.
    harness.window.loading = true;
    const { jobId } = await harness.session.start(harness.recordingId, { name: 'Wedged' });
    await new Promise((done) => setTimeout(done, 20));
    const before = harness.opens();
    harness.session.cancel(jobId);
    expect(harness.opens()).toBe(before);
    expect((await settled()).phase).toBe('cancelled');
  }, 60_000);
});

/**
 * §7.5's fourth check — *"duration within 100 ms of expected"* — and what "expected"
 * is allowed to mean.
 *
 * It used to be `ExportMp4Writer.finalize()`'s own tally, which is the number
 * `mvhd.duration` was written from, so the check compared the writer with itself and
 * could only fail on header bytes the parse above it had already rejected. It is one
 * of the five facts phase 9 deletes the user's only copy of a recording on the
 * strength of, so it has to be answered against something the writer did not produce:
 * the **timeline's** own duration.
 */
describe('§7.5’s duration check is against the edit, not the writer', () => {
  it('fails an export that is not as long as the timeline asked for', async () => {
    answerVerification();
    let asked = 0;
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      asked = framesFor(command.job);
      // Half the frames, *with* a `passDone` claiming them — an encode that stopped
      // early and reported success, which is what a truncated export looks like from
      // main. Every other check still passes: the file exists, is non-zero, demuxes,
      // is faststart, and its last frame decodes.
      encodeLikeTheWindow(command.job.jobId, Math.floor(asked / 2));
    });

    await harness.session.start(harness.recordingId, { name: 'Short' });
    const outcome = await settled();

    expect(asked).toBe(fixture.frames.length);
    expect(outcome.phase).toBe('failed');
    expect(outcome.error).toMatch(/was expected/);
    expect(outcome.error).toMatch(/§7\.5 allows/);
    // Discarded, not left: a file the app knows is wrong must not sit in the user's
    // Exports folder under the finished name.
    expect(await exportsDirEntries()).toEqual([]);
    expect(harness.clipboard).toEqual([]);

    // Recorded with the checks that did pass, and with `lastFrameDecodable` false —
    // the duration check stops the run before the decode is ever attempted.
    const doc = await projectDoc(harness.recordingId);
    expect(doc.exports).toHaveLength(1);
    expect(doc.exports[0]?.verified?.exists).toBe(true);
    expect(doc.exports[0]?.verified?.lastFrameDecodable).toBe(false);
    expect(doc.exports[0]?.error).toMatch(/was expected/);
  }, 60_000);

  it('passes the same export when it is the length the timeline asked for', async () => {
    // The control. Without it, "the duration check fires" and "the duration check
    // always fires" read identically — and the second would fail every real export.
    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });
    await harness.session.start(harness.recordingId, { name: 'Full' });
    const outcome = await settled();
    expect(outcome.error).toBeUndefined();
    expect(outcome.phase).toBe('done');
    expect(outcome.result?.durationSec).toBeCloseTo(FIXTURE_SEC, 3);
  }, 60_000);

  it('measures a trimmed edit against the trim, not the source', async () => {
    // The half a writer-against-itself check can never see: a trim makes the timeline
    // shorter than the media, so an export that ignored the clip list and encoded the
    // whole recording produces a file that is internally consistent and wrong.
    const fps = fixture.fps;
    await seedEdit({
      clips: [{ id: 'a', sourceStart: 0, sourceEnd: 60 / fps, speed: 1 }],
      output: { size: [fixture.width, fixture.height], fps, background: { kind: 'none' } },
    });
    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      // The whole fixture rather than the 60 frames the trim asks for.
      encodeLikeTheWindow(command.job.jobId, fixture.frames.length);
    });
    await harness.session.start(harness.recordingId, { name: 'Ignored' });
    const outcome = await settled();
    expect(outcome.phase).toBe('failed');
    expect(outcome.error).toMatch(/was expected/);
    expect(await exportsDirEntries()).toEqual([]);
  }, 60_000);
});

/**
 * Where the file goes is main's decision, and only main's.
 *
 * `ExportSession.start` composes `<exportRoot>/<name>.mp4`, `beginExport` `mkdir -p`s
 * the directory, `finalize` `rename(2)`s over the output and a failed verification
 * removes it. A caller that could name the directory would therefore be naming what
 * gets created, what gets replaced and what gets deleted — §0 rule 1 read backwards,
 * since a sandboxed renderer has no filesystem precisely so that it cannot.
 */
describe('the export destination', () => {
  it('refuses an override that tries to name the directory', async () => {
    const elsewhere = join(harness.root, 'not-the-exports-folder');
    await expect(
      harness.session.start(harness.recordingId, {
        outputDir: elsewhere,
      } as unknown as ExportSettingsOverride),
    ).rejects.toBeInstanceOf(ExportDestinationError);
    // Refused before anything was created, which is the half that matters: a check
    // that fired after the `mkdir` would still have let a renderer make directories.
    expect(await readdir(elsewhere).catch(() => null)).toBeNull();
    expect(await exportsDirEntries()).toEqual([]);
  }, 60_000);

  it('keeps a name that looks like a path inside the exports folder', async () => {
    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });
    await harness.session.start(harness.recordingId, { name: '../../../etc/passwd' });
    const outcome = await settled();
    expect(outcome.phase).toBe('done');
    // `safeFileName` turns every separator into a space and strips the leading dots,
    // so the join is one segment inside the folder main chose.
    expect(outcome.result?.path).toBe(await exportedPath('.. .. etc passwd.mp4'));
    expect(await readdir(harness.exportsDir)).toEqual(['.. .. etc passwd.mp4']);
  }, 60_000);

  it('resolves the destination through a symlink rather than writing into it', async () => {
    // `resolveExportPath` realpaths the directory the way `resolveBundleFile` does, so
    // a link standing where the Exports folder should be cannot put the export
    // somewhere the app never named — and the path recorded in `project.json` is the
    // real one rather than the link's.
    const real = join(harness.root, 'real-exports');
    await mkdir(real, { recursive: true });
    await mkdir(dirname(harness.exportsDir), { recursive: true });
    await symlink(real, harness.exportsDir, 'dir');

    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });
    await harness.session.start(harness.recordingId, { name: 'Linked' });
    const outcome = await settled();

    expect(outcome.phase).toBe('done');
    expect(outcome.result?.path).toBe(join(await realpath(real), 'Linked.mp4'));
    expect(await readdir(real)).toEqual(['Linked.mp4']);
  }, 60_000);
});

/**
 * The bundle lock the export takes, and gives back.
 *
 * `start` opens the project — the lock, a `JournalWriter`, a journal replay — because
 * `recordExport` requires an open project. Nothing released it, so one export held the
 * `.lock` until `before-quit` and the next launch swept a lock that was never stale.
 * A bare `close()` in the `finally` is not the fix: an editor with the same project
 * open would lose its lock mid-edit.
 */
describe('the project an export opened', () => {
  /**
   * Whether a *second* process could take this bundle's lock, within a moment.
   *
   * Polled rather than sampled once: `#finish` broadcasts the terminal phase from the
   * `catch`/`try`, and the release runs in the `finally` after it, so `settled()`
   * resolving does not mean the lock has already gone.
   */
  async function lockBecomesFree(): Promise<boolean> {
    for (let i = 0; i < 200; i++) {
      if (await lockIsFree()) return true;
      await new Promise((done) => setTimeout(done, 5));
    }
    return false;
  }

  /** Whether a *second* process could take this bundle's lock right now. */
  async function lockIsFree(): Promise<boolean> {
    const other = new ProjectStore({
      recordingsRoot: join(harness.root, 'recordings'),
      settingsPath: join(harness.root, 'other-settings.json'),
      appVersion: '0.0.0-test',
      trash: () => Promise.resolve(),
    });
    try {
      await other.openProject(harness.recordingId);
      await other.closeAll();
      return true;
    } catch {
      return false;
    }
  }

  it('is released when the export is the only thing holding it', async () => {
    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });
    expect(await lockIsFree()).toBe(true);
    await harness.session.start(harness.recordingId, { name: 'Released' });
    expect((await settled()).phase).toBe('done');
    expect(await lockBecomesFree()).toBe(true);
  }, 60_000);

  it('is left open when something else holds it too', async () => {
    // An editor with the recording open, which is the case a bare `close()` would
    // break. The export must let go of *its* hold and nothing else.
    await harness.store.openProject(harness.recordingId);
    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });
    await harness.session.start(harness.recordingId, { name: 'StillOpen' });
    expect((await settled()).phase).toBe('done');
    // Given every chance to be released, and still held — the editor's hold survives.
    expect(await lockBecomesFree()).toBe(false);
  }, 60_000);

  it('is released after a failed export too', async () => {
    answerVerification(false);
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
    });
    await harness.session.start(harness.recordingId, { name: 'Failed' });
    expect((await settled()).phase).toBe('failed');
    expect(await lockBecomesFree()).toBe(true);
  }, 60_000);
});

/**
 * Two exports aimed at one destination.
 *
 * `ExportSession.start` mints a job id per press with no opinion about the output
 * path, so two exports of one recording — or of two recordings whose `safeFileName`
 * collides — arrive as different jobs on the same three scratch paths. They cannot
 * share: `ExportMp4Writer.create` sweeps that scratch, `cancel()` unlinks the
 * `.partial`, and both `rename(2)` over the same output, so the loser silently
 * replaces a *verified* export with an unverified one.
 *
 * The refusal is only half of it. A guard that refused the second while corrupting
 * the first would be worse than the collision, so what is asserted here is mostly
 * about the export already in flight.
 */
describe('two exports aimed at one destination', () => {
  const videoSpec = (): {
    width: number;
    height: number;
    timescale: number;
    avcC: Uint8Array;
  } => ({
    width: fixture.width,
    height: fixture.height,
    timescale: fixture.fps * 1000,
    avcC: fixture.avcC,
  });

  /**
   * Run every already-queued continuation, and no I/O at all.
   *
   * That asymmetry is what makes the two window tests deterministic rather than a
   * race. A claim released *before* the awaited work is released by a continuation,
   * which is pure microtask scheduling and therefore happens here. Everything
   * `finalize` and `cancel` actually do — `handle.sync()`, `open`, `rename`,
   * `unlink` — settles on the event loop, which a microtask drain cannot advance. So
   * the window is guaranteed still open when the second `beginExport` lands.
   */
  async function drainMicrotasks(turns = 20): Promise<void> {
    for (let i = 0; i < turns; i++) await Promise.resolve();
  }

  async function appendFrames(jobId: string, from: number, to: number): Promise<void> {
    for (const [i, frame] of fixture.frames.slice(from, to).entries()) {
      await harness.store.appendExportSample(jobId, 'video', {
        data: frame.data,
        durationUnits: 1000,
        isKey: frame.isKey,
        timestampUs: Math.round(((from + i) * 1e6) / fixture.fps),
      });
    }
  }

  it('refuses the second and leaves the first writing', async () => {
    const { store } = harness;
    const outputPath = join(harness.exportsDir, 'Busy.mp4');

    // Both in the same turn — the shape two presses actually have, and the one the
    // pre-`await` registration exists to cover.
    const first = store.beginExport('job-a', { outputPath, video: videoSpec() });
    const refusal: unknown = await store
      .beginExport('job-b', { outputPath, video: videoSpec() })
      .then(() => null)
      .catch((error: unknown) => error);
    await first;

    expect(refusal).toBeInstanceOf(ExportDestinationBusyError);
    expect(refusal).toBeInstanceOf(Error);
    if (!(refusal instanceof ExportDestinationBusyError)) return;
    // Named, both halves: what is busy, and who has it.
    expect(refusal.outputPath).toBe(outputPath);
    expect(refusal.heldBy).toBe('job-a');
    expect(refusal.message).toContain(outputPath);
    expect(refusal.message).toContain('job-a');
    // And refused *before* anything was registered, so the loser cannot later
    // finalize, cancel or append against a writer it never opened.
    expect(store.hasOpenExport('job-b')).toBe(false);
    expect(store.hasOpenExport('job-a')).toBe(true);

    await appendFrames('job-a', 0, fixture.frames.length);

    // The first job's scratch survived the refusal — the whole point. A sweep run on
    // job B's behalf would have unlinked this, and job A would have gone on writing
    // into an inode with no name.
    expect(await readdir(harness.exportsDir)).toContain('Busy.mp4.video.part');

    const finished = await store.finalizeExport('job-a');
    expect(finished.videoSampleCount).toBe(fixture.frames.length);

    // ...and finalized to a file that is actually good, read back off the disk.
    const movie = parseMovie(new Uint8Array(await readFile(outputPath)));
    expect(movie.fastStart).toBe(true);
    expect(movie.tracks.find((t) => t.handler === 'vide')?.samples).toHaveLength(
      fixture.frames.length,
    );
    expect(await readdir(harness.exportsDir)).toEqual(['Busy.mp4']);
  }, 60_000);

  it('holds the destination for the whole of a finalize, not up to it', async () => {
    // The window `finalize` opens: `<out>.partial` created, the whole mdat copied
    // into it, fsync, `rename(2)` over `<out>`, then both scratch streams unlinked.
    // Tens of seconds on a 4K export, and every path in it derives from `outputPath`.
    // A second job admitted here sweeps the `.partial` away and a complete, correct
    // export fails at its last step — so the claim has to span the call, not stop at
    // it. The two release cases below only ever look at the state *around* finalize,
    // which is why this one is asserted from inside.
    const { store } = harness;
    const outputPath = join(harness.exportsDir, 'Muxing.mp4');

    await store.beginExport('job-a', { outputPath, video: videoSpec() });
    await appendFrames('job-a', 0, fixture.frames.length);

    const finalizing = store.finalizeExport('job-a');
    await drainMicrotasks();

    const refusal: unknown = await store
      .beginExport('job-b', { outputPath, video: videoSpec() })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExportDestinationBusyError);

    // ...and the export that was in the middle of being written is undamaged, which
    // is the half that matters: a refusal that broke the job it was protecting would
    // be worse than the collision.
    const finished = await finalizing;
    expect(finished.videoSampleCount).toBe(fixture.frames.length);
    const movie = parseMovie(new Uint8Array(await readFile(outputPath)));
    expect(movie.fastStart).toBe(true);
    expect(movie.tracks.find((t) => t.handler === 'vide')?.samples).toHaveLength(
      fixture.frames.length,
    );
    expect(await readdir(harness.exportsDir)).toEqual(['Muxing.mp4']);
  }, 60_000);

  it('holds the destination for the whole of a cancel, not up to it', async () => {
    // Same shape, the other release site: `cancel()` is what unlinks the scratch and
    // the `.partial`, so a job admitted before it finishes has its own freshly
    // created scratch removed by this one's cleanup.
    const { store } = harness;
    const outputPath = join(harness.exportsDir, 'Abandoned.mp4');

    await store.beginExport('job-a', { outputPath, video: videoSpec() });
    await appendFrames('job-a', 0, 8);

    const cancelling = store.cancelExport('job-a');
    await drainMicrotasks();

    const refusal: unknown = await store
      .beginExport('job-b', { outputPath, video: videoSpec() })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExportDestinationBusyError);

    await cancelling;
    expect(await readdir(harness.exportsDir)).toEqual([]);
  }, 60_000);

  it('releases the destination when the job that held it is done', async () => {
    // The claim is on the export in flight, not on the name. Without this, a guard
    // that never released would pass the tests above and make every second export of
    // a recording fail for ever.
    const { store } = harness;
    const outputPath = join(harness.exportsDir, 'Again.mp4');

    await store.beginExport('job-a', { outputPath, video: videoSpec() });
    await appendFrames('job-a', 0, 12);
    await store.finalizeExport('job-a');

    await expect(
      store.beginExport('job-b', { outputPath, video: videoSpec() }),
    ).resolves.toBeUndefined();
    await appendFrames('job-b', 0, 12);
    await store.finalizeExport('job-b');
    expect(await readdir(harness.exportsDir)).toEqual(['Again.mp4']);
  }, 60_000);

  it('releases the destination when the job that held it is cancelled', async () => {
    const { store } = harness;
    const outputPath = join(harness.exportsDir, 'Retry.mp4');

    await store.beginExport('job-a', { outputPath, video: videoSpec() });
    await appendFrames('job-a', 0, 8);
    await store.cancelExport('job-a');
    // A cancel leaves nothing — including the claim.
    expect(await readdir(harness.exportsDir)).toEqual([]);

    await expect(
      store.beginExport('job-b', { outputPath, video: videoSpec() }),
    ).resolves.toBeUndefined();
    await store.cancelExport('job-b');
  }, 60_000);

  it('discards only the file the job it names actually renamed into place', async () => {
    // The `rm` that points outside a bundle, at a directory the user chose. It takes a
    // **job id**, not a path, so the only thing it can ever remove is a file that
    // job's own `finalize` put there — read out of the store's own ledger, which the
    // writer's `renamed` flag is what writes. A path argument would have put that
    // guarantee in the caller's hands.
    const { store } = harness;
    const outputPath = join(harness.exportsDir, 'Discarded.mp4');

    // A job that never ran can claim nothing, so an earlier export of the same name
    // is untouched — the case that turns a bug into data loss.
    await store.beginExport('job-earlier', { outputPath, video: videoSpec() });
    await appendFrames('job-earlier', 0, 12);
    await store.finalizeExport('job-earlier');
    store.releaseExport('job-earlier');
    expect(await store.discardExport('a-job-that-never-ran')).toBeNull();
    expect(await readdir(harness.exportsDir)).toEqual(['Discarded.mp4']);

    // A job that *did* rename can, and the path it removes is the one it wrote.
    await store.beginExport('job-b', { outputPath, video: videoSpec() });
    await appendFrames('job-b', 0, 12);
    await store.finalizeExport('job-b');
    expect(await store.discardExport('job-b')).toBe(outputPath);
    expect(await readdir(harness.exportsDir)).toEqual([]);
    // ...and only once: a second discard is not a licence to delete whatever is at
    // that path next.
    expect(await store.discardExport('job-b')).toBeNull();
  }, 60_000);

  it('claims nothing for a job whose finalize failed before the rename', async () => {
    // The case that turns the gate into data loss if it is dropped: a good export
    // already sits at the path, a second job aimed at the same name fails to assemble
    // itself, and its cleanup must not take the first one with it.
    const { store } = harness;
    const outputPath = join(harness.exportsDir, 'Survivor.mp4');

    await store.beginExport('job-good', { outputPath, video: videoSpec() });
    await appendFrames('job-good', 0, 12);
    await store.finalizeExport('job-good');
    store.releaseExport('job-good');
    expect(await readdir(harness.exportsDir)).toEqual(['Survivor.mp4']);

    await store.beginExport('job-bad', { outputPath, video: videoSpec() });
    await appendFrames('job-bad', 0, 12);
    // A *directory* where `<out>.partial` goes: the scratch sweep only ever unlinks
    // files, so the `wx` open that assembles the finished bytes fails and `finalize`
    // throws with the rename never attempted.
    await mkdir(`${outputPath}.partial`, { recursive: true });
    await expect(store.finalizeExport('job-bad')).rejects.toThrow();

    expect(await store.discardExport('job-bad')).toBeNull();
    expect(await readdir(harness.exportsDir)).toContain('Survivor.mp4');
  }, 60_000);

  it('claims nothing for a job that was cancelled before it renamed', async () => {
    const { store } = harness;
    const outputPath = join(harness.exportsDir, 'NeverRenamed.mp4');
    await store.beginExport('job-a', { outputPath, video: videoSpec() });
    await appendFrames('job-a', 0, 8);
    await store.cancelExport('job-a');
    expect(await store.discardExport('job-a')).toBeNull();
  }, 60_000);

  it('leaves an export to a different destination alone', async () => {
    // Control. Without it, "it refuses a second export to the same path" and "it
    // refuses a second export" read identically — and the second reading would make
    // concurrent exports of two recordings impossible.
    const { store } = harness;
    await store.beginExport('job-a', {
      outputPath: join(harness.exportsDir, 'One.mp4'),
      video: videoSpec(),
    });
    await expect(
      store.beginExport('job-b', {
        outputPath: join(harness.exportsDir, 'Two.mp4'),
        video: videoSpec(),
      }),
    ).resolves.toBeUndefined();
    await store.cancelExport('job-a');
    await store.cancelExport('job-b');
  }, 60_000);
});

/**
 * Half the fixture and no `passDone`, so a cancel lands with bytes already in the
 * scratch stream and a pass still outstanding — which is what a cancel *is*.
 */
function encodeLikeTheWindowPartially(jobId: string): void {
  const { session } = harness;
  session.onMeta({
    jobId,
    kind: 'video',
    decoderConfig: {
      codec: 'avc1.640028',
      codedWidth: fixture.width,
      codedHeight: fixture.height,
      description: fixture.avcC,
    },
  });
  for (const [i, frame] of fixture.frames.slice(0, 8).entries()) {
    session.onChunk({
      jobId,
      kind: 'video',
      data: frame.data,
      isKey: frame.isKey,
      timestampUs: Math.round((i * 1e6) / fixture.fps),
    });
  }
}

describe('safeFileName', () => {
  it('makes a person’s name into a file name without rejecting it', () => {
    expect(safeFileName('Q3 / demo')).toBe('Q3 demo');
    expect(safeFileName('a:b*c?d"e<f>g|h')).toBe('a b c d e f g h');
    expect(safeFileName('  .hidden  ')).toBe('hidden');
    expect(safeFileName('')).toBe('Recording');
    expect(safeFileName('   ')).toBe('Recording');
    // A name that is only separators still produces a file, not an empty path.
    expect(safeFileName('///')).toBe('Recording');
    // And a name shaped like a path is a single segment, not a traversal: this is
    // what lets `name` stay a renderer-supplied override when `outputDir` cannot.
    expect(safeFileName('../../../etc/passwd')).toBe('.. .. etc passwd');
    expect(safeFileName('/etc/passwd')).toBe('etc passwd');
    expect(safeFileName('..')).toBe('Recording');
    for (const name of ['../../x', '/abs/x', 'a\\b', 'a:b']) {
      expect(safeFileName(name)).not.toMatch(/[/\\:\0]/);
    }
    expect(safeFileName('x'.repeat(400))).toHaveLength(120);
  });

  it('leaves the characters a person actually uses alone', () => {
    expect(safeFileName('Sprint 12 — retro (final)')).toBe('Sprint 12 — retro (final)');
    expect(safeFileName('café ☕')).toBe('café ☕');
  });
});
