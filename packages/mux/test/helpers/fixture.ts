/**
 * The committed encoded-frame fixture, and the loader every capture test uses.
 *
 * Regenerate with `node scripts/make-capture-fixture.mjs`, which documents the
 * layout. It is committed rather than generated at test time so the crash gate
 * runs on a machine with no ffmpeg, no display and no screen-recording permission
 * — the frames have to come from *somewhere*, and "from a real H.264 encoder,
 * once" beats "from a synthetic byte pattern, every run".
 *
 * `apps/main/test/capture-crash.test.ts` imports this too. That is a deliberate
 * cross-package reach: the gate must drive the real `ProjectStore`, which lives in
 * `apps/main`, with real encoded frames, which live here.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FixtureFrame {
  isKey: boolean;
  timestampUs: number;
  data: Uint8Array;
}

export interface EncodedFixture {
  width: number;
  height: number;
  fps: number;
  /** The `avcC` record, as `VideoDecoderConfig.description` would carry it. */
  avcC: Uint8Array;
  frames: FixtureFrame[];
}

/**
 * Where the fixture lives, resolved lazily.
 *
 * Lazily because `apps/main/test/capture-crash.test.ts` bundles its child to
 * CommonJS, where `import.meta.url` does not survive — that child is handed an
 * explicit path and must never reach this function at module load.
 */
export function fixturePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/screen-h264.loomfix');
}

export function loadEncodedFixture(path: string = fixturePath()): EncodedFixture {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8).toString('latin1') !== 'LOOMFIX1') {
    throw new Error(`${path} is not a capture fixture`);
  }
  let at = 8;
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

  const frameCount = u32();
  const frames: FixtureFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const isKey = bytes[at] === 1;
    at += 1;
    const timestampUs = u32();
    const byteLength = u32();
    frames.push({
      isKey,
      timestampUs,
      data: Uint8Array.prototype.slice.call(bytes, at, at + byteLength),
    });
    at += byteLength;
  }
  return { width, height, fps, avcC, frames };
}
