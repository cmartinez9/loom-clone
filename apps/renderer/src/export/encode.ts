/**
 * The two encoders an export drives, and the backpressure that keeps them from
 * eating the machine.
 *
 * §5.1: *"Compose with our WebGL2 compositor → encode with WebCodecs
 * `VideoEncoder`/`AudioEncoder` (VideoToolbox) → mux with a JavaScript MP4 muxer.
 * Do not bundle ffmpeg."* §5.2 explains what that buys and what it costs; the two
 * decisive properties are **no readback** and **one colour pipeline**, and both are
 * kept here by handing the encoder the canvas rather than an array of pixels.
 *
 * ## `latencyMode: 'realtime'`, deliberately
 *
 * Quality mode lets VideoToolbox reorder frames. A reordered stream needs a `ctts`
 * composition-offset table, `FastStartWriter` writes none, and the failure mode is a
 * file that plays its frames in the wrong order — silently. Realtime mode is
 * therefore not a leftover from the capture path: it is what makes decode order and
 * presentation order the same thing, which is the assumption the muxer is built on
 * and refuses to have violated. Screen content is mostly static and codes into small
 * P-frames regardless; §5.2 already states the rate-control trade this project
 * accepts.
 *
 * ## Backpressure
 *
 * §5.3: `while (encoder.encodeQueueSize > 8) await nextOutput()`. Without it the
 * composite loop runs ahead of a 14 ms-per-frame hardware encoder and the queue is
 * the whole recording in memory. {@link VideoExportEncoder.drain} is that line, and
 * it waits on the *output* callback rather than polling a clock.
 *
 * ## Every wait is bounded, for §10.2's reason
 *
 * Waiting on the output callback is only safe while something is guaranteed to call
 * it. A platform encoder that stops without reporting an error calls neither — the
 * GPU process dying takes VideoToolbox, the `error` callback's mojo pipe and the
 * queue with it — and an unbounded `await` there is §10.2's named symptom exactly:
 * *"an export that hangs at 40% with no error"*. So the backpressure wait and the
 * `flush` both carry a deadline and turn a dead encoder into an
 * {@link ExportEncodeStallError}, the counterpart of the decode side's
 * `ExportStallError`. Nothing about the happy path changes: the bound is a watchdog
 * on a wait for **one** output from a full queue, three orders above what that costs.
 */

/** One encoded sample on its way to main. */
export interface EncodedOutput {
  data: Uint8Array;
  isKey: boolean;
  timestampUs: number;
}

/** The `decoderConfig` an encoder emitted with its first chunk. */
export interface EmittedDecoderConfig {
  codec: string;
  codedWidth?: number;
  codedHeight?: number;
  sampleRate?: number;
  numberOfChannels?: number;
  description?: Uint8Array;
}

/** §5.3's queue bound. */
const MAX_QUEUE = 8;

/**
 * §10.2's watchdog, applied to the encoder — `ExportRenderLoop`'s `STALL_TIMEOUT_MS`
 * for the other end of the pipe.
 *
 * It bounds a wait for **one** encoded chunk out of a queue that is already full, and
 * the flush of at most {@link MAX_QUEUE} more. Software H.264 at 720p costs tens of
 * milliseconds a frame on the slowest machine this runs on, so this is three orders
 * of magnitude of slack: it can only be reached by an encoder that has stopped.
 */
export const ENCODE_STALL_TIMEOUT_MS = 30_000;

/** A `VideoEncoder`/`AudioEncoder` that stopped without saying so. */
export class ExportEncodeStallError extends Error {
  constructor(what: string, forMs: number) {
    super(
      `the export waited ${Math.round(forMs)}ms for the ${what} encoder, which produced ` +
        'neither a chunk nor an error. Encoding has stopped (architecture report §10.2).',
    );
    this.name = 'ExportEncodeStallError';
  }
}

/**
 * Wait for the next output callback, or give up loudly.
 *
 * The waiter is removed from the list on a timeout, so a `wake` that arrives after
 * the deadline does not call a settled promise's resolver.
 */
function nextOutputWithin(waiters: (() => void)[], what: string): Promise<void> {
  return new Promise((done, fail) => {
    const waiter = (): void => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      fail(new ExportEncodeStallError(what, ENCODE_STALL_TIMEOUT_MS));
    }, ENCODE_STALL_TIMEOUT_MS);
    waiters.push(waiter);
  });
}

/**
 * `flush()`, bounded.
 *
 * The losing promise stays handled by the race, so an encoder that reports its
 * failure late does not become an unhandled rejection minutes after the job ended.
 */
