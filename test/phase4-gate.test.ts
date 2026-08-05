/**
 * **Phase 4 gate: unplug the camera mid-recording.**
 *
 * Architecture report §8, row 4: *"Unplug the camera mid-recording; screen and
 * audio survive; two parts with correct `startTimeSec`."*
 *
 * ## What is real here
 *
 * Everything from the device outwards. The capture page under test is the shipping
 * `apps/renderer/src/capture/main.ts` and `capture/webcam.ts`; the recorder is the
 * shipping `RecorderSession`; the store is a real `ProjectStore` writing real
 * fragmented MP4s and real sidecars into a real bundle, and the assertions are made
 * against the `recording.json` that is actually on disk at the end.
 *
 * What is faked is the *platform*: the camera, the microphone, the display, the two
 * WebCodecs encoders and the clock (`test/phase4/fake-capture-platform.ts` explains
 * each, and why the clock has to be driven for the epoch estimator to mean
 * anything). The two halves are joined the way Electron joins them — the preload is
 * a pass-through, so the capture page's `window.loom.capture.*` calls go straight
 * into the `ipcMain` listeners `RecorderSession.install()` registered.
 *
 * **The unplug is not asserted around.** It is `dispatchEvent(new Event('ended'))`
 * on the camera's `MediaStreamTrack` — the event macOS delivers when a camera is
 * physically removed, and the one §7.4 step 1 names — and the reconnect is a
 * `devicechange` on `navigator.mediaDevices` with the same `deviceId` back in
 * `enumerateDevices`, which is §7.4 step 4. Nothing in the production path is
 * stubbed to make either of them happen.
 *
 * ## What makes this a proof and not a hope
 *
 * The checks live in `test/phase4/verify-parts.ts`, and the two CONTROL cases at
 * the bottom of this file run a **deliberately broken recorder** through the same
 * main-process pipeline and require those checks to fail: one that never opens a
 * second part when the camera comes back, and one that opens it but places it at
 * the origin. Both are the real bugs this phase can have. If either control ever
 * stops failing, the gate above it is passing for the wrong reason — exactly the
 * hole `packages/format/test/kill-mid-write.test.ts` closes for the crash gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL, DEFAULT_CAPTURE_OPTIONS } from '@loom/ipc';
import {
  validateFrameIndexDoc,
  validateRecordingDoc,
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import { ProjectStore } from '../apps/main/src/project-store.ts';
import { RecorderSession } from '../apps/main/src/recorder/session.ts';
import type { WindowRegistry, WindowRole } from '../apps/main/src/windows.ts';
import {
  AAC_FRAME_SAMPLES,
  AAC_FRAME_US,
  AUDIO_ASC,
  AUDIO_RATE,
  DELIVERY_LATENCY_US,
  FRAME_US,
  FakeAudioData,
  FakeAudioEncoder,
  FakeVideoEncoder,
  FakeVideoFrame,
  MIC_EPOCH_US,
  WEBCAM_EPOCH_US,
  clearGlobals,
  fixture,
  installPlatform,
  newDevices,
  plugInCamera,
  setClockUs,
  settled,
  sourceFor,
  type Devices,
  type FakeTrack,
} from './phase4/fake-capture-platform.ts';
import { verifyParts, type Expectation } from './phase4/verify-parts.ts';

// --------------------------------------------------------------- the timeline
//
// One recording, in microseconds on the shared clock. The camera opens 10 ms after
// the screen — a plausible device-open delay, and inside §5.4 mechanism 3's
// 21.3 ms snap, so part 0 must come out at exactly 0 rather than at 0.010. It is
// unplugged at 2 s and comes back at 4 s, which is nowhere near the snap
// threshold, so part 1 must keep the 4.0 it was measured at.

const CAMERA_OPEN_US = 10_000;
const UNPLUG_AT_US = 2_000_000;
const RECONNECT_AT_US = 4_000_000;
const END_AT_US = 6_000_000;

const CAMERA_ID = 'camera-1';

/** Everything the capture page sent to main, in order, for the controls to replay. */
interface Sent {
  channel: string;
  payload: unknown;
}

