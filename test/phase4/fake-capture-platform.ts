/**
 * The platform the phase 4 gate runs the real capture page against.
 *
 * Everything here is a *device*: a camera, a microphone, a display, a clock and
 * the two WebCodecs encoders. Nothing here is capture logic. The point of the gate
 * is that `apps/renderer/src/capture/webcam.ts`, `apps/renderer/src/capture/main.ts`
 * and `apps/main/src/recorder/session.ts` are the shipping files, unmocked, and
 * that the camera going away is a **real `ended` event on a real `EventTarget`**
 * rather than a call the test makes on their behalf.
 *
 * ## Why the clock is fake, and why that is not cheating
 *
 * `TrackEpochEstimator` relates two tracks' epochs through the one clock both are
 * observed on: `performance.now()` at the moment a sample arrives. Under a test
 * that feeds a minute of frames in a millisecond, that clock says every frame
 * arrived at once, and the offsets it estimates are a measure of how fast the loop
 * ran. So the clock is driven instead — set to the instant each frame would really
 * have been delivered — and the production estimator runs on it unmodified. What is
 * controlled is when the frames arrive; what is measured is still what the code
 * under test makes of that.
 *
 * The camera's timestamps are deliberately on a **different epoch** from the
 * screen's — the machine-uptime epoch `scripts/smoke-capture.mjs` actually measured
 * — because a webcam that is correctly placed only when both tracks happen to share
 * an epoch is a webcam that will be two and a half million seconds out on the
 * captain's machine.
 */

import {
  loadEncodedFixture,
  type EncodedFixture,
} from '../../packages/mux/test/helpers/fixture.ts';

export const fixture: EncodedFixture = loadEncodedFixture();

/** Microseconds per frame at the fixture's rate. */
export const FRAME_US = Math.round(1_000_000 / fixture.fps);

/**
 * The camera's clock origin.
 *
 * Not a round number and not zero: measured on this project's own machine, a
 * capture whose video frames were timestamped from zero produced audio buffers
 * timestamped at 2,678,930 s — the machine's uptime (see the sharp edges in
 * `CLAUDE.md`). A second video device gets its own epoch for the same reason, and
 * a gate that used one epoch everywhere would pass a build that ignored epochs.
 */
export const WEBCAM_EPOCH_US = 2_678_930_000_000;

/** The microphone's clock origin, different again for the same reason. */
export const MIC_EPOCH_US = 2_678_930_500_000;

/**
 * How long the platform takes to deliver a sample, on the shared clock.
 *
 * The same for every track, so the epoch estimates differ by exactly the tracks'
 * epochs and nothing else — which is what lets the gate assert an exact
 * `startTimeSec` rather than a tolerance.
 */
export const DELIVERY_LATENCY_US = 5_000;

/** An AAC-LC 48 kHz stereo AudioSpecificConfig, which is all the writer needs. */
export const AUDIO_ASC = new Uint8Array([0x11, 0x90]);
export const AUDIO_RATE = 48_000;
export const AAC_FRAME_SAMPLES = 1024;
export const AAC_FRAME_US = Math.round((AAC_FRAME_SAMPLES * 1_000_000) / AUDIO_RATE);

/**
 * The clock `performance.now()` reads, in milliseconds.
 *
 * Driven by whoever is feeding frames, so a sample "arrives" at the instant it
 * would really have arrived rather than at the instant the loop got to it.
 */
export const clock = { ms: 0 };

export function setClockUs(us: number): void {
  clock.ms = us / 1000;
}

// ------------------------------------------------------------------- devices

/**
 * A `MediaStreamTrack` that can really end.
 *
 * `EventTarget` rather than a stub with a listener array: §7.4 step 1 is an
 * `ended` event, and a gate that called the handler directly would prove the
 * handler works while saying nothing about whether it is attached.
 */
export class FakeTrack extends EventTarget {
  stopped = false;
  constructor(
    readonly kind: 'video' | 'audio',
    readonly label: string,
    private readonly settings: Record<string, unknown>,
  ) {
    super();
  }

  getSettings(): Record<string, unknown> {
    return this.settings;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Unplug the device. This is the event macOS delivers on a real disconnect. */
  unplug(): void {
    this.stopped = true;
    this.dispatchEvent(new Event('ended'));
  }
}

export class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'video');
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
}

/** A frame the capture page can encode and must close. */
export class FakeVideoFrame {
  closed = false;
  constructor(
    readonly timestamp: number,
    readonly displayWidth: number,
    readonly displayHeight: number,
  ) {}
  close(): void {
    this.closed = true;
  }
}

export class FakeAudioData {
  closed = false;
  constructor(
    readonly timestamp: number,
    readonly numberOfFrames: number,
  ) {}
  close(): void {
    this.closed = true;
  }
}

