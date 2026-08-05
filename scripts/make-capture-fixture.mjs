/**
 * Regenerate the encoded-frame fixture the capture tests replay.
 *
 *   node scripts/make-capture-fixture.mjs [--out <path>] [--seconds 10] [--size 320x180] [--fps 30]
 *
 * The crash gate has to feed the *production* writer real encoded H.264, and it
 * has to do it on a machine with no display, no screen-recording permission and no
 * Electron — so the frames are recorded once, here, and committed. Regenerating
 * them needs ffmpeg; running the tests does not, which is the point.
 *
 * ffmpeg produces an Annex-B elementary stream; this script converts it to the
 * AVCC framing `VideoEncoder` emits (`avc: { format: 'avc' }`) and to the `avcC`
 * record it hands over as `VideoDecoderConfig.description`, so what the tests
 * replay has the same shape as what the capture renderer sends over IPC.
 *
 * Fixture layout, all integers big-endian:
 *
 *   "LOOMFIX1" | u32 width | u32 height | u32 fps
 *   u32 avcCLength | avcC bytes
 *   u32 frameCount
 *   frameCount x ( u8 isKey | u32 timestampUs | u32 byteLength | AVCC bytes )
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

const out = resolve(root, arg('out', 'packages/mux/test/fixtures/screen-h264.loomfix'));
const seconds = Number(arg('seconds', '10'));
const [width, height] = arg('size', '320x180').split('x').map(Number);
const fps = Number(arg('fps', '30'));

const scratch = resolve(tmpdir(), `loom-capture-fixture-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const annexB = resolve(scratch, 'source.h264');

try {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=${fps}`,
      '-t',
      String(seconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      // One keyframe a second, no B-frames, one slice per frame: exactly what the
      // capture encoder is configured for (architecture report §7.1).
      '-g',
      String(fps),
      '-bf',
      '0',
      // `-tune zerolatency` turns on sliced threads, which would put several
      // slices in one picture and make "a VCL NAL ends an access unit" wrong.
      '-x264-params',
      'slices=1:sliced-threads=0:scenecut=0',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      '250k',
      '-f',
      'h264',
      annexB,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

  const stream = readFileSync(annexB);
  const nals = splitAnnexB(stream);
  const sps = nals.find((n) => (n[0] & 0x1f) === 7);
  const pps = nals.find((n) => (n[0] & 0x1f) === 8);
  if (sps === undefined || pps === undefined) throw new Error('stream carries no SPS/PPS');

  const frames = accessUnits(nals);
  const avcC = buildAvcC(sps, pps);

  const parts = [
    Buffer.from('LOOMFIX1', 'latin1'),
    u32(width),
    u32(height),
    u32(fps),
    u32(avcC.byteLength),
    avcC,
    u32(frames.length),
  ];
  frames.forEach((frame, i) => {
    parts.push(
      Buffer.from([frame.isKey ? 1 : 0]),
      u32(Math.round((i * 1_000_000) / fps)),
      u32(frame.data.byteLength),
      frame.data,
    );
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.concat(parts));
  const bytes = Buffer.concat(parts).byteLength;
  console.log(
    `wrote ${out}: ${frames.length} frames, ` +
      `${frames.filter((f) => f.isKey).length} keyframes, ${(bytes / 1024).toFixed(0)} KB`,
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
 * A VCL NAL (types 1–5) ends an access unit; the parameter sets and SEI ahead of
 * it belong to it. SPS and PPS are dropped from the sample data because they live
 * in `avcC`, and access-unit delimiters are dropped because MP4 does not carry
 * them — which is exactly what a WebCodecs encoder in `avc` format produces.
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
