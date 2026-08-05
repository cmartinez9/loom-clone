/**
 * Getting hold of a process that macOS genuinely does not trust.
 *
 * The phase-5 gate is *"Accessibility revoked → `clicks.available: false`, no empty
 * file, no silent zeros"*, and the brief is explicit that revocation must be
 * **exercised, not assumed**. Asserting on a mocked `false` would prove nothing: the
 * whole failure mode is that the real API succeeds and then does nothing.
 *
 * So the test runs the real helper as a real untrusted process. Two ways to get one,
 * tried in order:
 *
 * 1. **The runner is already untrusted.** The common case — CI, and any developer
 *    who has not added their terminal to System Settings → Accessibility.
 * 2. **Disclaim TCC responsibility.** macOS attributes a permission request to the
 *    *responsible* process, so a helper launched from a trusted terminal inherits
 *    that trust — research report §7, trap 6, and the reason CLAUDE.md says to test
 *    from a signed bundle. `responsibility_spawnattrs_setdisclaim` makes the child
 *    answer for its own code identity, which has no grant.
 *
 * If neither works the test **fails**, loudly, with instructions. It does not skip:
 * a gate that quietly passes on the one machine where it cannot run is not a gate.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { probeInput } from '../src/native.ts';

export interface UntrustedHelper {
  /** What to pass as `helperPath`. May be a shim that disclaims before exec. */
  path: string;
  /** How the untrusted process was obtained, for the test's own reporting. */
  via: 'already-untrusted' | 'disclaimed';
}

/**
 * A shell shim that forwards every argument through `spawn-disclaimed`.
 *
 * `posix_spawn` with no file actions inherits fds 0, 1 and 2, so the grandchild
 * writes NDJSON to the same stdout and reads `{"cmd":"stop"}` from the same stdin.
 * From the sampler's side it is indistinguishable from running the helper directly.
 */
async function writeDisclaimShim(directory: string, helperPath: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'disclaimed-sampler');
  await writeFile(path, `#!/bin/sh\nexec ${JSON.stringify(helperPath)} spawn-disclaimed "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

export async function untrustedHelper(
  helperPath: string,
  scratchDirectory: string,
): Promise<UntrustedHelper> {
  const direct = await probeInput({ helperPath });
  if (!direct.helperAvailable) {
    throw new Error(`the input sampler would not run: ${direct.problem}`);
  }
  if (!direct.clicks.axTrusted) return { path: helperPath, via: 'already-untrusted' };

  const shim = await writeDisclaimShim(scratchDirectory, helperPath);
  const disclaimed = await probeInput({ helperPath: shim });
  if (disclaimed.helperAvailable && !disclaimed.clicks.axTrusted) {
    return { path: shim, via: 'disclaimed' };
  }

  throw new Error(
    'the phase-5 gate needs a process macOS does not trust, and could not get one. ' +
      'This test runner holds the Accessibility grant and disclaiming TCC ' +
      `responsibility did not shed it (${disclaimed.problem || 'still trusted'}). ` +
      'Remove the terminal running these tests from System Settings → Privacy & ' +
      'Security → Accessibility and run them again.',
  );
}
