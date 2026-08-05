/**
 * Regenerate the flash fixture the A/V sync gate composes its flashes from.
 *
 *   node scripts/make-sync-fixture.mjs [--out <path>] [--size 128x72] [--fps 30] [--levels 16]
 *
 * ## What this is for
 *
 * The phase 3 gate (`apps/main/test/av-sync.test.ts`) records a white flash and a
 * tone at the same instant and measures how far apart they land after twenty
 * minutes. The tone can be encoded and decoded at test time by `afconvert`, which
 * ships with macOS. Nothing that ships with macOS will decode H.264 **to pixels**
 * from Node, and the gate has to run on a CI machine with no ffmpeg, no display and
 * no Electron.
 *
 * So the luma is measured here, once, and committed: this script encodes a palette
 * of flat grey frames, decodes them back with ffmpeg, and records what each one
 * actually decodes to. The gate composes a flash by choosing frames from that
 * palette, and reads the brightness back by matching the bytes in the file it wrote
 * against the palette. Every *timing* number in the gate comes from the real
 * pipeline; the only thing that comes from here is "how bright is this frame",
 * which is a property of the frame and not of anything phase 3 can get wrong.
 *
 * Every frame is an IDR (`-g 1`), which is what makes the palette composable: an
 * encoded P-frame depends on whatever came before it, so a fixture of P-frames
 * could only ever be replayed in the order it was recorded.
 *
 * Fixture layout, all integers big-endian:
 *
 *   "LOOMSYNC1" | u32 width | u32 height | u32 fps
 *   u32 avcCLength | avcC bytes
 *   u32 frameCount
 *   frameCount x ( u32 lumaMilli | u32 byteLength | AVCC bytes )
 *
 * `lumaMilli` is the decoded mean luma × 1000, so the palette is exact integers.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}

const out = resolve(root, arg('out', 'packages/mux/test/fixtures/flash-h264.loomsync'));
const [width, height] = arg('size', '128x72').split('x').map(Number);
const fps = Number(arg('fps', '30'));
const levels = Number(arg('levels', '16'));

const scratch = resolve(tmpdir(), `loom-sync-fixture-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const rawIn = resolve(scratch, 'palette.yuv');
const annexB = resolve(scratch, 'palette.h264');
const rawOut = resolve(scratch, 'decoded.gray');

try {
  // One flat frame per luma level, in yuv420p. Flat because the gate needs a
  // brightness it can compose an envelope from, not a picture.
  const ySize = width * height;
  const uvSize = (width / 2) * (height / 2);
  const frames = [];
  for (let i = 0; i < levels; i++) {
    const value = Math.round((i * 255) / (levels - 1));
    const frame = Buffer.alloc(ySize + uvSize * 2, 128);
    frame.fill(value, 0, ySize);
    frames.push(frame);
  }
  writeFileSync(rawIn, Buffer.concat(frames));

  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-s',
      `${width}x${height}`,
      '-r',
      String(fps),
      '-i',
      rawIn,
      '-c:v',
      'libx264',
      // Every frame an IDR, no B-frames, one slice: each frame decodes on its own,
      // which is what lets the gate replay them in any order it likes.
      '-g',
      '1',
      '-bf',
      '0',
      '-x264-params',
      'slices=1:sliced-threads=0:scenecut=0',
      '-qp',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'h264',
      annexB,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

  // Decode what was actually encoded. The palette records the *decoded* mean, not
  // the value that was asked for: H.264 at qp 18 is lossy, and a fixture that
  // claimed otherwise would be a fixture that lies by a level or two.
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      annexB,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      rawOut,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

  const decoded = readFileSync(rawOut);
  if (decoded.byteLength !== ySize * levels) {
    throw new Error(
      `decoded ${decoded.byteLength} bytes, expected ${ySize * levels}: the palette did not round-trip`,
    );
  }
  const luma = [];
  for (let i = 0; i < levels; i++) {
    let sum = 0;
    for (let at = i * ySize; at < (i + 1) * ySize; at++) sum += decoded[at];
    luma.push(Math.round((sum / ySize) * 1000));
  }

  const stream = readFileSync(annexB);
  const nals = splitAnnexB(stream);
  const sps = nals.find((n) => (n[0] & 0x1f) === 7);
  const pps = nals.find((n) => (n[0] & 0x1f) === 8);
  if (sps === undefined || pps === undefined) throw new Error('stream carries no SPS/PPS');

  const units = accessUnits(nals);
  if (units.length !== levels) {
    throw new Error(`encoded ${units.length} access units for ${levels} levels`);
  }
  if (!units.every((u) => u.isKey)) {
    throw new Error('every palette frame must be an IDR, or the gate cannot compose with them');
  }

  const avcC = buildAvcC(sps, pps);
  const parts = [
    Buffer.from('LOOMSYNC1', 'latin1'),
    u32(width),
    u32(height),
    u32(fps),
    u32(avcC.byteLength),
    avcC,
    u32(units.length),
  ];
  units.forEach((unit, i) => {
    parts.push(u32(luma[i]), u32(unit.data.byteLength), unit.data);
  });

  mkdirSync(dirname(out), { recursive: true });
  const bytes = Buffer.concat(parts);
  writeFileSync(out, bytes);
  console.log(
    `wrote ${out}: ${units.length} levels, ${width}x${height}, ` +
      `luma ${(luma[0] / 1000).toFixed(1)}..${(luma.at(-1) / 1000).toFixed(1)}, ` +
      `${(bytes.byteLength / 1024).toFixed(0)} KB`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/** Split an Annex-B stream on its start codes. */
function splitAnnexB(bytes) {
  const starts = [];
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push({ at: i + 3, prefix: i > 0 && bytes[i - 1] === 0 ? 4 : 3 });
      i += 2;
    }
  }
  return starts.map(({ at }, index) => {
    const next = starts[index + 1];
    const end = next === undefined ? bytes.length : next.at - next.prefix;
    return bytes.subarray(at, end);
  });
}

/**
 * Group NAL units into access units, one per coded picture.
 *
 * Identical to `scripts/make-capture-fixture.mjs`: SPS and PPS are dropped because
 * they live in `avcC`, access-unit delimiters because MP4 does not carry them, and
 * what is left is AVCC-framed exactly as a WebCodecs encoder in `avc` format emits.
 */
function accessUnits(nals) {
  const frames = [];
  let pending = [];
  for (const nal of nals) {
    const type = nal[0] & 0x1f;
    if (type === 7 || type === 8 || type === 9) continue;
    pending.push(nal);
    if (type >= 1 && type <= 5) {
      frames.push({
        isKey: pending.some((n) => (n[0] & 0x1f) === 5),
        data: Buffer.concat(pending.flatMap((n) => [u32(n.length), n])),
      });
      pending = [];
    }
  }
  return frames;
}

/** The `avcC` record: ISO/IEC 14496-15 §5.2.4.1, with 4-byte NAL length prefixes. */
function buildAvcC(sps, pps) {
  return Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]),
    sps,
    Buffer.from([1, pps.length >> 8, pps.length & 0xff]),
    pps,
  ]);
}
