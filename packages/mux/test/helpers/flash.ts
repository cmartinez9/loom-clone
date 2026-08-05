/**
 * The committed flash palette, and the loader the A/V sync gate reads it with.
 *
 * Regenerate with `node scripts/make-sync-fixture.mjs`, which documents the layout
 * and the reason it exists: `afconvert` will decode the gate's tone on any macOS
 * machine, and nothing that ships with macOS will decode H.264 to pixels from
 * Node. So the brightness of each palette frame is measured once, by ffmpeg, and
 * committed; the gate composes flashes out of the palette and reads them back by
 * matching the bytes it finds in the file it wrote.
 *
 * Every frame is an IDR, which is what makes them composable in any order.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FlashLevel {
  /** Mean luma the frame decodes to, 0–255. */
  luma: number;
  data: Uint8Array;
}

export interface FlashFixture {
  width: number;
  height: number;
  fps: number;
  /** The `avcC` record, as `VideoDecoderConfig.description` would carry it. */
  avcC: Uint8Array;
  /** Flat frames, dark to bright. */
  levels: FlashLevel[];
  /**
   * Which palette frame is closest to a wanted brightness.
   *
   * The gate composes a flash as a brightness envelope and needs the frame that
   * renders it; the palette is coarse (16 steps) and the envelope is not, so the
   * nearest is what is written and what the gate then reads back.
   */
  nearest(luma: number): number;
}

export function flashFixturePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/flash-h264.loomsync');
}

export function loadFlashFixture(path: string = flashFixturePath()): FlashFixture {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 9).toString('latin1') !== 'LOOMSYNC1') {
    throw new Error(`${path} is not a flash fixture`);
  }
  let at = 9;
  const u32 = (): number => {
    const value = bytes.readUInt32BE(at);
    at += 4;
    return value;
  };

  const width = u32();
  const height = u32();
  const fps = u32();
  const avcCLength = u32();
  const avcC = Uint8Array.prototype.slice.call(bytes, at, at + avcCLength);
  at += avcCLength;

  const count = u32();
  const levels: FlashLevel[] = [];
  for (let i = 0; i < count; i++) {
    const luma = u32() / 1000;
    const byteLength = u32();
    levels.push({ luma, data: Uint8Array.prototype.slice.call(bytes, at, at + byteLength) });
    at += byteLength;
  }

  return {
    width,
    height,
    fps,
    avcC,
    levels,
    nearest(luma: number): number {
      let best = 0;
      let bestError = Number.POSITIVE_INFINITY;
      levels.forEach((level, i) => {
        const error = Math.abs(level.luma - luma);
        if (error < bestError) {
          bestError = error;
          best = i;
        }
      });
      return best;
    },
  };
}