async function flushWithin(flush: Promise<void>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      flush,
      new Promise<never>((_done, fail) => {
        timer = setTimeout(() => {
          fail(new ExportEncodeStallError(what, ENCODE_STALL_TIMEOUT_MS));
        }, ENCODE_STALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Codec strings tried in order, most capable first.
 *
 * High 5.2 covers everything up to 4K60; the two below it exist because
 * `isConfigSupported` is the only honest way to find out what a machine will do, and
 * an export that refuses to start is worse than one at Main profile.
 */
const VIDEO_CODECS = ['avc1.640034', 'avc1.4d0034', 'avc1.42e034'] as const;

const ACCELERATION = ['prefer-hardware', 'no-preference', 'prefer-software'] as const;

export interface VideoEncoderChoice {
  config: VideoEncoderConfig;
}

/**
 * The first configuration this machine actually supports.
 *
 * Asked rather than assumed, because §5.2's stated risk is *"we are exposed to
 * Chromium's implementation across Electron upgrades"* and the mitigation it names
 * is running the `isConfigSupported` matrix.
 */
export async function chooseVideoEncoderConfig(spec: {
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
}): Promise<VideoEncoderConfig> {
  for (const codec of VIDEO_CODECS) {
    for (const hardwareAcceleration of ACCELERATION) {
      const config: VideoEncoderConfig = {
        codec,
        width: spec.width,
        height: spec.height,
        bitrate: spec.bitrate,
        framerate: spec.framerate,
        latencyMode: 'realtime',
        hardwareAcceleration,
        avc: { format: 'avc' },
      };
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported === true) return config;
    }
  }
  throw new Error(
    `no VideoEncoder configuration supports ${spec.width}x${spec.height} H.264 on this machine`,
  );
}

export interface VideoExportEncoderOptions {
  width: number;
  height: number;
  bitrate: number;
  fps: number;
  onChunk: (chunk: EncodedOutput) => void;
  onConfig: (config: EmittedDecoderConfig) => void;
}

export class VideoExportEncoder {
  readonly config: VideoEncoderConfig;
  readonly #encoder: VideoEncoder;
  readonly #options: VideoExportEncoderOptions;
  #sawConfig = false;
  #count = 0;
  #error: Error | null = null;
  readonly #waiters: (() => void)[] = [];

  private constructor(config: VideoEncoderConfig, options: VideoExportEncoderOptions) {
    this.config = config;
    this.#options = options;
    this.#encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        this.#onChunk(chunk, metadata);
      },
      error: (error: DOMException) => {
        this.#error = error instanceof Error ? error : new Error(String(error));
        this.#wake();
      },
    });
    this.#encoder.configure(config);
  }

  static async open(options: VideoExportEncoderOptions): Promise<VideoExportEncoder> {
    return new VideoExportEncoder(
      await chooseVideoEncoderConfig({
        width: options.width,
        height: options.height,
        bitrate: options.bitrate,
        framerate: options.fps,
      }),
      options,
    );
  }

  get encodedCount(): number {
    return this.#count;
  }

  /**
   * Encode one composited frame straight off the canvas.
   *
   * `close()` in a `finally`, never in a happy path — §10.2's rule, and the reason
   * an export that throws mid-frame does not also leak the frame it threw on.
   */
  encode(canvas: CanvasImageSource, timestampUs: number, isKey: boolean, durationUs: number): void {
    this.#raise();
    const frame = new VideoFrame(canvas, { timestamp: timestampUs, duration: durationUs });
    try {
      this.#encoder.encode(frame, { keyFrame: isKey });
    } finally {
      frame.close();
    }
  }

  /** §5.3's backpressure line. */
  async drain(): Promise<void> {
    while (this.#encoder.encodeQueueSize > MAX_QUEUE) {
      this.#raise();
      await this.#nextOutput();
    }
    this.#raise();
  }

  /** Flush the encoder and close it. Every queued frame comes out first. */
  async close(): Promise<void> {
    try {
      if (this.#encoder.state === 'configured') {
        await flushWithin(this.#encoder.flush(), 'video');
      }
    } finally {
      if (this.#encoder.state !== 'closed') this.#encoder.close();
      this.#wake();
    }
    this.#raise();
  }

  #onChunk(chunk: EncodedVideoChunk, metadata: EncodedVideoChunkMetadata | undefined): void {
    const emitted = metadata?.decoderConfig;
    if (!this.#sawConfig && emitted !== undefined) {
      this.#sawConfig = true;
      this.#options.onConfig(copyDecoderConfig(emitted));
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.#count += 1;
    this.#options.onChunk({ data, isKey: chunk.type === 'key', timestampUs: chunk.timestamp });
    this.#wake();
  }

  #nextOutput(): Promise<void> {
    return nextOutputWithin(this.#waiters, 'video');
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  #raise(): void {
    const error = this.#error;
    if (error === null) return;
    this.#error = null;
    throw error;
  }
}

export interface AudioExportEncoderOptions {
  sampleRate: number;
  channels: number;
  bitrate: number;
  onChunk: (chunk: EncodedOutput) => void;
  onConfig: (config: EmittedDecoderConfig) => void;
}

export class AudioExportEncoder {
  readonly #encoder: AudioEncoder;
  readonly #options: AudioExportEncoderOptions;
  #sawConfig = false;
  #count = 0;
  #error: Error | null = null;
  readonly #waiters: (() => void)[] = [];

  private constructor(options: AudioExportEncoderOptions, config: AudioEncoderConfig) {
    this.#options = options;
    this.#encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        this.#onChunk(chunk, metadata);
      },
      error: (error: DOMException) => {
        this.#error = error instanceof Error ? error : new Error(String(error));
        this.#wake();
      },
    });
    this.#encoder.configure(config);
  }

  /** `mp4a.40.2` — AAC-LC, §5.3's codec, confirmed supported in Electron 43 (§12.4). */
  static async open(options: AudioExportEncoderOptions): Promise<AudioExportEncoder> {
    const config: AudioEncoderConfig = {
      codec: 'mp4a.40.2',
      sampleRate: options.sampleRate,
      numberOfChannels: options.channels,
      bitrate: options.bitrate,
    };
    const support = await AudioEncoder.isConfigSupported(config);
    if (support.supported !== true) {
      throw new Error(
        `this machine will not encode AAC-LC at ${options.sampleRate} Hz, ` +
          `${options.channels} channels`,
      );
    }
    return new AudioExportEncoder(options, config);
  }

  get encodedCount(): number {
    return this.#count;
  }

  /** Encode one planar-f32 block. The planes are reused by the caller, so they are copied. */
  encode(channels: readonly Float32Array[], timestampUs: number): void {
    this.#raise();
    const frames = channels[0]?.length ?? 0;
    const packed = new Float32Array(frames * channels.length);
    for (const [index, plane] of channels.entries()) packed.set(plane, index * frames);
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: this.#options.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels.length,
      timestamp: timestampUs,
      data: packed,
    });
    try {
      this.#encoder.encode(data);
    } finally {
      data.close();
    }
  }

  async drain(): Promise<void> {
    while (this.#encoder.encodeQueueSize > MAX_QUEUE) {
      this.#raise();
      await nextOutputWithin(this.#waiters, 'audio');
    }
    this.#raise();
  }

  async close(): Promise<void> {
    try {
      if (this.#encoder.state === 'configured') {
        await flushWithin(this.#encoder.flush(), 'audio');
      }
    } finally {
      if (this.#encoder.state !== 'closed') this.#encoder.close();
      this.#wake();
    }
    this.#raise();
  }

  #onChunk(chunk: EncodedAudioChunk, metadata: EncodedAudioChunkMetadata | undefined): void {
    const emitted = metadata?.decoderConfig;
    if (!this.#sawConfig && emitted !== undefined) {
      this.#sawConfig = true;
      this.#options.onConfig(copyDecoderConfig(emitted));
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.#count += 1;
    this.#options.onChunk({ data, isKey: true, timestampUs: chunk.timestamp });
    this.#wake();
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  #raise(): void {
    const error = this.#error;
    if (error === null) return;
    this.#error = null;
    throw error;
  }
}

/**
 * Copy an encoder's `decoderConfig` out of the callback.
 *
 * The platform's `description` buffer is not guaranteed to outlive the callback, and
 * this config becomes the `moov` in another process minutes later.
 */
function copyDecoderConfig(source: VideoDecoderConfig | AudioDecoderConfig): EmittedDecoderConfig {
  const video = source as VideoDecoderConfig;
  const audio = source as AudioDecoderConfig;
  const description = source.description;
  return {
    codec: source.codec,
    ...(video.codedWidth === undefined ? {} : { codedWidth: video.codedWidth }),
    ...(video.codedHeight === undefined ? {} : { codedHeight: video.codedHeight }),
    ...(audio.sampleRate === undefined ? {} : { sampleRate: audio.sampleRate }),
    ...(audio.numberOfChannels === undefined ? {} : { numberOfChannels: audio.numberOfChannels }),
    ...(description === undefined ? {} : { description: copyBuffer(description) }),
  };
}

function copyBuffer(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  }
  return new Uint8Array(new Uint8Array(source as ArrayBuffer));
}
