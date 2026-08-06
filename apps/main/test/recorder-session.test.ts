/**
 * `RecorderSession` against a real `ProjectStore`, with `electron` replaced.
 *
 * The lifecycle test beside this one drives the store directly, which is the half
 * that decides what ends up on disk. This is the half above it: the message
 * ordering between the capture page and main, which no fixture-driven test can see,
 * because a fixture is not two IPC messages sent in the same turn.
 *
 * That ordering is load-bearing. The capture page sends `meta` and the first chunk
 * for the *same* frame, back to back, and opening the part is two awaits long. A
 * chunk that arrives in that window and is dropped is the part's initial keyframe —
 * and without it nothing before the next one, a second later, decodes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL, DEFAULT_CAPTURE_OPTIONS, type RecorderStatus } from '@loom/ipc';
import {
  validateFrameIndexDoc,
  validateRecordingDoc,
  type ProjectState,
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import { ProjectStore } from '../src/project-store.ts';
import { RecorderSession } from '../src/recorder/session.ts';
import type { WindowRegistry, WindowRole } from '../src/windows.ts';
import {
  loadEncodedFixture,
  type FixtureFrame,
} from '../../../packages/mux/test/helpers/fixture.ts';

interface FakeContents {
  id: number;
  /** Everything main pushed to this window, so a command's payload is inspectable. */
  sent: { channel: string; payload?: unknown }[];
  isLoadingMainFrame(): boolean;
  send(channel: string, payload?: unknown): void;
}

interface FakeWindow {
  webContents: FakeContents;
  isDestroyed(): boolean;
}

type Listener = (event: unknown, payload?: unknown) => void;
type Handler = (event: unknown, payload?: unknown) => unknown;

const harness = vi.hoisted(() => ({
  listeners: new Map<string, Listener[]>(),
  handlers: new Map<string, Handler>(),
  windows: new Map<WindowRole, FakeWindow>(),
  /**
   * What TCC says about Screen Recording. Mutable because architecture report §7.3
   * turns on reading it *after* the source ended: a revoked grant and a "Stop
   * sharing" click produce the same `source-ended`, and this is the only thing that
   * tells them apart.
   */
  screenAccess: 'granted',
  /**
   * And what it says about the Microphone. Mutable for the same reason and for a
   * sharper one: `decision-mic-revocation.md` turns on reading this *while the
   * recording is still running*, which is the one moment the answer is about the
   * event that just happened.
   */
  micAccess: 'granted',
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
    BrowserWindow: {
      fromWebContents: (contents: { id: number }) =>
        [...harness.windows.values()].find((w) => w.webContents.id === contents.id) ?? null,
    },
    desktopCapturer: { getSources: () => Promise.resolve([]) },
    ipcMain: {
      on(channel: string, listener: Listener) {
        harness.listeners.set(channel, [...(harness.listeners.get(channel) ?? []), listener]);
      },
      handle(channel: string, handler: Handler) {
        harness.handlers.set(channel, handler);
      },
      removeHandler(channel: string) {
        harness.handlers.delete(channel);
      },
      removeAllListeners(channel: string) {
        harness.listeners.delete(channel);
      },
    },
    screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
    session: { defaultSession: { setDisplayMediaRequestHandler: () => undefined } },
    app: { isPackaged: false },
    shell: { openExternal: () => Promise.resolve() },
    systemPreferences: {
      getMediaAccessStatus: (kind: string) =>
        kind === 'screen'
          ? harness.screenAccess
          : kind === 'microphone'
            ? harness.micAccess
            : 'granted',
      isTrustedAccessibilityClient: () => false,
    },
  };
});

const fixture = loadEncodedFixture();

let nextContentsId = 0;
let scratch: string;
let store: ProjectStore;
let recorder: RecorderSession;

/** The window registry, reduced to what `RecorderSession` actually asks of it. */
const windows = {
  show(role: WindowRole): FakeWindow {
    const existing = harness.windows.get(role);
    if (existing !== undefined) return existing;
    nextContentsId += 1;
    const sent: { channel: string; payload?: unknown }[] = [];
    const window: FakeWindow = {
      webContents: {
        id: nextContentsId,
        sent,
        isLoadingMainFrame: () => false,
        send: (channel: string, payload?: unknown) => sent.push({ channel, payload }),
      },
      isDestroyed: () => false,
    };
    harness.windows.set(role, window);
    return window;
  },
  get: (role: WindowRole): FakeWindow | undefined => harness.windows.get(role),
  all: (): FakeWindow[] => [...harness.windows.values()],
  roleOf: (window: unknown): WindowRole | undefined =>
    [...harness.windows.entries()].find(([, w]) => w === window)?.[0],
} as unknown as WindowRegistry;

function captureContents(): FakeContents {
  const capture = harness.windows.get('capture');
  if (capture === undefined) throw new Error('the capture window was never asked for');
  return capture.webContents;
}

function emit(channel: string, sender: FakeContents, payload?: unknown): void {
  for (const listener of harness.listeners.get(channel) ?? []) listener({ sender }, payload);
}

function invoke(channel: string, sender: FakeContents, payload?: unknown): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (handler === undefined) throw new Error(`nothing handles ${channel}`);
  return Promise.resolve(handler({ sender }, payload));
}

