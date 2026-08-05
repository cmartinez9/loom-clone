/**
 * **Phase 1 gate: `SIGKILL` mid-recording recovers ≥ 95% of frames and a playable
 * file.** Architecture report §8, row 1.
 *
 * Everything this phase exists for is in this file. Captain decision 5 deletes the
 * user's only copy of their footage after a verified export, so a recording that
 * cannot be recovered is permanently gone — which is why the gate is a number and
 * not an opinion.
 *
 * ## What makes this a proof rather than a hope
 *
 * 1. **The production path is what dies.** `helpers/capture-child.ts` builds the
 *    real `ProjectStore`, the real `MediaPartWriter` and the real `FragmentWriter`
 *    from source on every run, feeds them real H.264 from the committed fixture,
 *    and is killed mid-stream. Phase 0's gate originally killed a *copy* of the
 *    atomic writer, so a regression in the real one would have left it green; that
 *    mistake is not repeated. `scripts/mutation-check.mjs` proves the point the
 *    other way round, by breaking the production writer on disk and requiring this
 *    file to fail.
 * 2. **The denominator is durable.** The child appends each frame index to a log
 *    with a synchronous `write(2)` *before* handing the frame to the writer, so
 *    the count survives the kill and is, if anything, an over-count. 95% is
 *    measured against what the writer was actually given.
 * 3. **There is a control.** The same harness runs a child that buffers samples
 *    and flushes at the end — the configuration §12.2 measured at *zero* recovered
 *    frames. If the control ever passes the gate, the harness is not catching the
 *    writer mid-recording and the assertions above prove nothing.
 * 4. **Playable is checked by something that is not us.** `/usr/bin/avconvert` is
 *    AVFoundation, ships with macOS, and is the same decoder QuickTime uses. Our
 *    own scanner agreeing with our own writer would prove only that they agree.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFrameIndexDoc, validateProjectDoc, validateRecordingDoc } from '@loom/format';
import { fixturePath } from '../../../packages/mux/test/helpers/fixture.ts';
import type { FrameIndexDoc, ProjectDoc, RecordingDoc } from '@loom/format';
import { ProjectStore } from '../src/project-store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD_SOURCE = join(here, 'helpers/capture-child.ts');
const AVCONVERT = '/usr/bin/avconvert';

/** The gate, per architecture report §8. Not a target — a floor. */
const RECOVERY_FLOOR = 0.95;

/**
 * Frames the writer must have been handed before killing it measures anything.
 *
 * A `SIGKILL` costs a small and *constant* number of frames, not a proportion: the
 * writer holds exactly one sample so it can measure each frame's duration against the
 * next one's timestamp, and the child has at most one append in flight behind it, so
 * one or two frames go and never more — one in most of the runs behind this comment
 * and two in the rest, whatever the recording's length.
 *
 * So the 95% floor is a statement about the writer only while the denominator is large
 * enough for that constant to fit under 5%. This harness used to kill purely on the
 * clock and settle for whatever the child had managed by then, which is fine at the
 * ~80 frames it feeds in 400 ms with the machine to itself and not fine at the ~36 it
 * manages when the rest of the suite is running: two frames out of 36 is 5.6%, and the
 * gate fails on arithmetic rather than on anything the writer did.
 *
 * 60 leaves a real margin — two frames is 3.3% — and is still early in a stream fed at
 * 250 fps. The kill therefore waits for the stream as well as for the clock, which on
 * an unloaded machine changes nothing at all.
 */
const MIN_HANDED_FRAMES = 60;

/** How long to wait for {@link MIN_HANDED_FRAMES}. Generous; a bound, not a schedule. */
const HANDED_TIMEOUT_MS = 20_000;

const scratch = await mkdtemp(join(tmpdir(), 'loom-capture-gate-'));
const childBundle = join(scratch, 'capture-child.cjs');

