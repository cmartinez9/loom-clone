/**
 * Record the screen for real, once, and say what came out.
 *
 *   npm run build && node scripts/smoke-capture.mjs [--seconds 4]
 *
 * The automated gate replays encoded frames from a fixture, because a CI runner has
 * no display, no GPU and no Screen Recording grant. That covers everything from the
 * IPC boundary down. This covers the part above it: `getDisplayMedia` →
 * `MediaStreamTrackProcessor` → `VideoEncoder` → IPC, driven by the same
 * `RecorderSession` the app runs, on a real machine.
 *
 * It needs a display and Screen Recording granted to whatever runs it — in
 * development that is inherited from the terminal, which is also why it is not a
 * substitute for phase 2's signed-bundle gate (research report §7, trap 6).
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}

const seconds = arg('seconds', '4');
const keep = process.argv.includes('--keep');

if (!existsSync(join(dist, 'renderer', 'capture.html'))) {
  console.error('dist/renderer/capture.html is missing. Run `npm run build` first.');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'loom-smoke-'));
const entry = join(scratch, 'smoke-main.cjs');
const recordingsRoot = join(scratch, 'recordings');

try {
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
    [entry, '--root', recordingsRoot, '--dist', dist, '--seconds', seconds],
    { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'inherit'] },
  );

  const line = (result.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  if (result.status !== 0 || line === undefined) {
    console.error(`the smoke capture did not complete (exit ${String(result.status)}).`);
    process.exit(1);
  }

  const report = JSON.parse(line);
  console.log(report);

  const problems = [];
  if (report.state !== 'editable') problems.push(`state is ${report.state}: ${report.error ?? ''}`);
  if (report.frameCount < 1) problems.push('no frames were captured');
  if (report.durationSec <= 0) problems.push('the recording has no duration');

  if (problems.length > 0) {
    console.error(`\ncapture problems:\n  ${problems.join('\n  ')}`);
    console.error(
      '\nIf frames are missing, check that Screen Recording is granted to the terminal ' +
        'running this (System Settings > Privacy & Security > Screen & System Audio Recording).',
    );
    process.exit(1);
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
      process.exit(1);
    }
    console.log('AVFoundation read the recording back.');
  }

  console.log(
    `\ncaptured ${report.frameCount} frames in ${report.durationSec.toFixed(2)}s ` +
      `(${report.observedFps.toFixed(1)} fps observed, ${report.droppedFrames} dropped) ` +
      `at ${report.size?.join('x') ?? '?'} as ${report.codec ?? '?'}`,
  );
  if (keep) console.log(`kept: ${report.path}`);
} finally {
  if (!keep) rmSync(scratch, { recursive: true, force: true });
}
