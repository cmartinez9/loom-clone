/**
 * A synthetic 4K recording, encoded here and now with `VideoEncoder`.
 *
 * ## Why a fixture and not real capture output
 *
 * Phase 6 was started **before** phase 1 and runs in parallel with it, so there is
 * no capture spine to record with. The gate does not need one: what phase 6 must
 * prove is that decode and compositing hold budget at 4K, and an H.264 elementary
 * stream produced by the same WebCodecs encoder the capture spine will use is the
 * same thing to decode as one produced by a screen recording.
 *
 * The fixture conforms to `packages/format`'s declarations and to nothing else:
 * `loom.index/1` (§2.4) for the sidecar, and the `VideoDecoderConfig` that §1.4's
 * `MetaMsg` already carries from the capture renderer to main. It assumes nothing
 * about phase 1's file layout, segment naming or timing source.
 *
 * ## Two deliberate properties
 *
 * **It is genuinely variable-frame-rate.** `rate.mode: "variable"` is not a detail
 * (§2.3): ScreenCaptureKit emits a frame only when the screen changes, measured at
 * 1.4 fps idle and 29.4 fps under animation. This fixture holds a frame for half a
 * second in places, so hold-last-frame is exercised rather than assumed.
 *
 * **Every frame says which frame it is.** A band of black-and-white cells across
 * the top encodes the frame number in binary, large enough to survive both H.264
 * quantisation and the downscale to a 1440p viewport. That is what lets the gate
 * assert the *right* frame was composited, so a preview that renders nothing very
 * quickly cannot pass.
 *
 * ## The one thing the file is not
 *
 * `media/screen.000.h264` is an **elementary stream** — access units concatenated in
 * decode order — not an MP4. That is sufficient and sound because §2.4 makes the
 * index the only thing a reader needs: *"`offsets` lets the editor seek to a
 * keyframe with a single range request and decode forward, without parsing the MP4
 * sample tables at all."* The same offsets point into an MP4's `mdat` unchanged.
 * The file carries a truthful extension rather than a `.mp4` that would not open.
 */

import { currentSchemaId, type FrameIndexDoc } from '@loom/format';

/** The panel §12.4 measured on: 3456×2234, the MacBook Pro's backing pixels. */
export const FIXTURE_SIZE: [number, number] = [3456, 2234];

/** Bits of frame number encoded across the top band. 12 covers 4,095 frames. */
const CODE_BITS = 12;
const CODE_BAND_PX = 220;

export interface GeneratedPart {
  bytes: Uint8Array;
  doc: FrameIndexDoc;
  config: VideoDecoderConfig;
  codec: string;
  frameCount: number;
  durationSec: number;
  longestHoldSec: number;
  encodeMs: number;
  hardwareAcceleration: string;
}

export interface GenerateOptions {
  frameCount?: number;
  gopSize?: number;
  size?: [number, number];
  bitrate?: number;
}

/**
 * Frame timing: ~30 fps with a half-second hold every 17 frames and a slower
 * stretch every 5th. Mirrors `packages/decode`'s synthetic pattern so the Node
 * tests and this gate are exercising the same shape of source.
 */
function gapBefore(i: number): number {
  if (i === 0) return 0;
  if (i % 17 === 0) return 0.5;
  if (i % 5 === 0) return 0.05;
  return 1 / 30;
}

/** Paint frame `i`: a readable frame code, plus enough motion to be worth encoding. */
function paint(
  ctx: OffscreenCanvasRenderingContext2D,
  i: number,
  width: number,
  height: number,
): void {
  ctx.fillStyle = `hsl(${String((i * 37) % 360)}, 55%, 42%)`;
  ctx.fillRect(0, 0, width, height);

  // Something that moves, so inter-frame prediction has real residuals to code and
  // the decode cost is not an artifact of a static image.
  const bandHeight = Math.floor(height / 12);
  for (let band = 0; band < 12; band++) {
    const offset = ((i * 23 + band * 97) % width) - width / 2;
    ctx.fillStyle = band % 2 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
    ctx.fillRect(offset, CODE_BAND_PX + band * bandHeight, width / 2, bandHeight);
  }

  const cellWidth = width / CODE_BITS;
  for (let bit = 0; bit < CODE_BITS; bit++) {
    ctx.fillStyle = (i >> bit) & 1 ? '#ffffff' : '#000000';
    ctx.fillRect(bit * cellWidth, 0, cellWidth, CODE_BAND_PX);
  }
}

/**
 * Where the frame code sits, in normalized source coordinates.
 *
 * The gate samples the centre of each cell after the composite has downscaled a
 * 3456-wide source into a 1440p viewport, so "centre" has to be exact rather than
 * approximate — a cell edge lands on a blended pixel.
 */
export function codeCellCenter(bit: number): [number, number] {
  return [(bit + 0.5) / CODE_BITS, CODE_BAND_PX / 2 / FIXTURE_SIZE[1]];
}

export const CODE_BIT_COUNT = CODE_BITS;

type Acceleration = NonNullable<VideoEncoderConfig['hardwareAcceleration']>;

