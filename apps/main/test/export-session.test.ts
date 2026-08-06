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
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL, type ExportCommand, type ExportProgress } from '@loom/ipc';
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
import { ExportDestinationBusyError, ProjectStore } from '../src/project-store.ts';
import { ExportSession, bitrateFor, safeFileName } from '../src/export/session.ts';
import { loadEncodedFixture } from '../../../packages/mux/test/helpers/fixture.ts';

const fixture = loadEncodedFixture();

/** AAC-LC, 48 kHz, stereo — the two bytes an `AudioSpecificConfig` is. */
const AUDIO_SPECIFIC_CONFIG = new Uint8Array([0x11, 0x90]);
const AUDIO_RATE = 48_000;
const AAC_FRAME = 1024;

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

  const window = new FakeWindow();
  const progress: ExportProgress[] = [];
  const clipboard: string[] = [];
  const revealed: string[] = [];
  const session = new ExportSession({
    store,
    openWindow: () => window as unknown as Electron.BrowserWindow,
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
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId);
    });

    const { jobId } = await harness.session.start(harness.recordingId, { name: 'Demo' });
    const outcome = await settled();

    expect(outcome.phase).toBe('done');
    const result = outcome.result;
    expect(result).toBeDefined();
    if (result === undefined) return;

    // Captain decision 9's whole contract, and each third of it separately.
    expect(result.path).toBe(join(harness.exportsDir, 'Demo.mp4'));
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
    // Phase 8 deletes nothing: the state is untouched and there is no retention record.
    expect(doc.state).not.toBe('exported');
    expect(doc.retention).toBeUndefined();

    // Progress reached the end monotonically rather than jumping there.
    expect(harness.progress.map((p) => p.phase)).toContain('verifying');
    expect(outcome.completed).toBe(1);
  }, 60_000);

  it('records `sourcesKept` when the escape hatch is used', async () => {
    answerVerification();
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId);
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
      if (command.kind === 'start') encodeLikeTheWindow(command.job.jobId);
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
    const audioFrames = Math.ceil((durationSec * AUDIO_RATE) / AAC_FRAME);

    answerVerification();
    let passes: { audio: boolean; video: boolean } | null = null;
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      passes = command.job.passes;
      encodeAudioLikeTheWindow(command.job.jobId, audioFrames);
      encodeLikeTheWindow(command.job.jobId);
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
      encodeLikeTheWindow(command.job.jobId);
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

  it('reports the failure from the window rather than hanging on it', async () => {
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind !== 'start') return;
      harness.session.onFailed({
        jobId: command.job.jobId,
        message: 'no VideoEncoder configuration supports 1920x1080 H.264 on this machine',
      });
    });
    await harness.session.start(harness.recordingId, { name: 'NoEncoder' });
    const outcome = await settled();
    expect(outcome.phase).toBe('failed');
    expect(outcome.error).toMatch(/no VideoEncoder configuration/);
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
    expect(safeFileName('x'.repeat(400))).toHaveLength(120);
  });

  it('leaves the characters a person actually uses alone', () => {
    expect(safeFileName('Sprint 12 — retro (final)')).toBe('Sprint 12 — retro (final)');
    expect(safeFileName('café ☕')).toBe('café ☕');
  });
});
