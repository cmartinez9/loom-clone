/**
 * Put the Electron binary on disk while dependencies are being installed.
 *
 * `electron` ships **no** install script of its own any more: the ~300 MB runtime is
 * fetched lazily, by `require('electron')`, in whichever process asks for the
 * executable path first. In this repo that process is a test, and the first test to
 * ask is `test/phase6-gate.test.ts` — the one that judges a 16 ms frame budget on the
 * single worst frame with no allowance.
 *
 * So on a CI runner the gate downloaded and unzipped the runtime it was about to
 * time, seconds before timing it: three vCPUs, a cold file cache, ~300 MB of dirty
 * pages still being written back, and macOS validating the code signature of a
 * freshly-written app bundle the first time it is exec'd — all of it landing inside
 * the play window. That is the instrument disturbing its own measurement, in the same
 * family as the whole-frame readbacks the gate used to do inside the window it judged
 * (`test/gate/harness.ts` says what those cost), and it belongs here rather than in
 * the gate: `npm ci` is where a runtime gets installed.
 *
 * Two steps, because "installed" and "ready to run" are not the same thing on macOS:
 * fetch the dist, then exec it once so the signature check happens here too.
 *
 * Idempotent and quiet — electron's own installer exits immediately when the dist it
 * would write is already there, so the ordinary `npm ci` on a warm machine pays a few
 * hundred milliseconds. Run by hand as `node scripts/install-electron-runtime.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = resolve(root, 'node_modules/electron/install.js');

// An install that skipped devDependencies has no Electron to fetch, and that is not
// an error — nothing in a production install runs it.
if (!existsSync(installer)) {
  console.log('[electron] no electron package installed; nothing to fetch');
  process.exit(0);
}

const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// And run it once, here, because the *first* exec of a freshly written app bundle is
// where macOS validates its code signature and pages 300 MB of it in. That cost is
// small and it is unavoidable; what matters is that it is paid while dependencies are
// being installed rather than by the launch the phase-6 gate then measures.
//
// Never fatal: a runtime that will not print its own version is a problem for whatever
// tries to use it, with a real error at that point, and not a reason to fail an install.
const warm = spawnSync(process.execPath, [resolve(root, 'node_modules/electron/cli.js'), '-v'], {
  stdio: 'ignore',
  timeout: 60_000,
});
if (warm.status !== 0) {
  console.log('[electron] installed, but the runtime would not report its version');
}