interface FakeContents {
  id: number;
  sent: Sent[];
  isLoadingMainFrame(): boolean;
  send(channel: string, payload?: unknown): void;
}

type Listener = (event: unknown, payload?: unknown) => void;

const harness = vi.hoisted(() => ({
  listeners: new Map<string, Listener[]>(),
  windows: new Map<string, unknown>(),
}));

vi.mock('electron', () => {
  const display = {
    id: 1,
    label: 'Built-in Liquid Retina XDR',
    size: { width: 1728, height: 1117 },
    scaleFactor: 2,
    colorSpace: 'display-p3',
  };
  return {
    BrowserWindow: { fromWebContents: () => null },
    desktopCapturer: { getSources: () => Promise.resolve([]) },
    ipcMain: {
      on(channel: string, listener: Listener) {
        harness.listeners.set(channel, [...(harness.listeners.get(channel) ?? []), listener]);
      },
      handle: () => undefined,
      removeHandler: () => undefined,
      removeAllListeners(channel: string) {
        harness.listeners.delete(channel);
      },
    },
    screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
    session: { defaultSession: { setDisplayMediaRequestHandler: () => undefined } },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      isTrustedAccessibilityClient: () => false,
    },
  };
});

let scratch: string;
let store: ProjectStore;
let recorder: RecorderSession;
let devices: Devices;
let captureContents: FakeContents;
/** Every message the capture page sent main, so a control can replay a broken one. */
let sentToMain: Sent[];

/**
 * Deliver a renderer message to main, as the preload does.
 *
 * The preload is a pass-through — `ipcRenderer.send(channel, message)` and nothing
 * else — so this is the whole of what sits between the two halves in production.
 */
function toMain(channel: string, payload: unknown): void {
  sentToMain.push({ channel, payload });
  for (const listener of harness.listeners.get(channel) ?? []) {
    listener({ sender: captureContents }, payload);
  }
}

/** The window registry, reduced to what `RecorderSession` asks of it. */
function windowRegistry(): WindowRegistry {
  return {
    show: (role: WindowRole) => harness.windows.get(role),
    get: (role: WindowRole) => harness.windows.get(role),
    all: () => [...harness.windows.values()],
    roleOf: () => undefined,
  } as unknown as WindowRegistry;
}

