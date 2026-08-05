/**
 * Record once through the real capture page, and say what came out.
 *
 *   npm run build && node scripts/smoke-capture.mjs [--seconds 4] [--synthetic] [--keep]
 *                                                    [--no-audio]
 *
 * The automated gate replays encoded frames from a fixture, because a CI runner has
 * no display, no GPU and no Screen Recording grant. That covers everything from the
 * IPC boundary down. This covers the part above it: `MediaStreamTrackProcessor` →
 * `VideoEncoder` → IPC, driven by the same `RecorderSession` the app runs, on a real
 * machine.
 *
 * ## Which mode to run, and what each one is worth
 *
 * Default — the real screen. Needs a display and Screen Recording granted to
 * whatever runs it; in development that is inherited from the terminal, which is
 * also why it is not a substitute for phase 2's signed-bundle gate (research report
 * §7, trap 6). Without the grant it stops before it records anything and says so.
 *
 * `--synthetic` — a canvas stream in place of the display source, plus an
 * oscillator in place of the loopback and the microphone, and nothing else changed.
 * It runs where the grant is absent, and exercises the whole renderer path for real,
 * but it deliberately does **not** exercise `desktopCapturer` enumeration,
 * `setDisplayMediaRequestHandler`'s frame authorisation, `audio: 'loopback'` reaching
 * a real speaker output, or `setContentProtection` keeping the HUD out of the frames.
 * Those are carried forward as phase 2 signed-bundle obligations; see `AGENTS.md`.
 * Do not report a synthetic run as proof of them.
 *
 * ## What the audio half of this is for
 *
 * Two things the automated gate cannot reach, both of which decide whether A/V sync
 * works at all on a real machine:
 *
 * 1. **Whether the constraints of research trap 3 are honoured** — the run prints
 *    what `getSettings()` said, so a mono, echo-cancelled loopback shows up here
 *    rather than in a recording someone listens to next month.
 * 2. **Whether the audio and video capture clocks share an origin.** Every
 *    `startTimeSec` in the format is an offset on the *video* timebase (§5.4
 *    mechanism 2), which assumes both tracks are timestamped against the same clock.
 *    A synthetic run exercises the same Chromium code path that a real device does,
 *    so a start of seconds rather than milliseconds would show up even here.
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

/** The child's "Screen Recording is not granted" exit code. It prints its own advice. */
const EXIT_NO_SCREEN_PERMISSION = 3;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}

const seconds = arg('seconds', '4');
const keep = process.argv.includes('--keep');
const synthetic = process.argv.includes('--synthetic');
const audio = !process.argv.includes('--no-audio');

if (!existsSync(join(dist, 'renderer', 'capture.html'))) {
  console.error('dist/renderer/capture.html is missing. Run `npm run build` first.');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'loom-smoke-'));
const entry = join(scratch, 'smoke-main.cjs');
const recordingsRoot = join(scratch, 'recordings');

// `process.exit` skips a `finally`, so the scratch directory used to outlive every
// failing run. Every exit path here returns a code instead.
try {
  process.exitCode = await run();
} finally {
  if (!keep) rmSync(scratch, { recursive: true, force: true });
}

async function run() {
  await build({
    entryPoints: [join(root, 'apps/main/test/helpers/smoke-capture-main.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    logLevel: 'silent',
  });

  const electron = join(root, 'node_modules/.bin/electron');
  const result = spawnSync(
    electron,
    [
      entry,
      '--root',
      recordingsRoot,
      '--dist',
      dist,
      '--seconds',
      seconds,
      ...(synthetic ? ['--synthetic'] : []),
      ...(audio ? [] : ['--no-audio']),
    ],
    { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'inherit'] },
  );

  // The child has already explained this one on stderr, in more detail than we
  // could from here. Adding a second opinion would only bury it.
  if (result.status === EXIT_NO_SCREEN_PERMISSION) return EXIT_NO_SCREEN_PERMISSION;

  const line = (result.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  if (result.status !== 0 || line === undefined) {
    console.error(`the smoke capture did not complete (exit ${String(result.status)}).`);
    return 1;
  }

  const report = JSON.parse(line);
  console.log(report);

  const problems = [];
  if (report.state !== 'editable') problems.push(`state is ${report.state}: ${report.error ?? ''}`);
  if (report.frameCount < 1) problems.push('no frames were captured');
  if (report.durationSec <= 0) problems.push('the recording has no duration');

  if (problems.length > 0) {
    console.error(`\ncapture problems:\n  ${problems.join('\n  ')}`);
    return 1;
  }

  // The same independent playability check the gate uses.
  if (process.platform === 'darwin') {
    const media = join(report.path, 'media/screen.000.mp4');
    const probe = spawnSync(
      '/usr/bin/avconvert',
      ['--source', media, '--output', join(scratch, 'probe.mov'), '--preset', 'PresetPassthrough'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (probe.status !== 0) {
      console.error(`AVFoundation could not read ${media}`);
      return 1;
    }
    console.log('AVFoundation read the recording back.');
  }

  console.log(
    `\ncaptured ${report.frameCount} frames in ${report.durationSec.toFixed(2)}s ` +
      `(${report.observedFps.toFixed(1)} fps observed, ${report.droppedFrames} dropped) ` +
      `at ${report.size?.join('x') ?? '?'} as ${report.codec ?? '?'}`,
  );

  for (const track of report.audio ?? []) {
    const c = track.constraints ?? {};
    const processing = [
      c.echoCancellation ? 'AEC' : null,
      c.noiseSuppression ? 'NS' : null,
      c.autoGainControl ? 'AGC' : null,
    ].filter(Boolean);
    console.log(
      `${track.track}: ${track.durationSec.toFixed(2)}s, ${c.channelCount ?? '?'}ch, ` +
        `measured ${track.measuredSampleRate.toFixed(2)} Hz against a nominal ` +
        `${track.sampleRate}, starts ${(track.startTimeSec * 1000).toFixed(1)} ms after the ` +
        `first frame, ${track.gaps} gap(s) — ${track.deviceName ?? 'unknown device'}`,
    );
    if (processing.length > 0) {
      console.error(
        `  TRAP 3: ${track.track} kept ${processing.join(' + ')} on despite explicit ` +
          'constraints. Anything with music or video in it will sound processed.',
      );
    }
    if (Math.abs(track.startTimeSec) > 1) {
      console.error(
        `  ${track.track} starts ${track.startTimeSec.toFixed(3)}s from the first screen frame. ` +
          'Two tracks of one capture start within a frame or two of each other, so this ' +
          'means the audio and video capture clocks do not share an origin here — which is ' +
          'the assumption every startTimeSec in the format rests on.',
      );
    }
  }
  if (audio && (report.audio ?? []).length === 0) {
    console.error('no audio track was recorded; see the child process output above for why.');
  }
  if (report.source === 'synthetic') {
    console.log(
      'Source: SYNTHETIC. The renderer path above is real; the display source was a\n' +
        'canvas. desktopCapturer enumeration, setDisplayMediaRequestHandler and\n' +
        'setContentProtection are NOT covered by this run.',
    );
  }
  if (keep) console.log(`kept: ${report.path}`);
  return 0;
}
