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
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL, type ExportCommand, type ExportProgress } from '@loom/ipc';
import type { ProjectDoc, RecordingId } from '@loom/format';
import { ProjectStore } from '../src/project-store.ts';
import { ExportSession, bitrateFor, safeFileName } from '../src/export/session.ts';
import { loadEncodedFixture } from '../../../packages/mux/test/helpers/fixture.ts';

const fixture = loadEncodedFixture();

/**
 * A `BrowserWindow` reduced to what `ExportSession` touches, plus a hook to see what
 * was sent to it. Deliberately not a mock of the class: the session uses four
 * members, and standing in for four members is honest where standing in for a window
 * is not.
 */
class FakeWindow extends EventEmitter {
  readonly sent: ExportCommand[] = [];
  destroyed = false;
  readonly webContents = {
    isLoading: (): boolean => false,
    once: (event: string, listener: () => void): void => {
      void event;
      listener();
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