/**
 * A source the test pushes samples into, and the capture page reads out of.
 *
 * One per opened device. `MediaStreamTrackProcessor` is constructed by the code
 * under test, so the queue has to be findable from the track it was given.
 */
class Source<T> {
  private readonly queue: T[] = [];
  private waiting: ((value: T | null) => void) | null = null;
  private done = false;

  push(value: T): void {
    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      waiting(value);
      return;
    }
    this.queue.push(value);
  }

  end(): void {
    this.done = true;
    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      waiting(null);
    }
  }

  next(): Promise<T | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.done) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

const sources = new WeakMap<FakeTrack, Source<unknown>>();

export function sourceFor<T>(track: FakeTrack): Source<T> {
  let source = sources.get(track) as Source<T> | undefined;
  if (source === undefined) {
    source = new Source<T>();
    sources.set(track, source as Source<unknown>);
  }
  return source;
}

export class FakeProcessor<T> {
  readonly readable: ReadableStream<T>;
  constructor(options: { track: FakeTrack }) {
    const source = sourceFor<T>(options.track);
    this.readable = new ReadableStream<T>({
      async pull(controller) {
        const value = await source.next();
        if (value === null) controller.close();
        else controller.enqueue(value);
      },
    });
  }
}

// ------------------------------------------------------------------ encoders

/**
 * A `VideoEncoder` that emits real H.264 from the committed fixture.
 *
 * Real bytes rather than a synthetic pattern, because what they end up in is a
 * real fragmented MP4 written by the shipping writer, and the gate reads the
 * frame counts back out of the sidecar it produced. One encoded frame per input
 * frame, carrying the input's timestamp: that is what a `realtime` H.264 encoder
 * with no B-frames does, which is exactly what the capture page configures.
 */
export class FakeVideoEncoder {
  static isConfigSupported(config: unknown): Promise<unknown> {
    return Promise.resolve({ supported: true, config });
  }
  static readonly created: FakeVideoEncoder[] = [];

  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  encodeQueueSize = 0;
  private emitted = 0;
  private metaSent = false;
  private config: VideoEncoderConfig | null = null;

  constructor(private readonly init: VideoEncoderInit) {
    FakeVideoEncoder.created.push(this);
  }

  configure(config: VideoEncoderConfig): void {
    this.state = 'configured';
    this.config = config;
  }

  encode(frame: FakeVideoFrame, options?: { keyFrame?: boolean }): void {
    const source = fixture.frames[this.emitted % fixture.frames.length];
    if (source === undefined) throw new Error('the fixture carried no frames');
    this.emitted += 1;
    // The first chunk of a part must be a keyframe, and every chunk the page asked
    // to be one must be one — that is the contract the writer's index rests on.
    const wantKey = options?.keyFrame === true || !this.metaSent;
    const bytes = wantKey ? keyframeBytes() : source.data;
    const chunk = {
      type: wantKey ? ('key' as const) : ('delta' as const),
      timestamp: frame.timestamp,
      duration: null,
      byteLength: bytes.byteLength,
      copyTo: (target: Uint8Array) => {
        target.set(bytes);
      },
    };
    const metadata = this.metaSent
      ? undefined
      : {
          decoderConfig: {
            codec: this.config?.codec ?? 'avc1.64000d',
            codedWidth: this.config?.width ?? fixture.width,
            codedHeight: this.config?.height ?? fixture.height,
            description: fixture.avcC,
          },
        };
    this.metaSent = true;
    this.init.output(chunk, metadata);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.state = 'closed';
  }
}

/** The fixture's first keyframe, which every part has to begin with. */
function keyframeBytes(): Uint8Array {
  const key = fixture.frames.find((frame) => frame.isKey);
  if (key === undefined) throw new Error('the fixture carried no keyframe');
  return key.data;
}

/** An `AudioEncoder` that emits one AAC frame per buffer. */
export class FakeAudioEncoder {
  static isConfigSupported(config: unknown): Promise<unknown> {
    return Promise.resolve({ supported: true, config });
  }
  static readonly created: FakeAudioEncoder[] = [];

  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  encodeQueueSize = 0;
  private emitted = 0;
  private config: AudioEncoderConfig | null = null;

  constructor(private readonly init: AudioEncoderInit) {
    FakeAudioEncoder.created.push(this);
  }

  configure(config: AudioEncoderConfig): void {
    this.state = 'configured';
    this.config = config;
  }

