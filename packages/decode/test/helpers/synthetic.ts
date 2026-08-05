/**
 * A synthetic media part: an index sidecar plus the bytes it points into.
 *
 * Phase 6 was started **before** phase 1, deliberately and in parallel, so no real
 * capture output exists to build against. What does exist is `packages/format`,
 * which declares the sidecar (`loom.index/1`, §2.4) and the recording document
 * (§2.3). These fixtures conform to that declaration and to nothing else: no
 * assumption about how the capture spine names its segments, lays out its files, or
 * derives its timestamps.
 *
 * The frame timing is variable on purpose. `rate.mode: "variable"` is not a detail
 * (§2.3): the scout measured ScreenCaptureKit at 1.4 fps on an idle desktop and
 * 29.4 fps under animation, so a fixture that ticks at a constant 30 fps would let a
 * CFR bug through. These parts hold a frame for up to half a second in places.
 */

import { currentSchemaId, type FrameIndexDoc } from '@loom/format';
import { DemuxIndex } from '../../src/frame-index.ts';

export interface SyntheticPartOptions {
  frameCount?: number;
  /** Frames between keyframes. */
  gopSize?: number;
  timescale?: number;
  /** Bytes per delta frame; keyframes get ten times this. */
  frameBytes?: number;
  /** Gap in seconds before frame `i`. Defaults to a VFR pattern with long holds. */
  gapBefore?: (i: number) => number;
}

export interface SyntheticPart {
  doc: FrameIndexDoc;
  index: DemuxIndex;
  bytes: Uint8Array;
  /** Microsecond timestamp of frame `i`, i.e. what a decoded frame carries. */
  micros: (i: number) => number;
  seconds: (i: number) => number;
}

/** ~30 fps, with a half-second hold every 17 frames — an idle desktop, then motion. */
function defaultGap(i: number): number {
  if (i === 0) return 0;
  if (i % 17 === 0) return 0.5;
  if (i % 5 === 0) return 0.05;
  return 1 / 30;
}

export function syntheticPart(options: SyntheticPartOptions = {}): SyntheticPart {
  const frameCount = options.frameCount ?? 120;
  const gopSize = options.gopSize ?? 30;
  const timescale = options.timescale ?? 1_000_000;
  const frameBytes = options.frameBytes ?? 64;
  const gapBefore = options.gapBefore ?? defaultGap;

  const keyframes: number[] = [];
  const pts: number[] = [];
  const sizes: number[] = [];
  const offsets: number[] = [];

  let seconds = 0;
  let offset = 0;
  for (let i = 0; i < frameCount; i++) {
    seconds += gapBefore(i);
    const isKey = i % gopSize === 0;
    if (isKey) keyframes.push(i);
    pts.push(Math.round(seconds * timescale));
    const size = isKey ? frameBytes * 10 : frameBytes;
    sizes.push(size);
    offsets.push(offset);
    offset += size;
  }

  // Frame `i`'s bytes begin with `i` as a little-endian uint32, so a fake decoder
  // can prove it decoded the chunk it was actually handed rather than the one the
  // test hoped for.
  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frameCount; i++) {
    const start = offsets[i] ?? 0;
    view.setUint32(start, i, true);
    bytes.fill((i * 7) % 251, start + 4, start + (sizes[i] ?? 0));
  }

  const doc: FrameIndexDoc = {
    schema: currentSchemaId('loom.index'),
    timescale,
    keyframes,
    pts,
    sizes,
    offsets,
  };

  const index = DemuxIndex.fromDoc(doc);
  return {
    doc,
    index,
    bytes,
    micros: (i) => index.ptsMicros(i),
    seconds: (i) => index.ptsSec(i),
  };
}

/** Read back the frame number a synthetic chunk carries. */
export function frameNumberOf(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}
