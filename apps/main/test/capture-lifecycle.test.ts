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
import { AAC_ENCODER_DELAY_SAMPLES } from '@loom/mux';
import { ProjectStore } from '../src/project-store.ts';
import {
  finalizedRecordingDoc,
  provisionalRecordingDoc,
  withAudioTrack,
  withClosedVideoPart,
  withVideoPart,
} from '../src/recorder/recording-doc.ts';
import { loadEncodedFixture } from '../../../packages/mux/test/helpers/fixture.ts';

const fixture = loadEncodedFixture();

/** An AAC-LC 48 kHz stereo AudioSpecificConfig, which is all the writer needs. */
const AUDIO_ASC = new Uint8Array([0x11, 0x90]);
const AUDIO_RATE = 48000;
const AAC_FRAME_SAMPLES = 1024;

const MIC_FACTS = {
  deviceId: 'device-1',
  deviceName: 'MacBook Pro Microphone',
  source: 'getusermedia',
  settings: {
    sampleRate: AUDIO_RATE,
    channelCount: 2,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  violations: [],
};

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
  return withVideoPart(
    provisionalRecordingDoc({
      display: {
        id: 1,
        name: 'Built-in Liquid Retina XDR',
        logicalSize: [1728, 1117],
        pixelSize: [3456, 2234],
        scaleFactor: 2,
        colorSpace: 'display-p3',
      },
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
    }),
    {
      track: 'screen',
      file,
      index: file.replace(/\.mp4$/, '.index.json'),
      codec: 'avc1.64000d',
      size: [fixture.width, fixture.height],
      requestedFps: fixture.fps,
      rateMode: 'variable',
      startTimeSec: 0,
    },
  );
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
      {
        video: {
          screen: {
            droppedFrames: 2,
            parts: [
              {
                part: 0,
                startTimeSec: 0,
                durationSec: 10,
                frameCount: 300,
                observedFps: 30,
                endedEarly: false,
              },
            ],
          },
        },
      },
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
        video: {
          screen: {
            droppedFrames: 0,
            parts: [
              {
                part: 0,
                startTimeSec: 0,
                durationSec: 4,
                frameCount: 120,
                observedFps: 30,
                endedEarly: true,
                endReason: 'permission-revoked',
              },
            ],
          },
        },
      },
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
          video: {
            screen: {
              droppedFrames: 0,
              parts: [
                {
                  part: 0,
                  startTimeSec: 0,
                  durationSec: part.durationSec,
                  frameCount: part.frameCount,
                  observedFps: part.observedFps,
                  endedEarly: false,
                },
              ],
            },
          },
        },
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

  it('is still found when its own recovery pass was interrupted', async () => {
    const id = await startRecording(30);
    await store.close(id);
    // `recoverBundle` writes `needs-recovery` before it repairs anything, so a
    // launch that died in the middle of one — or a repair that failed on I/O —
    // leaves exactly this. Excluding it here would mean nothing ever tried again,
    // and the library would offer to repair on open something no code repairs.
    await store.openProject(id);
    await store.setState(id, 'needs-recovery');
    await store.close(id);

    expect((await store.listCrashed()).map((s) => s.id)).toEqual([id]);
    const report = await store.recoverBundle(id);
    expect(report.recovered).toBe(true);
    expect(report.frameCount).toBe(30);
    expect((await store.list()).find((s) => s.id === id)?.state).toBe('editable');
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

  /**
   * §7.4, met by §7.1: the camera is unplugged two seconds into a six second
   * recording and never comes back, then the process is killed.
   *
   * The webcam track ends at two seconds **on purpose** — `capture.partEnded` closed
   * it and `recording.json` says why — so it is not a short track. Cutting the
   * recording back to it would report two seconds recovered for a bundle holding six
   * seconds of screen and audio, and mark four seconds of the user's footage
   * truncated. Raw sources are deleted after export by captain decision, so a
   * recovery that describes what is there as less than it is is not a cosmetic bug.
   */
  it('does not truncate the recording to a camera that was unplugged on purpose', async () => {
    const id = await startRecording(0);
    const screenFrames = fixture.frames.slice(0, 180);
    const webcamFrames = fixture.frames.slice(0, 60);
    const webcamFile = store.mediaRelativePath('webcam', 0);
    const micFile = store.mediaRelativePath('mic', 0);

    let doc = withAudioTrack(
      withVideoPart(provisional(store), {
        track: 'webcam',
        file: webcamFile,
        index: webcamFile.replace(/\.mp4$/, '.index.json'),
        codec: 'avc1.64000d',
        size: [fixture.width, fixture.height],
        requestedFps: fixture.fps,
        rateMode: 'constant',
        startTimeSec: 0,
        facts: { deviceId: 'camera-1', deviceName: 'FaceTime HD Camera' },
      }),
      {
        track: 'mic',
        file: micFile,
        codec: 'mp4a.40.2',
        sampleRate: AUDIO_RATE,
        channels: 2,
        facts: MIC_FACTS,
      },
    );
    await store.writeRecordingDoc(id, doc);
    await store.beginMediaPart(id, {
      track: 'webcam',
      part: 0,
      width: fixture.width,
      height: fixture.height,
      avcC: fixture.avcC,
      nominalFps: fixture.fps,
    });
    await store.beginAudioPart(id, {
      track: 'mic',
      part: 0,
      sampleRate: AUDIO_RATE,
      channels: 2,
      audioSpecificConfig: AUDIO_ASC,
    });

    // Two seconds of camera, then the cable moves: the part is finalized mid
    // recording and the close is written into `recording.json`, exactly as
    // `RecorderSession.onPartEnded` does it.
    for (const frame of webcamFrames) {
      await store.appendMediaChunk(id, 'webcam', {
        data: frame.data,
        isKey: frame.isKey,
        timestampUs: frame.timestampUs,
        durationUs: null,
      });
    }
    const webcamPart = await store.finalizeMediaPart(
      id,
      'webcam',
      Math.round((webcamFrames.length / fixture.fps) * 1_000_000),
    );
    doc = withClosedVideoPart(doc, {
      track: 'webcam',
      part: 0,
      durationSec: webcamPart.durationSec,
      frameCount: webcamPart.frameCount,
      observedFps: webcamPart.observedFps,
      endedEarly: true,
      endReason: 'device-lost',
    });
    await store.writeRecordingDoc(id, doc);

    // Six seconds of screen and microphone, which is what the user still has.
    for (const frame of screenFrames) {
      await store.appendMediaChunk(id, 'screen', {
        data: frame.data,
        isKey: frame.isKey,
        timestampUs: frame.timestampUs,
        durationUs: null,
      });
    }
    const micFrames = Math.ceil((6 * AUDIO_RATE + AAC_ENCODER_DELAY_SAMPLES) / AAC_FRAME_SAMPLES);
    for (let i = 0; i < micFrames; i++) {
      await store.appendMediaChunk(id, 'mic', {
        data: new Uint8Array(64).fill((i % 251) + 1),
        isKey: true,
        timestampUs: Math.round((i * AAC_FRAME_SAMPLES * 1_000_000) / AUDIO_RATE),
        durationUs: null,
      });
    }

    // The crash.
    await store.close(id);

    const report = await store.recoverBundle(id);
    expect(report.recovered).toBe(true);
    expect(
      report.recoveredSec,
      'the recording still holds six seconds of screen and audio; a camera that was ' +
        'unplugged at two must not decide what was recovered',
    ).toBeCloseTo(6, 1);

    const recording = (await readJson(
      join(await store.directoryFor(id), 'recording.json'),
    )) as RecordingDoc;
    expect(validateRecordingDoc(recording).ok).toBe(true);
    expect(recording.tracks.screen?.parts[0]?.durationSec).toBeCloseTo(6, 1);
    expect(recording.tracks.mic?.parts[0]?.durationSec).toBeCloseTo(6, 1);
    expect(recording.integrity.truncatedToSec).toBeCloseTo(report.recoveredSec, 6);

    // And the camera keeps both the two seconds it captured and the reason it
    // stopped, so nothing downstream mistakes an unplug for a crash.
    const webcam = recording.tracks.webcam?.parts[0];
    expect(webcam?.durationSec).toBeCloseTo(2, 1);
    expect(webcam?.endReason).toBe('device-lost');
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