  encode(data: FakeAudioData): void {
    const index = this.emitted;
    this.emitted += 1;
    const bytes = new Uint8Array(64).fill((index % 251) + 1);
    const chunk = {
      type: 'key' as const,
      timestamp: data.timestamp,
      duration: AAC_FRAME_US,
      byteLength: bytes.byteLength,
      copyTo: (target: Uint8Array) => {
        target.set(bytes);
      },
    };
    const metadata =
      index === 0
        ? {
            decoderConfig: {
              codec: this.config?.codec ?? 'mp4a.40.2',
              sampleRate: this.config?.sampleRate ?? AUDIO_RATE,
              numberOfChannels: this.config?.numberOfChannels ?? 1,
              description: AUDIO_ASC,
            },
          }
        : undefined;
    this.init.output(chunk, metadata);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.state = 'closed';
  }
}

// ------------------------------------------------------------------- wiring

export interface Devices {
  /** Cameras the platform will hand out, by device id. */
  cameras: Map<string, FakeTrack>;
  /** Cameras currently enumerable — a device that is unplugged leaves this. */
  present: Set<string>;
  display: FakeStream;
  mic: FakeStream;
  /** Fires `devicechange`, which is how §7.4 step 4 learns the camera is back. */
  mediaDevices: EventTarget;
  /** Every camera stream handed out, so a leaked device is visible. */
  handedOut: FakeStream[];
}

export function newDevices(): Devices {
  return {
    cameras: new Map(),
    present: new Set(),
    display: new FakeStream([new FakeTrack('video', 'Built-in Display', { deviceId: 'screen-1' })]),
    mic: new FakeStream([
      new FakeTrack('audio', 'MacBook Pro Microphone', {
        deviceId: 'mic-1',
        sampleRate: AUDIO_RATE,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    ]),
    mediaDevices: new EventTarget(),
    handedOut: [],
  };
}

/**
 * A camera the platform can hand out, and hand out again after an unplug.
 *
 * A reconnected camera is a **new** `MediaStreamTrack` with the same `deviceId`,
 * because that is what `getUserMedia` returns after a device comes back; the old
 * one stays ended forever. §7.4 step 4 matches on the id, and this is the shape
 * that makes that matching mean something.
 */
export function plugInCamera(devices: Devices, deviceId: string, label: string): FakeTrack {
  const track = new FakeTrack('video', label, { deviceId });
  devices.cameras.set(deviceId, track);
  devices.present.add(deviceId);
  return track;
}

export function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

export const FAKE_GLOBALS = [
  'window',
  'navigator',
  'performance',
  'MediaStreamTrackProcessor',
  'VideoEncoder',
  'AudioEncoder',
] as const;

export function clearGlobals(): void {
  for (const name of FAKE_GLOBALS) Reflect.deleteProperty(globalThis, name);
}

/**
 * Install the platform the capture page will run against.
 *
 * `getUserMedia` is one function serving two devices, told apart by the
 * constraints it is handed — which is how the real one works, and which is why the
 * camera and the microphone can be opened, refused and lost independently.
 */
export function installPlatform(devices: Devices, capture: unknown): void {
  define('window', { loom: { capture } });
  define('performance', { now: () => clock.ms });
  define('MediaStreamTrackProcessor', FakeProcessor);
  define('VideoEncoder', FakeVideoEncoder);
  define('AudioEncoder', FakeAudioEncoder);
  define('navigator', {
    mediaDevices: {
      getDisplayMedia: () => Promise.resolve(devices.display),
      getUserMedia: (constraints: { video?: unknown; audio?: unknown }) => {
        if (constraints.video !== undefined) return openCamera(devices, constraints.video);
        return Promise.resolve(devices.mic);
      },
      enumerateDevices: () =>
        Promise.resolve([...devices.present].map((deviceId) => ({ kind: 'videoinput', deviceId }))),
      addEventListener: (type: string, listener: EventListener) => {
        devices.mediaDevices.addEventListener(type, listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        devices.mediaDevices.removeEventListener(type, listener);
      },
    },
  });
}

function openCamera(devices: Devices, video: unknown): Promise<FakeStream> {
  const wanted = requestedDeviceId(video);
  const id = wanted ?? [...devices.present][0] ?? null;
  if (id === null || !devices.present.has(id)) {
    return Promise.reject(new Error('NotFoundError: requested device not found'));
  }
  const track = devices.cameras.get(id);
  if (track === undefined || track.stopped) {
    return Promise.reject(new Error('NotReadableError: the camera could not be started'));
  }
  const stream = new FakeStream([track]);
  devices.handedOut.push(stream);
  return Promise.resolve(stream);
}

function requestedDeviceId(video: unknown): string | null {
  if (video === null || typeof video !== 'object') return null;
  const constraint = (video as { deviceId?: unknown }).deviceId;
  if (constraint === null || typeof constraint !== 'object') return null;
  const exact = (constraint as { exact?: unknown }).exact;
  return typeof exact === 'string' ? exact : null;
}

/** Let every pending microtask and timer turn run. */
export async function settled(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