/**
 * One turn of the event loop, which is enough for the announcement queue to drain.
 *
 * Track announcements are serialized on `metaChain`, so an announcement emitted
 * while the queue is idle has been through `onMeta` by the time a timer fires.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Poll rather than sleep: these writes are local and finish in single-digit ms. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function untilState(id: RecordingId, state: ProjectState, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await store.list()).find((s) => s.id === id)?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${id} to reach ${state}`);
}

/**
 * Prove the media plays, using AVFoundation rather than our own reader.
 *
 * The same standard `apps/main/test/capture-crash.test.ts` holds a crash-recovered
 * recording to, for the same reason: our own scanner agreeing with our own writer
 * would prove only that they agree. `PresetPassthrough` remuxes without re-encoding,
 * so it exercises the demuxer and every sample table without spending a decode, and
 * `/usr/bin/avconvert` ships with macOS — the only platform this app runs on.
 */
function playsUnderAVFoundation(mediaPath: string, outPath: string): { ok: boolean; log: string } {
  const result = spawnSync(
    '/usr/bin/avconvert',
    ['--source', mediaPath, '--output', outPath, '--preset', 'PresetPassthrough'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return {
    ok: result.status === 0,
    log: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

function metaMessage(): unknown {
  return {
    track: 'screen',
    part: 0,
    decoderConfig: {
      codec: 'avc1.64000d',
      codedWidth: fixture.width,
      codedHeight: fixture.height,
      description: fixture.avcC,
    },
  };
}

function chunkMessage(frame: FixtureFrame): unknown {
  return {
    track: 'screen',
    part: 0,
    kind: frame.isKey ? 'key' : 'delta',
    timestampUs: frame.timestampUs,
    durationUs: null,
    data: frame.data,
  };
}

/**
 * The camera's clock origin, as this project measured it.
 *
 * A camera's timestamps are not on the screen's epoch — the machine's uptime is
 * what Chromium stamps them from — so the announcement carries the offset that
 * relates the two, and every number below is on the camera's own clock.
 */
const WEBCAM_EPOCH_US = 2_678_930_000_000;

function webcamMetaMessage(part: number): unknown {
  return {
    track: 'webcam',
    part,
    decoderConfig: {
      codec: 'avc1.64000d',
      codedWidth: fixture.width,
      codedHeight: fixture.height,
      description: fixture.avcC,
    },
    video: {
      deviceId: 'camera-1',
      deviceName: 'FaceTime HD Camera',
      firstTimestampUs: WEBCAM_EPOCH_US,
      epochOffsetUs: -WEBCAM_EPOCH_US,
    },
  };
}

function webcamChunkMessage(part: number, frame: FixtureFrame): unknown {
  return {
    track: 'webcam',
    part,
    kind: frame.isKey ? 'key' : 'delta',
    timestampUs: WEBCAM_EPOCH_US + frame.timestampUs,
    durationUs: null,
    data: frame.data,
  };
}

/** What the capture page sends when the camera is unplugged (§7.4 step 2). */
function webcamPartEnded(part: number, frames: FixtureFrame[]): unknown {
  const last = frames[frames.length - 1]!;
  return {
    track: 'webcam',
    part,
    facts: { deviceId: 'camera-1', deviceName: 'FaceTime HD Camera' },
    firstTimestampUs: WEBCAM_EPOCH_US + frames[0]!.timestampUs,
    lastTimestampUs: WEBCAM_EPOCH_US + last.timestampUs,
    endedAtUs: WEBCAM_EPOCH_US + last.timestampUs + Math.round(1_000_000 / fixture.fps),
    epochOffsetUs: -WEBCAM_EPOCH_US,
    framesEncoded: frames.length,
    framesDropped: 0,
    endedEarly: true,
    endReason: 'device-lost',
  };
}

/** An AAC-LC 48 kHz stereo AudioSpecificConfig, which is all the writer needs. */
const AUDIO_ASC = new Uint8Array([0x11, 0x90]);
const AUDIO_RATE = 48000;
const AAC_FRAME_SAMPLES = 1024;
const AAC_FRAME_US = Math.round((AAC_FRAME_SAMPLES * 1_000_000) / AUDIO_RATE);

function audioSettings(): unknown {
  return {
    sampleRate: AUDIO_RATE,
    channelCount: 2,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}

function audioMetaMessage(track: 'mic' | 'system'): unknown {
  return {
    track,
    part: 0,
    decoderConfig: {
      codec: 'mp4a.40.2',
      sampleRate: AUDIO_RATE,
      numberOfChannels: 2,
      description: AUDIO_ASC,
    },
    audio: {
      deviceId: 'device-1',
      deviceName: 'MacBook Pro Microphone',
      source: 'getusermedia',
      settings: audioSettings(),
      violations: [],
    },
  };
}

function audioChunkMessage(track: 'mic' | 'system', index: number): unknown {
  return {
    track,
    part: 0,
    kind: 'key',
    timestampUs: index * AAC_FRAME_US,
    durationUs: AAC_FRAME_US,
    data: new Uint8Array(64).fill((index % 251) + 1),
  };
}

/**
 * Wait for an audio part file to exist.
 *
 * The announcements are queued behind each other, so "the mic has announced
 * itself" is not observable a fixed number of turns after the message is sent —
 * but the part file is created by `beginAudioPart`, and by then the track has its
 * entry in `RecorderSession`, which is what decides whether a chunk is held or
 * dropped.
 */
async function untilAudioPartOpen(id: RecordingId, track: 'mic' | 'system'): Promise<void> {
  const dir = await store.directoryFor(id);
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      await stat(join(dir, `media/${track}.000.m4a`));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`timed out waiting for the ${track} part to be created`);
}

async function readRecordingDoc(id: RecordingId): Promise<RecordingDoc> {
  const dir = await store.directoryFor(id);
  return JSON.parse(await readFile(join(dir, 'recording.json'), 'utf8')) as RecordingDoc;
}

/** Wait for a part file to exist — see {@link untilAudioPartOpen} for why. */
async function untilPartOpen(id: RecordingId, relative: string): Promise<void> {
  const dir = await store.directoryFor(id);
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      await stat(join(dir, relative));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`timed out waiting for ${relative} to be created`);
}

/** Poll `recording.json` until it says what the caller is waiting for. */
async function untilRecordingDoc(
  id: RecordingId,
  predicate: (doc: RecordingDoc) => boolean,
  what: string,
): Promise<RecordingDoc> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const doc = await readRecordingDoc(id);
    if (predicate(doc)) return doc;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The last status main pushed to a window, which is what the HUD renders. */
function lastStatus(contents: FakeContents): RecorderStatus {
  const statuses = contents.sent.filter((message) => message.channel === CHANNEL.recorderStatus);
  const last = statuses[statuses.length - 1]?.payload;
  if (last === undefined) throw new Error('main never published a status');
  return last as RecorderStatus;
}

function startedOptions(contents: FakeContents): Record<string, unknown> {
  const command = contents.sent.find((message) => message.channel === CHANNEL.captureCommand);
  const payload = command?.payload as { options?: Record<string, unknown> } | undefined;
  if (payload?.options === undefined) throw new Error('the capture page was never told to start');
  return payload.options;
}

function endedMessage(frames: FixtureFrame[], audio?: unknown[]): unknown {
  const last = frames[frames.length - 1]!;
  return {
    reason: 'stopped',
    endedAtUs: last.timestampUs + Math.round(1_000_000 / fixture.fps),
    framesEncoded: frames.length,
    framesDropped: 0,
    epochOffsetUs: 0,
    ...(audio === undefined ? {} : { audio }),
  };
}

/** What the capture page's meter would report for `frames` untroubled AAC frames. */
function audioReport(track: 'mic' | 'system', frames: number): Record<string, unknown> {
  return {
    track,
    part: 0,
    facts: {
      deviceId: 'device-1',
      deviceName: 'MacBook Pro Microphone',
      source: 'getusermedia',
      settings: audioSettings(),
      violations: [],
    },
    summary: {
      bufferCount: frames,
      sampleCount: frames * AAC_FRAME_SAMPLES,
      firstTimestampUs: 0,
      lastTimestampUs: (frames - 1) * AAC_FRAME_US,
      lastFrameCount: AAC_FRAME_SAMPLES,
      gaps: [],
      gapUs: 0,
      nominalSampleRate: AUDIO_RATE,
      measuredSampleRate: AUDIO_RATE,
      rateIsNominal: true,
    },
    epochOffsetUs: 0,
    endedEarly: false,
  };
}

beforeEach(async () => {
  harness.listeners.clear();
  harness.handlers.clear();
  harness.windows.clear();
  harness.screenAccess = 'granted';
  harness.micAccess = 'granted';
  scratch = await mkdtemp(join(tmpdir(), 'loom-recorder-session-'));
  store = new ProjectStore({
    recordingsRoot: join(scratch, 'recordings'),
    settingsPath: join(scratch, 'settings.json'),
    appVersion: '0.1.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
  recorder = new RecorderSession({
    store,
    windows,
    appVersion: '0.1.0-test',
    osVersion: '14.0.0',
    stopTimeoutMs: 2_000,
    statusIntervalMs: 10_000,
  });
  recorder.install();
});

afterEach(async () => {
  recorder.uninstall();
  await store.closeAll().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
});

describe('the capture page talking to main', () => {
  it('keeps the chunks that arrive while the part is still being opened', async () => {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();

    // One turn, exactly as `onEncoded` sends them: the decoder configuration and
    // the frame it was derived from. `onMeta` has not reached `beginMediaPart`
    // yet, let alone returned from it.
    const frames = fixture.frames.slice(0, 20);
    emit(CHANNEL.captureMeta, contents, metaMessage());
    emit(CHANNEL.captureChunk, contents, chunkMessage(frames[0]!));
    emit(CHANNEL.captureChunk, contents, chunkMessage(frames[1]!));
    expect(store.mediaFrameCount(id, 'screen')).toBe(0);

    // The writer holds one sample, so two chunks through it is one frame on the
    // file — and that frame arriving at all is the property under test.
    await until(() => store.mediaFrameCount(id, 'screen') >= 1, 'the held chunks to be written');
    for (const frame of frames.slice(2)) emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    await until(() => store.mediaFrameCount(id, 'screen') >= frames.length - 1, 'every chunk');

    const last = frames[frames.length - 1]!;
    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, {
      reason: 'stopped',
      endedAtUs: last.timestampUs + Math.round(1_000_000 / fixture.fps),
      framesEncoded: frames.length,
      framesDropped: 3,
    });
    await stopping;

    const dir = await store.directoryFor(id);
    const index = validateFrameIndexDoc(
      JSON.parse(await readFile(join(dir, 'media/screen.000.index.json'), 'utf8')),
    );
    expect(index.ok ? null : index.issues).toBeNull();
    if (!index.ok) return;
    expect(index.value.pts.length).toBe(frames.length);
    // The part begins on the keyframe, and on *that* keyframe — its size is the
    // first fixture frame's, not the second's.
    expect(index.value.keyframes[0]).toBe(0);
    expect(index.value.sizes[0]).toBe(frames[0]!.data.byteLength);

    const recording = JSON.parse(
      await readFile(join(dir, 'recording.json'), 'utf8'),
    ) as RecordingDoc;
    expect(validateRecordingDoc(recording).ok).toBe(true);
    expect(recording.tracks.screen?.parts[0]?.frameCount).toBe(frames.length);
    // The capture page counted three drops. Three is what is recorded, not six.
    expect(recording.capture.droppedFrames).toEqual({ screen: 3 });
    expect((await store.list()).find((s) => s.id === id)?.state).toBe('editable');
  });

  it('ends the recording loudly rather than holding chunks for a part that never opens', async () => {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();

    // No `meta`, so no part. The bound on what may be held is what keeps this from
    // becoming unbounded memory — which is also the memory a `SIGKILL` would cost.
    for (let i = 0; i < 400; i++) {
      emit(CHANNEL.captureChunk, contents, chunkMessage(fixture.frames[i % 60]!));
    }

    await untilState(id, 'failed');
    const summary = (await store.list()).find((s) => s.id === id);
    expect(summary?.state).toBe('failed');
  });
});

/**
 * The camera half of the same conversation — §7.4.
 *
 * Two things main cannot get from anywhere else. A part that closes *while the
 * recording carries on* has to reach `recording.json` when it closes, because a
 * crash after it is what crash recovery has to read; and what the HUD says about
 * the camera has to distinguish one that is opening from one that is not coming.
 */
describe('the camera', () => {
  it('says a camera that was asked for is starting, and only calls it unavailable when it is', async () => {
    await recorder.start({ fps: fixture.fps, webcamDeviceId: 'camera-1' });
    const contents = captureContents();

    // `getUserMedia` plus a frame is several hundred milliseconds on macOS. For
    // that whole interval the camera is opening, not missing — the §7.4 banner
    // must not be on screen.
    expect(lastStatus(contents).camera).toBe('starting');

    emit(CHANNEL.captureCameraUnavailable, contents, 'the camera could not be opened: NotAllowed');
    expect(lastStatus(contents).camera).toBe('unavailable');
  });

  it('writes a camera part that closed mid-recording into recording.json', async () => {
    const id = await recorder.start({ fps: fixture.fps, webcamDeviceId: 'camera-1' });
    const contents = captureContents();

    emit(CHANNEL.captureMeta, contents, metaMessage());
    for (const frame of fixture.frames.slice(0, 8)) {
      emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    }
    emit(CHANNEL.captureMeta, contents, webcamMetaMessage(0));
    await untilPartOpen(id, 'media/webcam.000.mp4');
    const webcamFrames = fixture.frames.slice(0, 8);
    for (const frame of webcamFrames) {
      emit(CHANNEL.captureChunk, contents, webcamChunkMessage(0, frame));
    }
    await until(() => store.mediaFrameCount(id, 'webcam') > 0, 'the camera frames');

    // The cable moves. The screen and the microphone do not notice, and the part
    // is finalized on the spot.
    emit(CHANNEL.capturePartEnded, contents, webcamPartEnded(0, webcamFrames));

    const doc = await untilRecordingDoc(
      id,
      (recording) => recording.tracks.webcam?.parts[0]?.endedEarly === true,
      "recording.json to record the camera part's close",
    );
    const part = doc.tracks.webcam?.parts[0];
    expect(part?.endReason).toBe('device-lost');
    expect(part?.frameCount).toBeGreaterThan(0);
    expect(part?.durationSec).toBeGreaterThan(0);
    // Still recording, and the screen track untouched by any of it.
    expect(doc.tracks.screen?.parts).toHaveLength(1);
    // And the HUD is told, which is the whole of §7.4 step 3.
    await until(() => lastStatus(contents).camera === 'lost', 'the camera banner');
  });

  it('places a camera part on the recording clock even when the capture page dies first', async () => {
    const id = await recorder.start({ fps: fixture.fps, webcamDeviceId: 'camera-1' });
    const contents = captureContents();

    emit(CHANNEL.captureMeta, contents, metaMessage());
    for (const frame of fixture.frames.slice(0, 8)) {
      emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    }
    emit(CHANNEL.captureMeta, contents, webcamMetaMessage(0));
    await untilPartOpen(id, 'media/webcam.000.mp4');
    for (const frame of fixture.frames.slice(0, 8)) {
      emit(CHANNEL.captureChunk, contents, webcamChunkMessage(0, frame));
    }
    await until(() => store.mediaFrameCount(id, 'webcam') > 0, 'the camera frames');

    // The capture page throws instead of stopping, so there is no end report to
    // close the camera's part with — main has to close it from what it saw. What it
    // saw are timestamps on the camera's own epoch, and subtracting the screen's
    // origin from those without the offset that relates them writes a camera that
    // starts a month into a six second recording.
    emit(CHANNEL.captureFailed, contents, 'the capture page fell over');

    await untilState(id, 'editable');
    const doc = await readRecordingDoc(id);
    expect(validateRecordingDoc(doc).ok).toBe(true);
    const part = doc.tracks.webcam?.parts[0];
    expect(part?.frameCount).toBeGreaterThan(0);
    expect(
      part?.startTimeSec,
      'the camera opened with the screen; its part starts with the recording',
    ).toBeCloseTo(0, 3);
  });
});

/**
 * The audio half of the same conversation.
 *
 * Every case here is one of the ways an audio track can be lost *silently* —
 * discarded state, a measurement that never arrives, one malformed field — which
 * §7.3 allows only to cost that track, and only when the track really produced
 * nothing. A `.m4a` full of audio that `recording.json` does not mention is worse
 * than a failed recording: the bundle finalizes to `editable`, and no crash
 * recovery pass ever looks at an editable bundle again.
 */
describe('the audio tracks', () => {
  /** Record `frames` screen frames and `micFrames` AAC frames, and return the video. */
  async function recordSomeAudio(id: RecordingId, micFrames: number): Promise<FixtureFrame[]> {
    const contents = captureContents();
    const frames = fixture.frames.slice(0, 8);
    emit(CHANNEL.captureMeta, contents, metaMessage());
    for (const frame of frames) emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    emit(CHANNEL.captureMeta, contents, audioMetaMessage('mic'));
    await untilAudioPartOpen(id, 'mic');
    for (let i = 0; i < micFrames; i++) {
      emit(CHANNEL.captureChunk, contents, audioChunkMessage('mic', i));
    }
    await until(() => store.mediaFrameCount(id, 'mic') >= micFrames, 'the mic frames');
    return frames;
  }

  it('keeps a live track when a second announcement arrives for it', async () => {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();
    const frames = await recordSomeAudio(id, 4);

    // A duplicate announcement is refused — the capture page's own guard means it
    // should never arrive — but refusing it must not discard the part that is
    // already recording underneath it.
    emit(CHANNEL.captureMeta, contents, audioMetaMessage('mic'));
    await tick();

    for (let i = 4; i < 8; i++) emit(CHANNEL.captureChunk, contents, audioChunkMessage('mic', i));
    await until(() => store.mediaFrameCount(id, 'mic') >= 8, 'the mic track to still be recording');

    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, endedMessage(frames, [audioReport('mic', 8)]));
    await stopping;

    const recording = await readRecordingDoc(id);
    expect(validateRecordingDoc(recording).ok).toBe(true);
    expect(recording.tracks.mic?.parts[0]?.durationSec).toBeGreaterThan(0);
  });

  it('describes a track from its bytes when no measurement arrives for it', async () => {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();
    const frames = await recordSomeAudio(id, 8);

    // The capture page answered, with nothing to say about its audio: the shape a
    // renderer that died during its stop, or a stop that timed out, leaves behind.
    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, endedMessage(frames, []));
    await stopping;

    const recording = await readRecordingDoc(id);
    expect(validateRecordingDoc(recording).ok).toBe(true);
    const part = recording.tracks.mic?.parts[0];
    expect(part, 'the .m4a on disk was left referenced by nothing').toBeDefined();
    // The samples that were written, less the encoder priming the part's edit list
    // tells a reader to skip.
    expect(part?.durationSec).toBeCloseTo((8 * AAC_FRAME_SAMPLES - 2112) / AUDIO_RATE, 6);
    expect(part?.measuredSampleRate).toBe(AUDIO_RATE);
    expect(part?.endedEarly).toBe(true);
    expect(part?.endReason).toBe('crash');
  });

  it('finalizes despite a malformed audio entry in the end report', async () => {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();
    const frames = fixture.frames.slice(0, 8);
    emit(CHANNEL.captureMeta, contents, metaMessage());
    for (const frame of frames) emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    await until(() => store.mediaFrameCount(id, 'screen') >= frames.length - 1, 'the frames');

    const stopping = recorder.stop();
    const malformed = audioReport('mic', 8);
    malformed['part'] = 'not-a-part';
    expect(() => {
      emit(CHANNEL.captureEnded, contents, endedMessage(frames, [malformed]));
    }, 'one bad field must not abort the listener the whole stop waits on').not.toThrow();
    await stopping;

    expect((await store.list()).find((s) => s.id === id)?.state).toBe('editable');
    expect((await readRecordingDoc(id)).tracks.screen?.parts[0]?.frameCount).toBe(frames.length);
  });
});

/**
 * The captain's `data/loom-scope/decision-mic-revocation.md`, in full.
 *
 * > *"stop recording and tell the user to re-grant"*
 *
 * Three things have to be true together and none of them was: the recording
 * **stops**, the user is told a **permission was revoked** rather than that a device
 * disconnected, and what was already captured **survives and plays**. Before this,
 * the §7.3 re-check covered the screen track only, so a withdrawn Microphone grant
 * took §7.4's webcam path — recorded as `device-lost`, with the recording carrying
 * on.
 *
 * Every one of these fails against that behaviour, and the two CONTROL rows are what
 * stop them from passing for the wrong reason: a build that stopped on *any* audio
 * track ending, or that wrote `permission-revoked` for every one, would pass the
 * first three and fail the controls.
 */
describe('a Microphone grant withdrawn mid-recording (§7.3, decision-mic-revocation)', () => {
  /**
   * Record some screen and some microphone, then have the mic track end on its own.
   *
   * `audioEnded` is the message the capture page sends the instant a track stops —
   * not the end report, which arrives only once the recording is already over and
   * therefore cannot stop anything.
   */
  async function recordThenMicEnds(
    cause: 'track-ended' | 'encoder-failed' = 'track-ended',
  ): Promise<{ id: RecordingId; contents: FakeContents; frames: FixtureFrame[] }> {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();
    const frames = fixture.frames.slice(0, 10);
    emit(CHANNEL.captureMeta, contents, metaMessage());
    for (const frame of frames) emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    emit(CHANNEL.captureMeta, contents, audioMetaMessage('mic'));
    await untilAudioPartOpen(id, 'mic');
    for (let i = 0; i < 8; i++) emit(CHANNEL.captureChunk, contents, audioChunkMessage('mic', i));
    await until(() => store.mediaFrameCount(id, 'mic') >= 8, 'the mic frames');
    await until(() => store.mediaFrameCount(id, 'screen') >= 9, 'the screen frames');

    emit(CHANNEL.captureAudioEnded, contents, {
      track: 'mic',
      part: 0,
      cause,
      detail: 'the mic track ended',
    });
    return { id, contents, frames };
  }

  /** Every `stop` command main has sent the capture page. */
  function stopCommands(contents: FakeContents): unknown[] {
    return contents.sent
      .filter((message) => message.channel === CHANNEL.captureCommand)
      .map((message) => message.payload)
      .filter((payload) => (payload as { kind?: string }).kind === 'stop');
  }

  /** Answer the stop main asked for, exactly as the capture page would. */
  function answerStop(contents: FakeContents, frames: FixtureFrame[]): void {
    const mic = audioReport('mic', 8);
    // The renderer no longer names a reason — that is the fix, at its source. What it
    // reports is that the track ended early; main is what decides why.
    mic['endedEarly'] = true;
    emit(CHANNEL.captureEnded, contents, endedMessage(frames, [mic]));
  }

  it('stops the recording, rather than carrying on without the microphone', async () => {
    harness.micAccess = 'denied';
    const { id, contents, frames } = await recordThenMicEnds();

    await until(
      () => stopCommands(contents).length === 1,
      'main to stop the capture page after the grant went away',
    );
    answerStop(contents, frames);
    // Finalized, not failed and not discarded: the bundle reaches `editable`, which
    // is the state a recording the user pressed stop on reaches.
    await untilState(id, 'editable');
    await until(() => lastStatus(contents).phase === 'idle', 'the recorder to come to rest');
  });

  it('names the cause as a revoked permission, in recording.json and to the user', async () => {
    harness.micAccess = 'denied';
    const { id, contents, frames } = await recordThenMicEnds();
    await until(() => stopCommands(contents).length === 1, 'the stop');
    answerStop(contents, frames);
    await untilState(id, 'editable');
    await until(() => lastStatus(contents).phase === 'idle', 'the recorder to come to rest');

    // On disk: the word §2.3 has for this, and not the one an unplugged webcam gets.
    const doc = await readRecordingDoc(id);
    expect(validateRecordingDoc(doc).ok).toBe(true);
    const mic = doc.tracks.mic?.parts[0];
    expect(mic?.endedEarly).toBe(true);
    expect(mic?.endReason).toBe('permission-revoked');

    // And to the user: a notice about a permission, carrying the recording it
    // stopped — not the error line, because the recording did not fail.
    const status = lastStatus(contents);
    expect(status.revoked?.kind).toBe('microphone');
    expect(status.revoked?.recordingId).toBe(id);
    expect(status.revoked?.recordedSec).toBeGreaterThan(0);
    expect(status.error).toBeNull();
    expect(status.phase).toBe('idle');
  });

  it('keeps what was already captured, and it plays', async () => {
    // The point with teeth: decision 5 deletes raw sources after an export, so a
    // partial recording thrown away at stop time is gone for good.
    harness.micAccess = 'denied';
    const { id, contents, frames } = await recordThenMicEnds();
    await until(() => stopCommands(contents).length === 1, 'the stop');
    answerStop(contents, frames);
    await untilState(id, 'editable');

    const doc = await readRecordingDoc(id);
    const screen = doc.tracks.screen?.parts[0];
    expect(screen?.frameCount).toBe(frames.length);
    expect(doc.tracks.mic?.parts[0]?.durationSec).toBeGreaterThan(0);

    const dir = await store.directoryFor(id);
    const index = validateFrameIndexDoc(
      JSON.parse(await readFile(join(dir, screen?.index ?? ''), 'utf8')),
    );
    expect(index.ok).toBe(true);

    // Playable according to AVFoundation rather than according to our own reader —
    // the same standard `capture-crash.test.ts` holds a recovered recording to.
    const played = playsUnderAVFoundation(
      join(dir, screen?.file ?? ''),
      join(scratch, 'revoked-passthrough.mov'),
    );
    expect(played.ok, `avconvert refused the surviving media:\n${played.log}`).toBe(true);
  });

  it('CONTROL: a microphone that merely went away does not stop the recording', async () => {
    // The §7.4 path, which phase 4 built and this change must not have touched: a
    // device that vanished may come back and is worth waiting for. Without this row
    // a build that stopped on *any* audio track ending would pass everything above.
    harness.micAccess = 'granted';
    const { id, contents, frames } = await recordThenMicEnds();
    await tick();
    await tick();
    expect(stopCommands(contents), 'a lost device must not end the recording').toHaveLength(0);
    expect(lastStatus(contents).phase).toBe('recording');
    expect(lastStatus(contents).revoked).toBeNull();

    // ...and it is still recording the screen, after the microphone has gone.
    for (const frame of fixture.frames.slice(10, 16)) {
      emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    }
    await until(
      () => store.mediaFrameCount(id, 'screen') >= 15,
      'the screen to still be recording',
    );

    const stopping = recorder.stop();
    answerStop(contents, [...frames, ...fixture.frames.slice(10, 16)]);
    await stopping;

    const doc = await readRecordingDoc(id);
    expect(doc.tracks.mic?.parts[0]?.endReason).toBe('device-lost');
    expect(doc.tracks.screen?.parts[0]?.frameCount).toBe(16);
  });

  it('CONTROL: an encoder that failed is not a revoked permission', async () => {
    // `encoder-failed` is not a device and not a grant, whatever TCC happens to say
    // at that moment. A build that re-read TCC for every audio-track end would stop
    // the recording here — and would be wrong about the cause as well.
    harness.micAccess = 'denied';
    const { id, contents, frames } = await recordThenMicEnds('encoder-failed');
    await tick();
    await tick();
    expect(stopCommands(contents)).toHaveLength(0);

    const stopping = recorder.stop();
    answerStop(contents, frames);
    await stopping;

    expect((await readRecordingDoc(id)).tracks.mic?.parts[0]?.endReason).toBe('crash');
  });

  it('classifies a track that ended without a report, at finalize', async () => {
    // The capture page can end a track inside its own stop — an encoder that errors
    // during the flush — and the mid-recording message is deliberately not sent then.
    // §7.3's answer must not be "no reason at all": the same read is taken at
    // finalize, the way `endReasonFor` already does it for the screen.
    harness.micAccess = 'denied';
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();
    const frames = fixture.frames.slice(0, 10);
    emit(CHANNEL.captureMeta, contents, metaMessage());
    for (const frame of frames) emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    emit(CHANNEL.captureMeta, contents, audioMetaMessage('mic'));
    await untilAudioPartOpen(id, 'mic');
    for (let i = 0; i < 8; i++) emit(CHANNEL.captureChunk, contents, audioChunkMessage('mic', i));
    await until(() => store.mediaFrameCount(id, 'mic') >= 8, 'the mic frames');

    const stopping = recorder.stop();
    answerStop(contents, frames);
    await stopping;

    expect((await readRecordingDoc(id)).tracks.mic?.parts[0]?.endReason).toBe('permission-revoked');
  });

  it('keeps the revoked verdict when the capture page never answers the stop', async () => {
    // The evidence is perishable and the report is not what carries it: the read that
    // said "revoked" was taken while the track was stopping, minutes before finalize.
    // A capture renderer that dies inside its own stop leaves no measurements at all,
    // and the part is then described from the bytes on disk — which must not turn the
    // answer main already has into `crash`, the word for a track nobody classified.
    harness.micAccess = 'denied';
    const { id, contents } = await recordThenMicEnds();
    await until(() => stopCommands(contents).length === 1, 'the stop');

    // No `captureEnded` ever arrives, so the stop times out and finalize runs on a
    // null report.
    await untilState(id, 'editable', 2_000);

    const doc = await readRecordingDoc(id);
    expect(validateRecordingDoc(doc).ok).toBe(true);
    const mic = doc.tracks.mic?.parts[0];
    expect(mic, 'the .m4a on disk was left referenced by nothing').toBeDefined();
    expect(mic?.durationSec).toBeGreaterThan(0);
    expect(mic?.endedEarly).toBe(true);
    expect(mic?.endReason).toBe('permission-revoked');
    // And the notice outlived the recording it stopped, which is when the user reads it.
    expect(lastStatus(contents).revoked?.kind).toBe('microphone');
  });

  it('refuses a mic end report from a recording that opened no microphone', async () => {
    // The only message a renderer can send that ends a recording, so it is checked
    // against what the recording actually asked for.
    harness.micAccess = 'denied';
    const id = await recorder.start({ fps: fixture.fps, micDeviceId: null });
    const contents = captureContents();
    emit(CHANNEL.captureMeta, contents, metaMessage());
    for (const frame of fixture.frames.slice(0, 6)) {
      emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    }
    await until(() => store.mediaFrameCount(id, 'screen') >= 5, 'the frames');

    emit(CHANNEL.captureAudioEnded, contents, { track: 'mic', part: 0, cause: 'track-ended' });
    // ...and a malformed one, which must not throw out of the listener either.
    expect(() => {
      emit(CHANNEL.captureAudioEnded, contents, { track: 'nope', cause: 'track-ended' });
    }).not.toThrow();
    await tick();
    await tick();

    expect(stopCommands(contents)).toHaveLength(0);
    expect(lastStatus(contents).phase).toBe('recording');

    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, endedMessage(fixture.frames.slice(0, 6)));
    await stopping;
  });
});

describe('the options a renderer may ask for', () => {
  /** Start from `requested`, read what main told the capture page, then fail it out. */
  async function optionsSentFor(requested: unknown): Promise<Record<string, unknown>> {
    const hud = windows.show('recorder-hud') as unknown as FakeWindow;
    const started = (await invoke(CHANNEL.recorderStart, hud.webContents, requested)) as {
      recordingId: RecordingId;
    };
    const contents = captureContents();
    const options = startedOptions(contents);
    emit(CHANNEL.captureEnded, contents, {
      reason: 'error',
      endedAtUs: null,
      framesEncoded: 0,
      framesDropped: 0,
    });
    await untilState(started.recordingId, 'failed');
    return options;
  }

  it('carries the audio knobs through to the capture page', async () => {
    expect(
      await optionsSentFor({
        systemAudio: false,
        micDeviceId: null,
        audioBitrate: 96_000,
        micVoiceProcessing: true,
      }),
    ).toMatchObject({
      systemAudio: false,
      micDeviceId: null,
      audioBitrate: 96_000,
      micVoiceProcessing: true,
    });
  });

  it('falls back to the defaults for values it cannot trust', async () => {
    expect(
      await optionsSentFor({
        systemAudio: 0,
        micDeviceId: 42,
        audioBitrate: 9_000_000,
        micVoiceProcessing: 'yes',
      }),
    ).toMatchObject({
      systemAudio: DEFAULT_CAPTURE_OPTIONS.systemAudio,
      micDeviceId: DEFAULT_CAPTURE_OPTIONS.micDeviceId,
      audioBitrate: DEFAULT_CAPTURE_OPTIONS.audioBitrate,
      micVoiceProcessing: DEFAULT_CAPTURE_OPTIONS.micVoiceProcessing,
    });
  });
});

describe('who may drive a recording', () => {
  it('refuses recorder.start and recorder.stop from a window that is not a control surface', async () => {
    const capture = windows.show('capture') as unknown as FakeWindow;
    await expect(invoke(CHANNEL.recorderStart, capture.webContents, {})).rejects.toThrow(
      /may not drive a recording/,
    );
    await expect(invoke(CHANNEL.recorderStop, capture.webContents)).rejects.toThrow(
      /may not drive a recording/,
    );
  });

  it('accepts them from the HUD and from the library', async () => {
    for (const role of ['recorder-hud', 'library'] as const) {
      const window = windows.show(role) as unknown as FakeWindow;
      // A stop with nothing recording is a no-op; what is asserted here is that it
      // got past the sender check at all.
      await expect(invoke(CHANNEL.recorderStop, window.webContents)).resolves.toBeUndefined();
    }
  });
});

/**
 * Architecture report §7.3: *"Distinguish revocation from a normal stop by
 * re-checking `getMediaAccessStatus('screen')`."*
 *
 * Phase 1 could not, and said so in `endReasonFor`: a `source-ended` was recorded as
 * `permission-revoked` because that was "the more useful of the two guesses". It is
 * also the shape macOS's own "Stop sharing" control and a disconnected display take,
 * and the difference matters — one of them is worth telling the user to go and fix a
 * permission for, and the other is not.
 *
 * Both branches are asserted, because a test for only the revoked case would pass
 * against the phase 1 code that always guessed revoked.
 */
describe('a source that ends by itself (§7.3)', () => {
  async function recordThenEndSource(): Promise<RecordingDoc> {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();
    emit(CHANNEL.captureMeta, contents, metaMessage());
    for (const frame of fixture.frames.slice(0, 10)) {
      emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    }
    // The writer holds one sample so every duration is measured against the next
    // frame's timestamp, so ten chunks is nine frames on the file until finalize
    // flushes the last one.
    await until(() => store.mediaFrameCount(id, 'screen') >= 9, 'the frames to be written');

    // Not a stop: the track ended on its own, which is what both a revoked grant and
    // a "Stop sharing" click look like from in here.
    emit(CHANNEL.captureEnded, contents, {
      reason: 'source-ended',
      endedAtUs: fixture.frames[9]?.timestampUs ?? 0,
      framesEncoded: 10,
      framesDropped: 0,
    });
    await untilState(id, 'editable');

    const dir = await store.directoryFor(id);
    const raw: unknown = JSON.parse(await readFile(join(dir, 'recording.json'), 'utf8'));
    const result = validateRecordingDoc(raw);
    if (!result.ok) throw new Error('recording.json did not validate');
    return result.value;
  }

  it('calls it permission-revoked when the grant is gone', async () => {
    harness.screenAccess = 'denied';
    const doc = await recordThenEndSource();
    const part = doc.tracks.screen?.parts[0];
    expect(part?.endedEarly).toBe(true);
    expect(part?.endReason).toBe('permission-revoked');
  });

  it('CONTROL: calls it device-lost when the grant is still there', async () => {
    // Without this the test above would pass against the phase 1 code, which
    // recorded `permission-revoked` for every `source-ended` regardless.
    harness.screenAccess = 'granted';
    const doc = await recordThenEndSource();
    const part = doc.tracks.screen?.parts[0];
    expect(part?.endedEarly).toBe(true);
    expect(part?.endReason).toBe('device-lost');
  });

  it('keeps the footage either way, and never discards it', async () => {
    // §7.3: "Finalize what we have — never discard."
    harness.screenAccess = 'denied';
    const doc = await recordThenEndSource();
    expect(doc.tracks.screen?.parts[0]?.frameCount).toBe(10);
  });
});