beforeEach(async () => {
  vi.resetModules();
  harness.listeners.clear();
  harness.windows.clear();
  // The capture page is a module-level singleton, so a subscription from the
  // previous test would otherwise still be listening — against globals this test
  // has already torn down.
  command = undefined;
  FakeVideoEncoder.created.length = 0;
  FakeAudioEncoder.created.length = 0;
  sentToMain = [];
  setClockUs(0);
  devices = newDevices();

  scratch = await mkdtemp(join(tmpdir(), 'loom-phase4-gate-'));
  store = new ProjectStore({
    recordingsRoot: join(scratch, 'recordings'),
    settingsPath: join(scratch, 'settings.json'),
    appVersion: '0.1.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();

  // The capture window main will drive. Its `send` is what carries the start and
  // stop commands to the page, once the page has subscribed to them.
  const contents: FakeContents = {
    id: 1,
    sent: [],
    isLoadingMainFrame: () => false,
    send: (channel: string, payload?: unknown) => {
      contents.sent.push({ channel, payload });
      if (channel === CHANNEL.captureCommand) command?.(payload);
    },
  };
  captureContents = contents;
  harness.windows.set('capture', { webContents: contents, isDestroyed: () => false });

  recorder = new RecorderSession({
    store,
    windows: windowRegistry(),
    appVersion: '0.1.0-test',
    osVersion: '14.0.0',
    stopTimeoutMs: 5_000,
    statusIntervalMs: 10_000,
  });
  recorder.install();
});

afterEach(async () => {
  recorder.uninstall();
  await store.closeAll().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
  clearGlobals();
});

/** The capture page's command subscription, set when the page imports. */
let command: ((payload: unknown) => void) | undefined;

/**
 * Import the real capture page against the fake platform.
 *
 * `vi.resetModules()` in `beforeEach` is what makes this a fresh page each run —
 * the page is a module-level singleton, exactly as it is in a renderer.
 */
async function loadCapturePage(): Promise<void> {
  command = undefined;
  installPlatform(devices, {
    onCommand: (callback: (payload: unknown) => void) => {
      command = callback;
      return () => undefined;
    },
    meta: (message: unknown) => {
      toMain(CHANNEL.captureMeta, message);
    },
    chunk: (message: unknown) => {
      toMain(CHANNEL.captureChunk, message);
    },
    partEnded: (message: unknown) => {
      toMain(CHANNEL.capturePartEnded, message);
    },
    ended: (report: unknown) => {
      toMain(CHANNEL.captureEnded, report);
    },
    failed: (message: unknown) => {
      toMain(CHANNEL.captureFailed, message);
    },
  });
  await import('../apps/renderer/src/capture/main.ts');
}

// ------------------------------------------------------------------- feeding

/** Deliver one screen frame at `atUs` on the shared clock. */
async function screenFrame(index: number): Promise<void> {
  const track = devices.display.getVideoTracks()[0];
  if (track === undefined) throw new Error('the display stream carried no track');
  setClockUs(index * FRAME_US + DELIVERY_LATENCY_US);
  sourceFor<FakeVideoFrame>(track).push(
    new FakeVideoFrame(index * FRAME_US, fixture.width, fixture.height),
  );
  await settled(3);
}

/**
 * Deliver one camera frame.
 *
 * `mediaUs` is when it was captured on the shared clock; its own timestamp is that
 * instant on the camera's epoch, which is 2,678,930 s away from the screen's.
 */
async function cameraFrame(track: FakeTrack, mediaUs: number): Promise<void> {
  setClockUs(mediaUs + DELIVERY_LATENCY_US);
  sourceFor<FakeVideoFrame>(track).push(
    new FakeVideoFrame(WEBCAM_EPOCH_US + mediaUs, fixture.width, fixture.height),
  );
  await settled(3);
}

/** Deliver one microphone buffer covering `[mediaUs, mediaUs + AAC_FRAME_US)`. */
async function micBuffer(mediaUs: number): Promise<void> {
  const track = devices.mic.getAudioTracks()[0];
  if (track === undefined) throw new Error('the microphone stream carried no track');
  // A buffer cannot be delivered before its last sample was captured, which is
  // what `TrackEpochEstimator.observe` is documented to expect.
  setClockUs(mediaUs + AAC_FRAME_US + DELIVERY_LATENCY_US);
  sourceFor<FakeAudioData>(track).push(
    new FakeAudioData(MIC_EPOCH_US + mediaUs, AAC_FRAME_SAMPLES),
  );
  await settled(3);
}

/**
 * Wait for main to have really opened a part, rather than for a fixed number of
 * turns.
 *
 * Announcements are serialized on one queue in main and each one writes
 * `recording.json` and creates a file, so "the part is open" is not observable a
 * fixed number of ticks after the message is sent — a `partEnded` ahead of it in
 * the queue writes a frame index sidecar first, `fsync` included. The part file is
 * what `beginMediaPart` creates, so its existence is the signal.
 */
async function untilPartOpen(id: RecordingId, file: string): Promise<void> {
  const dir = await store.directoryFor(id);
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      await stat(join(dir, file));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`timed out waiting for ${file} to be created`);
}

/** Wait for the writer to have taken `count` frames of a track. */
async function untilFrames(
  id: RecordingId,
  track: 'screen' | 'webcam' | 'mic',
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (store.mediaFrameCount(id, track) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `timed out waiting for ${String(count)} ${track} frames; saw ` +
      String(store.mediaFrameCount(id, track)),
  );
}

async function readRecordingDoc(id: RecordingId): Promise<RecordingDoc> {
  const dir = await store.directoryFor(id);
  return JSON.parse(await readFile(join(dir, 'recording.json'), 'utf8')) as RecordingDoc;
}

/**
 * Record six seconds, losing the camera at two and getting it back at four.
 *
 * Samples are delivered in shared-clock order, so the three tracks interleave the
 * way three real devices do.
 */
async function recordThroughAnUnplug(): Promise<RecordingId> {
  plugInCamera(devices, CAMERA_ID, 'FaceTime HD Camera');
  await loadCapturePage();
  const id = await recorder.start({
    ...DEFAULT_CAPTURE_OPTIONS,
    fps: fixture.fps,
    webcamFps: fixture.fps,
    webcamDeviceId: CAMERA_ID,
    systemAudio: false,
  });
  await settled();

  let camera = devices.cameras.get(CAMERA_ID);
  if (camera === undefined) throw new Error('the camera was never plugged in');

  let nextScreen = 0;
  let nextMic = 0;
  let nextCamera = CAMERA_OPEN_US;
  let unplugged = false;
  let reconnected = false;

  for (let now = 0; now <= END_AT_US; now += 1_000) {
    if (nextScreen * FRAME_US <= now) {
      await screenFrame(nextScreen);
      nextScreen += 1;
    }
    if (nextMic * AAC_FRAME_US <= now) {
      await micBuffer(nextMic * AAC_FRAME_US);
      nextMic += 1;
    }

    if (!unplugged && now >= UNPLUG_AT_US) {
      unplugged = true;
      // §7.4 step 1, for real: the track ends and the device leaves the machine.
      devices.present.delete(CAMERA_ID);
      camera.unplug();
      await settled();
      continue;
    }
    if (unplugged && !reconnected && now >= RECONNECT_AT_US) {
      reconnected = true;
      // §7.4 step 4: the *same* device id reappears, as a new track, and the
      // platform says so the only way it can.
      camera = plugInCamera(devices, CAMERA_ID, 'FaceTime HD Camera');
      nextCamera = RECONNECT_AT_US;
      devices.mediaDevices.dispatchEvent(new Event('devicechange'));
      await settled();
      continue;
    }

    const cameraLive = !unplugged || reconnected;
    if (cameraLive && nextCamera <= now) {
      await cameraFrame(camera, nextCamera);
      nextCamera += FRAME_US;
    }
  }

  const stopping = recorder.stop();
  await settled();
  command?.({ kind: 'stop' });
  await settled();
  await stopping;
  return id;
}

const EXPECTED: Expectation = {
  screenParts: 1,
  webcam: [
    // Opened 10 ms after the screen and snapped onto it: §5.4 mechanism 3 says an
    // offset smaller than one audio buffer is noise, not a late device.
    {
      file: 'media/webcam.000.mp4',
      startTimeSec: 0,
      endedEarly: true,
      endReason: 'device-lost',
    },
    // And four seconds in, kept exactly where it was measured.
    {
      file: 'media/webcam.001.mp4',
      startTimeSec: RECONNECT_AT_US / 1_000_000,
      endedEarly: false,
      endReason: undefined,
    },
  ],
  audioTracks: ['mic'],
};

describe('phase 4 gate: the camera is unplugged mid-recording', () => {
  it('keeps the screen and the audio, and writes two camera parts with correct startTimeSec', async () => {
    const id = await recordThroughAnUnplug();

    const recording = await readRecordingDoc(id);
    const valid = validateRecordingDoc(recording);
    expect(valid.ok ? null : valid.issues, 'recording.json must be valid').toBeNull();

    const problems = verifyParts(recording, EXPECTED);
    expect(problems, problems.join('\n')).toEqual([]);

    // The recording is editable, not failed: losing a camera is not losing a
    // recording (§7.4).
    expect((await store.list()).find((summary) => summary.id === id)?.state).toBe('editable');

    // And both camera parts are real files with real sidecars — the frame index a
    // VFR track cannot be seeked without (§2.4).
    const dir = await store.directoryFor(id);
    for (const part of recording.tracks.webcam?.parts ?? []) {
      const index = validateFrameIndexDoc(
        JSON.parse(await readFile(join(dir, part.index), 'utf8')),
      );
      expect(index.ok ? null : index.issues, `${part.index} must be a valid sidecar`).toBeNull();
      if (!index.ok) continue;
      expect(index.value.pts.length, `${part.index} must index every frame`).toBe(part.frameCount);
      expect(index.value.keyframes[0], `${part.file} must begin on a keyframe`).toBe(0);
    }

    // The gap between the parts is the unplug, and it is supposed to be there.
    const parts = recording.tracks.webcam?.parts ?? [];
    const first = parts[0];
    const second = parts[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const gapSec = second.startTimeSec - (first.startTimeSec + first.durationSec);
    expect(gapSec, 'the hole the camera left must survive into recording.json').toBeGreaterThan(1);

    // The screen ran the whole time, across the unplug and the reconnect.
    const screen = recording.tracks.screen?.parts[0];
    expect(screen?.durationSec).toBeGreaterThan(RECONNECT_AT_US / 1_000_000);
  });

  it('leaves no camera device running once the recording has stopped', async () => {
    await recordThroughAnUnplug();
    // Both acquisitions, including the one the reconnect opened. A camera left
    // running keeps the hardware indicator lit and posts chunks under a key the
    // next recording would accept as its own.
    const cameraStreams = devices.handedOut;
    expect(cameraStreams.length, 'the camera must have been opened twice').toBe(2);
    for (const stream of cameraStreams) {
      for (const track of stream.getTracks()) {
        expect(track.stopped, `${track.label} outlived the recording`).toBe(true);
      }
    }
    for (const encoder of FakeVideoEncoder.created) {
      expect(encoder.state, 'an encoder outlived its session').toBe('closed');
    }
  });
});

// ------------------------------------------------------------------- controls
//
// The same main-process pipeline — real `RecorderSession`, real `ProjectStore`,
// real writers — driven by a renderer that gets the part model wrong in the two
// ways it can. Both must fail the checks the gate above passes. If either stops
// failing, those checks have stopped measuring anything.

/** The message sequence a correct renderer sends, with a part of it broken. */
interface BrokenRenderer {
  /** Skip the `partEnded` message, so the track never closes its first part. */
  swallowPartEnded?: boolean;
  /** Report the second part as starting at the recording's origin. */
  restartTimeAtOrigin?: boolean;
  /** Keep writing the second acquisition into the first part's index. */
  reuseFirstPart?: boolean;
}

/**
 * Replay a recording through main with the renderer's half deliberately wrong.
 *
 * Hand-built rather than captured from the gate run, because a control has to be
 * able to express a message sequence the correct renderer never produces — that is
 * the point of it.
 */
async function replayBrokenRecording(broken: BrokenRenderer): Promise<RecordingId> {
  const id = await recorder.start({
    ...DEFAULT_CAPTURE_OPTIONS,
    fps: fixture.fps,
    webcamFps: fixture.fps,
    webcamDeviceId: CAMERA_ID,
    systemAudio: false,
  });
  await settled(4);

  const key = fixture.frames.find((frame) => frame.isKey)?.data;
  if (key === undefined) throw new Error('the fixture carried no keyframe');
  const videoMeta = (track: string, part: number, firstTimestampUs: number): unknown => ({
    track,
    part,
    decoderConfig: {
      codec: 'avc1.64000d',
      codedWidth: fixture.width,
      codedHeight: fixture.height,
      description: fixture.avcC,
    },
    ...(track === 'webcam'
      ? {
          video: {
            deviceId: CAMERA_ID,
            deviceName: 'FaceTime HD Camera',
            firstTimestampUs,
            epochOffsetUs: -WEBCAM_EPOCH_US,
          },
        }
      : {}),
  });
  const chunk = (track: string, part: number, timestampUs: number, index: number): unknown => ({
    track,
    part,
    kind: index === 0 ? 'key' : 'delta',
    timestampUs,
    durationUs: null,
    data: index === 0 ? key : (fixture.frames[index % fixture.frames.length]?.data ?? key),
  });

  // The screen, running the whole six seconds.
  toMain(CHANNEL.captureMeta, videoMeta('screen', 0, 0));
  await untilPartOpen(id, 'media/screen.000.mp4');
  const screenFrames = Math.floor(END_AT_US / FRAME_US);
  for (let index = 0; index < screenFrames; index++) {
    toMain(CHANNEL.captureChunk, chunk('screen', 0, index * FRAME_US, index));
  }
  // The writer holds one sample, so it reports one fewer than it has been given.
  await untilFrames(id, 'screen', screenFrames - 1);

  // The microphone, likewise.
  toMain(CHANNEL.captureMeta, {
    track: 'mic',
    part: 0,
    decoderConfig: {
      codec: 'mp4a.40.2',
      sampleRate: AUDIO_RATE,
      numberOfChannels: 1,
      description: AUDIO_ASC,
    },
    audio: {
      deviceId: 'mic-1',
      deviceName: 'MacBook Pro Microphone',
      source: 'getusermedia',
      settings: {
        sampleRate: AUDIO_RATE,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      violations: [],
    },
  });
  await untilPartOpen(id, 'media/mic.000.m4a');
  const micFrames = Math.floor(END_AT_US / AAC_FRAME_US);
  for (let index = 0; index < micFrames; index++) {
    toMain(CHANNEL.captureChunk, {
      track: 'mic',
      part: 0,
      kind: 'key',
      timestampUs: MIC_EPOCH_US + index * AAC_FRAME_US,
      durationUs: AAC_FRAME_US,
      data: new Uint8Array(64).fill((index % 251) + 1),
    });
  }

  // The camera's first acquisition, ending at the unplug.
  toMain(CHANNEL.captureMeta, videoMeta('webcam', 0, WEBCAM_EPOCH_US + CAMERA_OPEN_US));
  await untilPartOpen(id, 'media/webcam.000.mp4');
  const firstFrames = Math.floor((UNPLUG_AT_US - CAMERA_OPEN_US) / FRAME_US);
  for (let index = 0; index < firstFrames; index++) {
    toMain(
      CHANNEL.captureChunk,
      chunk('webcam', 0, WEBCAM_EPOCH_US + CAMERA_OPEN_US + index * FRAME_US, index),
    );
  }
  await untilFrames(id, 'webcam', firstFrames - 1);
  if (broken.swallowPartEnded !== true) {
    toMain(CHANNEL.capturePartEnded, {
      track: 'webcam',
      part: 0,
      facts: { deviceId: CAMERA_ID, deviceName: 'FaceTime HD Camera' },
      firstTimestampUs: WEBCAM_EPOCH_US + CAMERA_OPEN_US,
      lastTimestampUs: WEBCAM_EPOCH_US + CAMERA_OPEN_US + (firstFrames - 1) * FRAME_US,
      endedAtUs: WEBCAM_EPOCH_US + UNPLUG_AT_US,
      epochOffsetUs: -WEBCAM_EPOCH_US,
      framesEncoded: firstFrames,
      framesDropped: 0,
      endedEarly: true,
      endReason: 'device-lost',
    });
    await settled(4);
  }
  await untilFrames(id, 'mic', micFrames - 1);

  // And the second, after the reconnect.
  const secondPart = broken.reuseFirstPart === true ? 0 : 1;
  const secondFirstUs = WEBCAM_EPOCH_US + RECONNECT_AT_US;
  const reported = broken.restartTimeAtOrigin === true ? WEBCAM_EPOCH_US : secondFirstUs;
  if (broken.swallowPartEnded !== true && broken.reuseFirstPart !== true) {
    toMain(CHANNEL.captureMeta, videoMeta('webcam', secondPart, reported));
    await untilPartOpen(id, 'media/webcam.001.mp4');
  }
  const secondFrames = Math.floor((END_AT_US - RECONNECT_AT_US) / FRAME_US);
  for (let index = 0; index < secondFrames; index++) {
    toMain(
      CHANNEL.captureChunk,
      chunk('webcam', secondPart, secondFirstUs + index * FRAME_US, index),
    );
  }
  await untilFrames(id, 'webcam', secondFrames - 1);
  const stopping = recorder.stop();
  await settled(4);
  toMain(CHANNEL.captureEnded, {
    reason: 'stopped',
    endedAtUs: END_AT_US,
    framesEncoded: screenFrames,
    framesDropped: 0,
    epochOffsetUs: 0,
    audio: [
      {
        track: 'mic',
        part: 0,
        facts: {
          deviceId: 'mic-1',
          deviceName: 'MacBook Pro Microphone',
          source: 'getusermedia',
          settings: {
            sampleRate: AUDIO_RATE,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          violations: [],
        },
        summary: {
          bufferCount: micFrames,
          sampleCount: micFrames * AAC_FRAME_SAMPLES,
          firstTimestampUs: MIC_EPOCH_US,
          lastTimestampUs: MIC_EPOCH_US + (micFrames - 1) * AAC_FRAME_US,
          lastFrameCount: AAC_FRAME_SAMPLES,
          gaps: [],
          gapUs: 0,
          nominalSampleRate: AUDIO_RATE,
          measuredSampleRate: AUDIO_RATE,
          rateIsNominal: true,
        },
        epochOffsetUs: -MIC_EPOCH_US,
        endedEarly: false,
      },
    ],
    video: [
      {
        track: 'screen',
        part: 0,
        firstTimestampUs: 0,
        lastTimestampUs: (screenFrames - 1) * FRAME_US,
        endedAtUs: END_AT_US,
        epochOffsetUs: 0,
        framesEncoded: screenFrames,
        framesDropped: 0,
        endedEarly: false,
      },
      {
        track: 'webcam',
        part: secondPart,
        facts: { deviceId: CAMERA_ID, deviceName: 'FaceTime HD Camera' },
        firstTimestampUs: reported,
        lastTimestampUs: secondFirstUs + (secondFrames - 1) * FRAME_US,
        endedAtUs: WEBCAM_EPOCH_US + END_AT_US,
        epochOffsetUs: -WEBCAM_EPOCH_US,
        framesEncoded: secondFrames,
        framesDropped: 0,
        endedEarly: false,
      },
    ],
  });
  await stopping;
  return id;
}

describe('phase 4 gate: the controls', () => {
  it('CONTROL: a recorder that never opens a second part fails the gate', async () => {
    const id = await replayBrokenRecording({ swallowPartEnded: true, reuseFirstPart: true });
    const problems = verifyParts(await readRecordingDoc(id), EXPECTED);

    // If this ever comes back empty, the gate above is not actually checking that
    // the camera came back as its own part, and a build that concatenated the
    // unplug out of the media would pass it.
    expect(
      problems.some((problem) => problem.includes('part(s), expected 2')),
      'a single merged webcam part was accepted; the part-count check has stopped working',
    ).toBe(true);
  });

  it('CONTROL: a recorder that starts the second part at the origin fails the gate', async () => {
    const id = await replayBrokenRecording({ restartTimeAtOrigin: true });
    const problems = verifyParts(await readRecordingDoc(id), EXPECTED);

    // Two parts, both files present, both playable — and the second one placed on
    // top of the first. This is the failure that looks fine until someone watches
    // the recording, and it is the one the `startTimeSec` check exists for.
    expect(
      problems.some((problem) => problem.includes('webcam part 1 starts at')),
      'a second part placed at the origin was accepted; the startTimeSec check has ' +
        'stopped working',
    ).toBe(true);
  });

  it('CONTROL: the same replay with nothing broken passes the gate', async () => {
    // The controls above must fail *because of what they broke*, not because the
    // replay harness cannot produce a good recording in the first place.
    const id = await replayBrokenRecording({});
    const problems = verifyParts(await readRecordingDoc(id), EXPECTED);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