async function pickAcceleration(config: VideoEncoderConfig): Promise<Acceleration> {
  for (const preference of ['prefer-hardware', 'no-preference', 'prefer-software'] as const) {
    const support = await VideoEncoder.isConfigSupported({
      ...config,
      hardwareAcceleration: preference,
    });
    if (support.supported === true) return preference;
  }
  throw new Error(
    `no VideoEncoder configuration supports ${config.codec} at ` +
      `${String(config.width)}x${String(config.height)}`,
  );
}

export async function generate4kPart(options: GenerateOptions = {}): Promise<GeneratedPart> {
  const [width, height] = options.size ?? FIXTURE_SIZE;
  const frameCount = options.frameCount ?? 130;
  const gopSize = options.gopSize ?? 30;
  // High profile, level 5.2 — the codec string `recording.json`'s own example uses.
  const codec = 'avc1.640034';

  const base: VideoEncoderConfig = {
    codec,
    width,
    height,
    bitrate: options.bitrate ?? 14_000_000,
    framerate: 30,
    // The capture spine encodes live, so it will use realtime latency. No B-frames
    // means presentation order is decode order, which is what a screen recording
    // actually looks like.
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  };
  const hardwareAcceleration = await pickAcceleration(base);

  const chunks: { data: Uint8Array; timestamp: number; key: boolean }[] = [];
  let decoderConfig: VideoDecoderConfig | null = null;
  const failure: { error: Error | null } = { error: null };

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (decoderConfig === null && metadata?.decoderConfig !== undefined) {
        const source = metadata.decoderConfig;
        const description = source.description;
        // Copy the avcC out: the platform's buffer is not guaranteed to outlive the
        // callback, and this config is handed to a decoder much later.
        const copied: VideoDecoderConfig = {
          codec: source.codec,
          ...(source.codedWidth === undefined ? {} : { codedWidth: source.codedWidth }),
          ...(source.codedHeight === undefined ? {} : { codedHeight: source.codedHeight }),
          ...(description === undefined ? {} : { description: copyBuffer(description) }),
        };
        decoderConfig = copied;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, timestamp: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (error: DOMException) => {
      failure.error = error instanceof Error ? error : new Error(String(error));
    },
  });
  encoder.configure({ ...base, hardwareAcceleration });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  if (ctx === null) throw new Error('no 2d context for the fixture canvas');

  const startedAt = performance.now();
  let seconds = 0;
  let longestHoldSec = 0;
  for (let i = 0; i < frameCount; i++) {
    const gap = gapBefore(i);
    seconds += gap;
    if (gap > longestHoldSec) longestHoldSec = gap;
    paint(ctx, i, width, height);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(seconds * 1_000_000) });
    try {
      encoder.encode(frame, { keyFrame: i % gopSize === 0 });
    } finally {
      // Every acquire has a matching release, including on the encoder's error path.
      frame.close();
    }
    if (failure.error !== null) break;
    // Keep the encoder's queue bounded: a 4K frame in flight is 11.6 MB (§4.2), and
    // queueing 130 of them is a 1.5 GB spike for no benefit.
    if (encoder.encodeQueueSize > 8) await encoder.flush();
  }

  await encoder.flush();
  encoder.close();
  const encodeMs = performance.now() - startedAt;
  // Hand the 4K canvas back *before* the caller creates the context it measures on.
  // An accelerated 2D canvas this size holds ~30 MB of GPU memory per buffer, nothing
  // reads it once the encode is done, and V8 sees a small JS object — so left alone it
  // sits beside the run's own render target, screen texture and frame ring until a GC
  // that has no reason to hurry. Resizing drops the backing store now instead.
  canvas.width = 1;
  canvas.height = 1;
  if (failure.error !== null) throw failure.error;
  if (decoderConfig === null) throw new Error('the encoder never emitted a decoder config');
  if (chunks.length === 0) throw new Error('the encoder produced no chunks');

  // Concatenate in decode order; the index's offsets point into exactly this layout.
  let total = 0;
  for (const chunk of chunks) total += chunk.data.byteLength;
  const bytes = new Uint8Array(total);
  const keyframes: number[] = [];
  const pts: number[] = [];
  const sizes: number[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const [i, chunk] of chunks.entries()) {
    bytes.set(chunk.data, offset);
    if (chunk.key) keyframes.push(i);
    pts.push(chunk.timestamp);
    sizes.push(chunk.data.byteLength);
    offsets.push(offset);
    offset += chunk.data.byteLength;
  }

  const doc: FrameIndexDoc = {
    schema: currentSchemaId('loom.index'),
    timescale: 1_000_000,
    keyframes,
    pts,
    sizes,
    offsets,
  };

  const lastPts = pts[pts.length - 1] ?? 0;
  return {
    bytes,
    doc,
    config: decoderConfig,
    codec,
    frameCount: chunks.length,
    durationSec: lastPts / 1_000_000,
    longestHoldSec,
    encodeMs,
    hardwareAcceleration,
  };
}

function copyBuffer(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  }
  return new Uint8Array(new Uint8Array(source as ArrayBuffer));
}
