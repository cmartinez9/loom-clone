/**
 * Compile the native input sampler.
 *
 * One `clang` invocation, no Xcode project, no `node-gyp`, no `electron-rebuild`.
 * The helper is a plain command-line tool rather than a Node addon on purpose
 * (see the header of `loom-input-sampler.m`), and the whole point of that choice
 * is lost if building it needs a toolchain more elaborate than the one every macOS
 * developer already has.
 *
 * Output is `dist/native/loom-input-sampler`, beside the JavaScript bundles, so a
 * packaged app finds it at a path relative to `__dirname` exactly as it does in
 * development.
 *
 * Rebuild is skipped when the binary is newer than the source, because `vitest`
 * calls this before the acceptance test and a 1.5 s compile per test file adds up.
 */

import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

export const NATIVE_SOURCE = resolve(here, 'loom-input-sampler.m');
export const NATIVE_BINARY = resolve(repoRoot, 'dist/native/loom-input-sampler');

const FRAMEWORKS = ['Foundation', 'AppKit', 'ApplicationServices', 'CoreGraphics'];

/**
 * `electron-builder.yml` targets both `arm64` and `x64`, so a single-arch helper
 * would work on the developer's machine and be missing on half the DMGs. One `clang`
 * call produces the fat binary; if a toolchain cannot, the fallback is the host arch
 * and a loud line rather than a silent single-arch release.
 */
const UNIVERSAL = ['-arch', 'arm64', '-arch', 'x86_64'];

async function modifiedAt(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Build the helper, returning its path.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function buildNativeSampler(options = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('the native input sampler is macOS-only; this app is macOS-only');
  }

  if (options.force !== true) {
    const [source, binary] = await Promise.all([
      modifiedAt(NATIVE_SOURCE),
      modifiedAt(NATIVE_BINARY),
    ]);
    if (binary !== null && source !== null && binary >= source) return NATIVE_BINARY;
  }

  await mkdir(dirname(NATIVE_BINARY), { recursive: true });

  const compile = (extra) =>
    run('clang', [
      '-fobjc-arc',
      '-fmodules',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      // macOS 14.0 is the declared floor (captain decision 7). Compiling against it
      // makes a newer-SDK-only API a build error rather than a crash on a user's Mac.
      '-mmacosx-version-min=14.0',
      ...extra,
      ...FRAMEWORKS.flatMap((framework) => ['-framework', framework]),
      '-o',
      NATIVE_BINARY,
      NATIVE_SOURCE,
    ]);

  try {
    await compile(UNIVERSAL);
  } catch (error) {
    console.warn(
      `[sampler] could not build a universal helper (${error.message.split('\n')[0]}); ` +
        `falling back to ${process.arch} only`,
    );
    await compile([]);
  }
  return NATIVE_BINARY;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = await buildNativeSampler({ force: process.argv.includes('--force') });
  console.log(`built -> ${path}`);
}