/**
 * Bundle the child from source, exactly as `scripts/build.mjs` bundles main.
 *
 * From *source*, on every run, so that a change to the production writer — or a
 * deliberate mutation of it — is what gets killed. A pre-built artifact would let
 * the gate pass against yesterday's code.
 */
await build({
  entryPoints: [CHILD_SOURCE],
  outfile: childBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'silent',
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Killed {
  /** Frames the child handed to the writer before it died. */
  handed: number;
  recordingId: string;
  root: string;
  settingsPath: string;
  /** True if the child died from our signal rather than finishing or crashing. */
  killedBySignal: boolean;
}

/** Run one recording, kill it after `killAfterMs`, and report what it had fed. */
async function recordAndKill(mode: 'real' | 'buffered', killAfterMs: number): Promise<Killed> {
  const root = await mkdtemp(join(scratch, 'root-'));
  const settingsPath = join(root, 'settings.json');
  const progressPath = join(root, 'progress.log');
  const idFilePath = join(root, 'recording-id.txt');

  const child = spawn(
    process.execPath,
    [
      childBundle,
      '--root',
      join(root, 'recordings'),
      '--settings',
      settingsPath,
      '--progress',
      progressPath,
      '--id-file',
      idFilePath,
      '--fixture',
      fixturePath(),
      '--mode',
      mode,
      '--interval-ms',
      '4',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));

  try {
    await waitForOutput(child, 'ready', stderr);
    await delay(killAfterMs);
    // ...and far enough into the stream for the floor to mean something. On an idle
    // machine this has already happened and returns at once; see MIN_HANDED_FRAMES.
    await untilHanded(progressPath, MIN_HANDED_FRAMES, HANDED_TIMEOUT_MS);
    child.kill('SIGKILL');
    const exit = await onceExit(child);

    const handed = await handedCount(progressPath);
    const recordingId = (await readFile(idFilePath, 'utf8')).trim();
    return {
      handed,
      recordingId,
      root: join(root, 'recordings'),
      settingsPath,
      killedBySignal: exit.signal === 'SIGKILL',
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

/** Run the production recovery pass over the crashed bundle. */
async function recover(killed: Killed): Promise<{
  report: Awaited<ReturnType<ProjectStore['recoverBundle']>>;
  bundleDir: string;
  project: ProjectDoc;
  recording: RecordingDoc;
  index: FrameIndexDoc;
}> {
  const store = new ProjectStore({
    recordingsRoot: killed.root,
    settingsPath: killed.settingsPath,
    appVersion: '0.1.0-crash-gate',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();

  const crashed = await store.listCrashed();
  expect(
    crashed.map((s) => s.id),
    'a bundle killed mid-recording must still say state: "recording"',
  ).toContain(killed.recordingId);

  const report = await store.recoverBundle(killed.recordingId);
  const bundleDir = await store.directoryFor(killed.recordingId);

  const project = parse(
    validateProjectDoc,
    await readFile(join(bundleDir, 'project.json'), 'utf8'),
  );
  const recording = parse(
    validateRecordingDoc,
    await readFile(join(bundleDir, 'recording.json'), 'utf8'),
  );
  const part = recording.tracks.screen?.parts[0];
  expect(part, 'the recovered recording must describe its screen part').toBeDefined();
  const index = parse(
    validateFrameIndexDoc,
    await readFile(join(bundleDir, part?.index ?? ''), 'utf8'),
  );
  return { report, bundleDir, project, recording, index };
}

function parse<T>(
  validator: (input: unknown) => { ok: true; value: T } | { ok: false; issues: unknown[] },
  text: string,
): T {
  const result = validator(JSON.parse(text));
  if (!result.ok) throw new Error(`document is invalid: ${JSON.stringify(result.issues)}`);
  return result.value;
}

/**
 * Prove the file plays, using AVFoundation rather than our own reader.
 *
 * `PresetPassthrough` remuxes without re-encoding, so it exercises the demuxer and
 * every sample table without spending a decode. A file AVFoundation refuses is a
 * file QuickTime refuses, which is the user-facing meaning of "playable".
 */
function playsUnderAVFoundation(mediaPath: string, outPath: string): { ok: boolean; log: string } {
  const result = spawnSync(
    AVCONVERT,
    ['--source', mediaPath, '--output', outPath, '--preset', 'PresetPassthrough'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return {
    ok: result.status === 0,
    log: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/** Frame count from ffmpeg, when the machine happens to have it. Not required. */
function ffprobeFrameCount(mediaPath: string): number | null {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'default=nw=1:nk=1',
      mediaPath,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (result.error !== undefined || result.status !== 0) return null;
  const count = Number.parseInt((result.stdout ?? '').trim(), 10);
  return Number.isInteger(count) ? count : null;
}

/**
 * Check the sidecar actually describes the file.
 *
 * Phase 6 seeks with these offsets and decodes forward without parsing a sample
 * table (§2.4), so an index that is merely well-formed is not enough — every entry
 * has to land on a sample whose AVCC length prefixes tile it exactly.
 */
async function assertIndexPointsAtFrames(mediaPath: string, index: FrameIndexDoc): Promise<void> {
  const bytes = await readFile(mediaPath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const probes = [0, 1, Math.floor(index.pts.length / 2), index.pts.length - 1].filter(
    (i) => i >= 0 && i < index.pts.length,
  );
  for (const i of probes) {
    const offset = index.offsets[i] ?? -1;
    const size = index.sizes[i] ?? -1;
    expect(offset, `index entry ${String(i)} has no offset`).toBeGreaterThan(0);
    expect(offset + size, `index entry ${String(i)} runs past the file`).toBeLessThanOrEqual(
      bytes.byteLength,
    );
    let at = offset;
    while (at < offset + size) {
      const nalLength = view.getUint32(at, false);
      expect(
        nalLength,
        `frame ${String(i)} has a zero-length NAL at ${String(at)}`,
      ).toBeGreaterThan(0);
      at += 4 + nalLength;
    }
    expect(at, `frame ${String(i)}'s NAL units do not tile its declared size`).toBe(offset + size);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Frames the child has handed the writer, read from the log it appends to with a
 * synchronous `write(2)` *before* each append. Readable while the child is alive for
 * exactly the reason it is trustworthy after the child is dead: the kernel has it.
 */
async function handedCount(progressPath: string): Promise<number> {
  return (await readFile(progressPath, 'utf8')).split('\n').filter(Boolean).length;
}

/** Wait until the child has handed over `count` frames. Bounded, and never throws. */
async function untilHanded(progressPath: string, count: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while ((await handedCount(progressPath)) < count) {
    // Returning on the bound rather than throwing leaves the precondition assertion in
    // the test to say what went wrong, with the number it actually reached.
    if (Date.now() - startedAt >= timeoutMs) return;
    await delay(5);
  }
}

function onceExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function waitForOutput(
  child: ReturnType<typeof spawn>,
  marker: string,
  stderr: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`the child never emitted ${marker}; stderr: ${stderr.join('')}`));
    }, 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`the child exited before ${marker}; stderr: ${stderr.join('')}`));
    });
  });
}

// ---------------------------------------------------------------------------

describe('SIGKILL mid-recording', () => {
  // Three kills at different points in the stream, so the result is not an
  // artefact of one lucky instant.
  for (const killAfterMs of [400, 650, 900]) {
    it(`recovers at least 95% of frames after a kill at ${String(killAfterMs)}ms`, async () => {
      const killed = await recordAndKill('real', killAfterMs);
      expect(killed.killedBySignal, 'the child must die from SIGKILL, not finish').toBe(true);
      expect(
        killed.handed,
        'the harness must catch the child mid-recording, with enough frames behind it ' +
          'for the floor below to be a measurement',
      ).toBeGreaterThanOrEqual(MIN_HANDED_FRAMES);

      const { report, bundleDir, project, recording, index } = await recover(killed);

      // Printed, not just asserted: the margin above the floor is the number that
      // tells a future reader whether a change made recovery worse.
      console.log(
        `[gate] kill@${String(killAfterMs)}ms: recovered ${String(report.frameCount)}/` +
          `${String(killed.handed)} frames ` +
          `(${((report.frameCount / killed.handed) * 100).toFixed(1)}%), ` +
          `${report.recoveredSec.toFixed(3)}s, ` +
          `${String(report.truncatedBytes)} bytes of torn tail discarded`,
      );

      expect(report.recovered, `recovery failed: ${report.error ?? ''}`).toBe(true);
      expect(
        report.frameCount / killed.handed,
        `recovered ${String(report.frameCount)} of ${String(killed.handed)} frames handed to ` +
          `the writer, which is below the ${String(RECOVERY_FLOOR * 100)}% gate`,
      ).toBeGreaterThanOrEqual(RECOVERY_FLOOR);

      // The bundle opens as an ordinary recording, and says it was repaired.
      expect(project.state).toBe('editable');
      expect(recording.integrity.recoveredFromCrash).toBe(true);
      expect(recording.integrity.truncatedToSec).toBeCloseTo(report.recoveredSec, 6);
      const part = recording.tracks.screen?.parts[0];
      expect(part?.frameCount).toBe(report.frameCount);
      expect(part?.endedEarly).toBe(true);
      expect(part?.endReason).toBe('crash');

      // The sidecar describes the file, entry by entry.
      expect(index.pts.length).toBe(report.frameCount);
      expect(index.keyframes.length).toBeGreaterThan(0);
      expect(index.keyframes[0]).toBe(0);
      const mediaPath = join(bundleDir, part?.file ?? '');
      await assertIndexPointsAtFrames(mediaPath, index);

      // And it plays.
      const played = playsUnderAVFoundation(mediaPath, join(bundleDir, 'probe.mov'));
      expect(played.ok, `AVFoundation could not read the recovered file: ${played.log}`).toBe(true);
      expect((await stat(join(bundleDir, 'probe.mov'))).size).toBeGreaterThan(0);

      // ffmpeg, when the machine has it, decodes every frame the index claims.
      const decoded = ffprobeFrameCount(mediaPath);
      if (decoded !== null) expect(decoded).toBe(report.frameCount);
    });
  }

  it('CONTROL: the same harness recovers nothing from a writer that buffers', async () => {
    const killed = await recordAndKill('buffered', 650);
    expect(killed.killedBySignal).toBe(true);
    expect(killed.handed).toBeGreaterThanOrEqual(MIN_HANDED_FRAMES);

    const store = new ProjectStore({
      recordingsRoot: killed.root,
      settingsPath: killed.settingsPath,
      appVersion: '0.1.0-crash-gate',
      trash: () => Promise.resolve(),
    });
    await store.loadSettings();
    const report = await store.recoverBundle(killed.recordingId);

    // This is the failure the architecture report measured (§12.2) and the reason
    // fragments are written as they are produced. If it ever stops failing, the
    // gate above is passing for the wrong reason.
    expect(
      report.frameCount / killed.handed,
      'a writer that buffers its fragments survived a SIGKILL, so this harness is ' +
        'not actually interrupting the write path and the gate proves nothing',
    ).toBeLessThan(RECOVERY_FLOOR);
    expect(report.recovered).toBe(false);
    expect(report.error).toBeTruthy();

    // Even then: the bundle opens. It is marked failed, with a reason, and is
    // still in the library — never a directory the app refuses to acknowledge
    // (`decision-journal-damage-recovery`).
    const summaries = await store.list();
    const summary = summaries.find((s) => s.id === killed.recordingId);
    expect(summary?.state).toBe('failed');
    expect(summary?.unreadable).toBeUndefined();
  });
});
