/**
 * The capture lifecycle through `ProjectStore`, and the documents it writes.
 *
 * Architecture report §2.2 draws the state machine:
 *
 * ```
 * recording ──stop──► finalizing ──► editable
 *     │                   │
 *     └─crash─────────────┴──► needs-recovery ──recover──► editable
 *                          └──► failed { error }
 * ```
 *
 * Every edge in that diagram is exercised here. The `RecorderSession` above it owns
 * windows and TCC and cannot run outside Electron; the part that decides what ends
 * up on the user's disk is this, and it is plain Node on purpose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateFrameIndexDoc,
  validateProjectDoc,
  validateRecordingDoc,
  type FrameIndexDoc,
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import { ProjectStore } from '../src/project-store.ts';
import { finalizedRecordingDoc, provisionalRecordingDoc } from '../src/recorder/recording-doc.ts';
import { loadEncodedFixture } from '../../../packages/mux/test/helpers/fixture.ts';

const fixture = loadEncodedFixture();

let scratch: string;
let store: ProjectStore;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'loom-capture-lifecycle-'));
  store = new ProjectStore({
    recordingsRoot: join(scratch, 'recordings'),
    settingsPath: join(scratch, 'settings.json'),
    appVersion: '0.1.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
});

afterEach(async () => {
  await store.closeAll().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
});

function provisional(store: ProjectStore): RecordingDoc {
  const file = store.mediaRelativePath('screen', 0);
  return provisionalRecordingDoc({
    display: {
      id: 1,
      name: 'Built-in Liquid Retina XDR',
      logicalSize: [1728, 1117],
      pixelSize: [3456, 2234],
      scaleFactor: 2,
      colorSpace: 'display-p3',
    },
    file,
    index: file.replace(/\.mp4$/, '.index.json'),
    codec: 'avc1.64000d',
    size: [fixture.width, fixture.height],
    requestedFps: fixture.fps,
    capture: {
      app: '0.1.0-test',
      os: '26.5.1',
      permissions: {
        screen: 'granted',
        camera: 'not-determined',
        microphone: 'not-determined',
        accessibility: false,
      },
      resolutionClamp: '3840px',
    },
  });
}

/** Start a recording and write `frames` frames into it. */
async function startRecording(frames: number): Promise<RecordingId> {
  const { id } = await store.create('Untitled');
  await store.openProject(id);
  await store.setState(id, 'recording');
  await store.writeRecordingDoc(id, provisional(store));
  await store.beginMediaPart(id, {
    track: 'screen',
    part: 0,
    width: fixture.width,
    height: fixture.height,
    avcC: fixture.avcC,
    nominalFps: fixture.fps,
    colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
  });
  for (const frame of fixture.frames.slice(0, frames)) {
    await store.appendMediaChunk(id, 'screen', {
      data: frame.data,
      isKey: frame.isKey,
      timestampUs: frame.timestampUs,
      durationUs: null,
    });
  }
  return id;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Every index entry lands on a run of AVCC NAL units that tiles its declared size.
 *
 * Phase 6 seeks with these offsets and decodes forward without parsing a sample
 * table (§2.4), so a sidecar that merely validates is not enough — and this is the
 * *clean stop* sidecar, which is the one a recording that never crashed is read
 * with. Crash recovery rebuilds the index from the file and so cannot catch a
 * writer that computes offsets wrongly; this can.
 */
async function assertIndexDescribes(media: string, index: FrameIndexDoc): Promise<void> {
  const bytes = await readFile(media);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(index.pts.length).toBe(index.sizes.length);
  expect(index.pts.length).toBe(index.offsets.length);
  for (let i = 0; i < index.pts.length; i++) {
    const offset = index.offsets[i] ?? -1;
    const size = index.sizes[i] ?? -1;
    expect(offset).toBeGreaterThan(0);
    expect(offset + size).toBeLessThanOrEqual(bytes.byteLength);
    let at = offset;
    while (at < offset + size) {
      const nal = view.getUint32(at, false);
      expect(nal, `frame ${String(i)} has a zero-length NAL at ${String(at)}`).toBeGreaterThan(0);
      at += 4 + nal;
    }
    expect(at, `frame ${String(i)}'s NAL units do not tile its declared size`).toBe(offset + size);
  }
}

describe('the documents capture writes', () => {
  it('writes a valid provisional recording.json before the first frame', () => {
    const doc = provisional(store);
    const result = validateRecordingDoc(doc);
    expect(result.ok ? null : result.issues).toBeNull();

    // The facts only a live session knows, present from the start; the numbers
    // only the capture can know, still zero.
    expect(doc.display.scaleFactor).toBe(2);
    expect(doc.clock).toEqual({ kind: 'videoframe-timestamp-us', t0Us: 0 });
    expect(doc.tracks.screen?.parts[0]?.rate.mode).toBe('variable');
    expect(doc.tracks.screen?.parts[0]?.frameCount).toBe(0);
    expect(doc.integrity.finalizedAt).toBeNull();
  });

  it('fills in the real numbers at finalize without touching the rest', () => {
    const doc = finalizedRecordingDoc(
      provisional(store),
      { durationSec: 10, frameCount: 300, observedFps: 30, endedEarly: false },
      2,
      '2026-08-05T00:00:00.000Z',
    );
    const result = validateRecordingDoc(doc);
    expect(result.ok ? null : result.issues).toBeNull();

    const part = doc.tracks.screen?.parts[0];
    expect(part?.frameCount).toBe(300);
    expect(part?.durationSec).toBe(10);
    expect(part?.rate.observedFps).toBe(30);
    expect(part?.endedEarly).toBe(false);
    expect(doc.capture.droppedFrames).toEqual({ screen: 2 });
    expect(doc.integrity.finalizedAt).toBe('2026-08-05T00:00:00.000Z');
    expect(doc.display).toEqual(provisional(store).display);
  });

  it('records an early end with its reason', () => {
    const doc = finalizedRecordingDoc(
      provisional(store),
      {
        durationSec: 4,
        frameCount: 120,
        observedFps: 30,
        endedEarly: true,
        endReason: 'permission-revoked',
      },
      0,
      '2026-08-05T00:00:00.000Z',
    );
    expect(doc.tracks.screen?.parts[0]?.endReason).toBe('permission-revoked');
  });
});

describe('a recording that stops cleanly', () => {
  it('walks recording -> finalizing -> editable and leaves every document valid', async () => {
    const id = await startRecording(120);

    let project = (await readJson(join(await store.directoryFor(id), 'project.json'))) as {
      state: string;
    };
    expect(project.state).toBe('recording');

    await store.setState(id, 'finalizing');
    const part = await store.finalizeMediaPart(id, 'screen');
    expect(part.frameCount).toBe(120);
    expect(part.keyframeCount).toBe(4);
    expect(part.durationSec).toBeCloseTo(4, 1);

    await store.writeRecordingDoc(
      id,
      finalizedRecordingDoc(
        provisional(store),
        {
          durationSec: part.durationSec,
          frameCount: part.frameCount,
          observedFps: part.observedFps,
          endedEarly: false,
        },
        0,
        new Date().toISOString(),
      ),
    );
    await store.setState(id, 'editable');
    await store.close(id);

    const dir = await store.directoryFor(id);
    project = (await readJson(join(dir, 'project.json'))) as { state: string };
    expect(project.state).toBe('editable');
    expect(validateProjectDoc(project).ok).toBe(true);
    expect(validateRecordingDoc(await readJson(join(dir, 'recording.json'))).ok).toBe(true);
    const indexResult = validateFrameIndexDoc(
      await readJson(join(dir, 'media/screen.000.index.json')),
    );
    expect(indexResult.ok ? null : indexResult.issues).toBeNull();
    expect((await stat(join(dir, 'media/screen.000.mp4'))).size).toBeGreaterThan(0);
    if (indexResult.ok) {
      expect(indexResult.value.pts.length).toBe(120);
      await assertIndexDescribes(join(dir, 'media/screen.000.mp4'), indexResult.value);
    }

    // And the recording is a normal library entry, not a special case.
    const summary = (await store.list()).find((s) => s.id === id);
    expect(summary?.state).toBe('editable');
    expect(summary?.durationSec).toBeCloseTo(part.durationSec, 6);
  });

  it('refuses a second part on a track that already has one open', async () => {
    const id = await startRecording(2);
    await expect(
      store.beginMediaPart(id, {
        track: 'screen',
        part: 1,
        width: fixture.width,
        height: fixture.height,
        avcC: fixture.avcC,
        nominalFps: fixture.fps,
      }),
    ).rejects.toThrow(/already has an open part/);
  });

  it('closing the project releases the part rather than leaving a file descriptor in it', async () => {
    const id = await startRecording(10);
    await store.close(id);
    await expect(
      store.appendMediaChunk(id, 'screen', {
        data: new Uint8Array(4),
        isKey: false,
        timestampUs: 0,
        durationUs: null,
      }),
    ).rejects.toThrow(/no open part/);
    // The bytes it had are still there, and still recoverable.
    const dir = await store.directoryFor(id);
    expect((await stat(join(dir, 'media/screen.000.mp4'))).size).toBeGreaterThan(0);
  });
});

describe('a recording that crashed', () => {
  it('is found by state alone, before anything reads its media', async () => {
    const id = await startRecording(30);
    // The bundle is closed without ever reaching `finalizing`, which is what a
    // process that went away mid-capture leaves behind. A real `SIGKILL` is
    // `apps/main/test/capture-crash.test.ts`; this is the same state, reached
    // deliberately.
    await store.close(id);

    const crashed = await store.listCrashed();
    expect(crashed.map((s) => s.id)).toEqual([id]);
  });

  it('recovers to editable and says how much came back', async () => {
    const id = await startRecording(60);
    await store.close(id);

    const report = await store.recoverBundle(id);
    expect(report.recovered).toBe(true);
    // `close` aborts the open part rather than abandoning it, so the sample the
    // writer was holding does reach the file. A `SIGKILL` gets no such chance,
    // and the crash gate measures that case.
    expect(report.frameCount).toBe(60);
    expect(report.recoveredSec).toBeCloseTo(60 / fixture.fps, 2);

    const dir = await store.directoryFor(id);
    const recording = (await readJson(join(dir, 'recording.json'))) as RecordingDoc;
    expect(validateRecordingDoc(recording).ok).toBe(true);
    expect(recording.integrity.recoveredFromCrash).toBe(true);
    expect(recording.integrity.truncatedToSec).toBeCloseTo(report.recoveredSec, 6);
    expect(recording.tracks.screen?.parts[0]?.endReason).toBe('crash');
    expect((await store.list()).find((s) => s.id === id)?.state).toBe('editable');
  });

  it('marks a bundle that never captured a frame failed, and still lists it', async () => {
    const { id } = await store.create('Untitled');
    await store.openProject(id);
    await store.setState(id, 'recording');
    await store.close(id);

    const report = await store.recoverBundle(id);
    expect(report.recovered).toBe(false);
    expect(report.error).toMatch(/before it captured a frame/);

    const summary = (await store.list()).find((s) => s.id === id);
    expect(summary?.state).toBe('failed');
    // Listed, openable, revealable — never a directory the app pretends is not
    // there (`decision-journal-damage-recovery`).
    expect(summary?.unreadable).toBeUndefined();
  });

  it('survives a media file that vanished between recording.json and the first frame', async () => {
    const id = await startRecording(20);
    await store.close(id);
    const dir = await store.directoryFor(id);
    await rm(join(dir, 'media/screen.000.mp4'));

    const report = await store.recoverBundle(id);
    expect(report.recovered).toBe(false);
    expect(report.error).toMatch(/no complete frame/);
    expect((await store.list()).find((s) => s.id === id)?.state).toBe('failed');
  });

  it('discards a torn trailing fragment instead of welding the next write to it', async () => {
    const id = await startRecording(40);
    await store.close(id);
    const dir = await store.directoryFor(id);
    const media = join(dir, 'media/screen.000.mp4');
    const bytes = await readFile(media);
    // Cut mid-fragment, the way a process death during a large frame would.
    await writeFile(media, bytes.subarray(0, bytes.byteLength - 200));

    const report = await store.recoverBundle(id);
    expect(report.recovered).toBe(true);
    expect(report.truncatedBytes).toBeGreaterThan(0);
    expect((await stat(media)).size).toBe(bytes.byteLength - 200 - report.truncatedBytes);
  });
});
