/**
 * The phase 2 gate: run the permission checks from a **signed bundle**.
 *
 *   node scripts/verify-permissions.mjs               # package if needed, then run
 *   node scripts/verify-permissions.mjs --repackage   # always rebuild the bundle
 *   node scripts/verify-permissions.mjs --mic-revocation   # ...and the §7.3 check
 *                                                          # that needs you to flip
 *                                                          # a switch mid-recording
 *   node scripts/verify-permissions.mjs --app <path>  # use an existing .app
 *
 * Architecture report §8: *"Run from a signed bundle, not a dev binary — dev
 * inherits Terminal's TCC and lies to you (scout trap 6)."* Two things have to be
 * true for a result to mean anything, and this script exists to make both true and
 * then prove they were:
 *
 * 1. **The app is packaged and signed under the frozen bundle identifier.** macOS
 *    keys every grant on it; a different identity has different permissions and its
 *    pass predicts nothing (`apps/main/src/identity.ts`).
 * 2. **macOS holds the app responsible for its own permissions.** Launching the
 *    executable from a shell makes the *shell* the responsible process, and the app
 *    inherits the terminal's grants — the exact lie the gate is about. So this
 *    launches with `open -a`, through LaunchServices, and the harness independently
 *    checks that its parent is launchd before it will call anything a pass.
 *
 * ## What this script will not do
 *
 * It does not grant a permission, and it contains no `tccutil`, no TCC database
 * edit, and no way to spoof a grant. There is no supported mechanism for one and
 * there should not be an unsupported one in this repo. If a permission is missing,
 * the report says which, names the System Settings pane, and exits 2.
 *
 * Exit codes: 0 verified, 1 a check genuinely failed, 2 incomplete (a missing grant,
 * an untrustworthy build), 3 the script could not get far enough to run anything.
 */

import { spawn, execFile } from 'node:child_process';
import { access, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'release');

const BEGIN = '---loom-verify-json-begin---';
const END = '---loom-verify-json-end---';
const SCRATCH = '---loom-verify-scratch:';

const args = process.argv.slice(2);
const wantRepackage = args.includes('--repackage');
/**
 * Run the §7.3 microphone-revocation check, which needs a person.
 *
 * Off by default because there is no programmatic way to revoke a TCC permission:
 * the check starts a real recording and waits for somebody to switch Microphone off
 * in System Settings. Without the flag it reports `skipped` and says so, rather than
 * sitting there for ninety seconds and then reporting a gap that was never a defect.
 */
const wantMicRevocation = args.includes('--mic-revocation');
const appArg = valueOf('--app');
const outPath = valueOf('--out') ?? join(root, 'verify-permissions.json');

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

function fail(message, code = 3) {
  console.error(`\n  ${message}\n`);
  process.exit(code);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The frozen identifier, read from source rather than repeated here. */
async function expectedBundleId() {
  const source = await readFile(join(root, 'apps/main/src/identity.ts'), 'utf8');
  const match = /LOOM_BUNDLE_ID = '([^']+)'/.exec(source);
  if (match === null) fail('could not read LOOM_BUNDLE_ID from apps/main/src/identity.ts');
  return match[1];
}

/**
 * Find the packaged app, preferring this machine's architecture.
 *
 * `electron-builder` emits both `release/mac-arm64` and `release/mac` (x64), and
 * directory order is not preference order — the first run of this script picked the
 * x64 bundle on an arm64 Mac and exercised it under Rosetta. That is not the binary
 * the captain will grant permissions to, and TCC grants are keyed to the bundle, so a
 * grant given to one is not a grant given to the other.
 */
async function findPackagedApp() {
  if (!(await exists(releaseDir))) return null;
  const preferred = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const entries = (await readdir(releaseDir)).filter((e) => e.startsWith('mac'));
  const ordered = [
    ...entries.filter((e) => e === preferred),
    ...entries.filter((e) => e !== preferred),
  ];
  for (const entry of ordered) {
    const candidate = join(releaseDir, entry, 'Loom Clone.app');
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function packageApp() {
  console.log('  packaging (npm run package)…');
  await run('npm', ['run', 'package'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch(
    (error) => {
      fail(
        `electron-builder failed:\n${String(error.stderr ?? error.message)}\n\n` +
          'A signed bundle is the whole point of this gate, so there is no dev-binary fallback.',
      );
    },
  );
  const app = await findPackagedApp();
  if (app === null) fail('electron-builder reported success but no .app appeared under release/');
  return app;
}

async function describeSignature(appPath) {
  try {
    const result = await run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

/**
 * Make the bundle sign as the identifier `identity.ts` freezes, and prove it does.
 *
 * **This is the step that decides whether the whole run means anything.** Measured on
 * this machine: `npm run package` with no Developer ID skips signing, and what is left
 * is the Electron binary's own linker-signed stub — `Identifier=Electron`, Info.plist
 * *not bound*. macOS would file every grant under "Electron", so a permission the
 * captain granted would belong to a different app than the one we ship, and would
 * evaporate the moment a real signature appeared. That is the identity churn
 * `apps/main/src/identity.ts` exists to prevent, arriving through the back door.
 *
 * The fix is the one research report §5.3, note 4 recommends: ad-hoc sign
 * (`codesign -s -`) with our identifier so the identity is stable. Note what this
 * does and does not do — it establishes *who is asking*; it grants nothing, and there
 * is no supported or unsupported way for it to. The captain still has to say yes in
 * System Settings.
 *
 * An ad-hoc signature is not a distributable one and the report says so out loud. A
 * Developer ID signature, when one exists, is left completely alone.
 */
async function ensureIdentity(appPath, wantedId) {
  let output = await describeSignature(appPath);
  let identifier = /Identifier=(.+)/.exec(output)?.[1]?.trim();

  if (identifier !== wantedId) {
    console.log(`  re-signing: bundle signs as "${identifier ?? '(unsigned)'}", not "${wantedId}"`);
    await run('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--identifier',
      wantedId,
      '--entitlements',
      join(root, 'build/entitlements.mac.plist'),
      // Hardened runtime, matching `electron-builder.yml`. Without it the entitlements
      // are not enforced and the bundle differs from a release build in the one
      // dimension this gate is about.
      '--options',
      'runtime',
      appPath,
    ]).catch((error) => {
      fail(`could not ad-hoc sign the bundle:\n${String(error.stderr ?? error.message)}`);
    });
    output = await describeSignature(appPath);
    identifier = /Identifier=(.+)/.exec(output)?.[1]?.trim();
  }

  if (identifier !== wantedId) {
    fail(
      `the bundle still signs as "${identifier ?? '(none)'}" but identity.ts freezes ` +
        `"${wantedId}". macOS keys every permission on that string, so this bundle’s ` +
        'grants would be a different app’s.',
    );
  }

  const adhoc = output.includes('Signature=adhoc');
  const hardened = output.includes('runtime');
  console.log(
    `  identity  ${identifier}${adhoc ? ' (ad-hoc)' : ''}${hardened ? ', hardened' : ''}`,
  );
  if (adhoc) {
    console.log(
      '            ad-hoc is a stable identity, not a distributable signature. Grants\n' +
        '            given to it are real but are keyed to this exact build.',
    );
  }
  return { identifier, adhoc };
}

/**
 * Launch through LaunchServices so the app is its own responsible process, and
 * stream its output back.
 *
 * `open -a … --args --verify-permissions` rather than executing the binary: running
 * `Loom Clone.app/Contents/MacOS/Loom Clone` from this script would make *this*
 * process — and therefore the terminal — responsible for its TCC, which is the lie
 * the gate exists to catch. `--wait-apps` keeps `open` alive until the app exits, and
 * `--stdout`/`--stderr` route its output to files we then read, because a
 * LaunchServices-started app has no inherited stdio.
 *
 * `--wait-apps` waits for the app to exit and nothing bounds that, so a harness that
 * never reaches `app.exit()` hangs this script too — a silent terminal in place of
 * the diagnosis this tool exists to give. {@link LAUNCH_TIMEOUT_MS} bounds it. The
 * whole run is a handful of window loads plus a ten-second click window; the margin
 * is for a slow first launch and Gatekeeper, not for a check that is thinking.
 */
const LAUNCH_TIMEOUT_MS = 4 * 60_000;

/**
 * ...and how long with `--mic-revocation`, which additionally waits for a person to
 * walk to System Settings and back. The harness's own window is 90 s; this is that
 * plus the rest of the run, with room for a slow first launch.
 */
const MIC_REVOCATION_TIMEOUT_MS = 7 * 60_000;

async function launch(appPath) {
  const stdoutPath = join(root, '.verify-stdout.log');
  const stderrPath = join(root, '.verify-stderr.log');
  await writeFile(stdoutPath, '');
  await writeFile(stderrPath, '');

  if (wantMicRevocation) {
    console.log(
      '\n  --mic-revocation: the app will start a real recording and wait for you.\n' +
        '  When it does, switch "Loom Clone" OFF under\n' +
        '    System Settings › Privacy & Security › Microphone\n' +
        '  The app has no stdio while LaunchServices owns it, so follow along with\n' +
        `    tail -f ${stdoutPath}\n` +
        '  Switch it back ON afterwards, or the next run has nothing to revoke.\n',
    );
  }

  console.log('  launching via LaunchServices (open -a)…\n');
  let timedOut = false;
  const code = await new Promise((resolveCode) => {
    const child = spawn(
      '/usr/bin/open',
      [
        '-a',
        appPath,
        '--wait-apps',
        '--new',
        '--stdout',
        stdoutPath,
        '--stderr',
        stderrPath,
        '--args',
        '--verify-permissions',
        ...(wantMicRevocation ? ['--mic-revocation'] : []),
      ],
      { stdio: 'inherit' },
    );
    const timer = setTimeout(
      () => {
        timedOut = true;
        // Kills the waiting `open`, not the app: LaunchServices owns that process and
        // this script never had it. Saying so is the point — a stuck app the developer
        // cannot see is worse than one they have been told to quit.
        child.kill('SIGTERM');
      },
      wantMicRevocation ? MIC_REVOCATION_TIMEOUT_MS : LAUNCH_TIMEOUT_MS,
    );
    child.on('close', (closeCode) => {
      clearTimeout(timer);
      resolveCode(closeCode);
    });
  });

  const stdout = await readFile(stdoutPath, 'utf8').catch(() => '');
  const stderr = await readFile(stderrPath, 'utf8').catch(() => '');
  await rm(stdoutPath, { force: true });
  await rm(stderrPath, { force: true });
  return { openExit: code, stdout, stderr, timedOut };
}

function slice(stdout) {
  const begin = stdout.indexOf(BEGIN);
  const end = stdout.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) return null;
  try {
    return JSON.parse(stdout.slice(begin + BEGIN.length, end).trim());
  } catch {
    return null;
  }
}

/**
 * Say precisely what is still owed, and by whom.
 *
 * An "incomplete" run is the expected outcome until somebody with hands on System
 * Settings has granted what the app asks for. That person needs three things and no
 * more: which checks are still open, what to switch on, and the fact that nobody can
 * do it for them.
 */
function explainWhatIsMissing(report) {
  const open = report.checks.filter((c) => c.status === 'blocked' || c.status === 'skipped');
  const passed = report.checks.filter((c) => c.status === 'pass');

  console.log('\n  Incomplete.');
  if (passed.length > 0) {
    console.log(`  ${passed.length} check(s) passed from a trustworthy build:`);
    for (const check of passed) console.log(`    · ${check.title}`);
  }
  console.log(`\n  ${open.length} still open:`);
  for (const check of open) console.log(`    · [${check.status}] ${check.title}`);

  const needs = new Set();
  if (report.permissions.statuses.screen !== 'granted') {
    needs.add('Privacy & Security › Screen & System Audio Recording');
  }
  if (!report.permissions.accessibility.axTrusted) {
    needs.add('Privacy & Security › Accessibility');
  }
  if (report.permissions.statuses.microphone !== 'granted') {
    needs.add('Privacy & Security › Microphone');
  }
  if (needs.size > 0) {
    console.log('\n  Switch "Loom Clone" on in System Settings:');
    for (const pane of needs) console.log(`    · ${pane}`);
    console.log(
      '\n  Then run this again. Both grants need the app relaunched to take effect,\n' +
        '  which this script does by launching a fresh copy. There is no programmatic\n' +
        '  way to grant a TCC permission and this script does not pretend otherwise.',
    );
  }
}

async function main() {
  const wantedId = await expectedBundleId();

  let appPath = appArg;
  if (appPath === null) {
    appPath = wantRepackage ? null : await findPackagedApp();
    appPath ??= await packageApp();
  }
  if (!(await exists(appPath))) fail(`no such app bundle: ${appPath}`);
  console.log(`\n  bundle    ${appPath}`);

  await ensureIdentity(appPath, wantedId);

  const { stdout, stderr, timedOut } = await launch(appPath);
  // The app's own human-readable summary. Printed first, because it is the thing a
  // person actually wants to read.
  const human = stdout.split(BEGIN)[0]?.trimEnd() ?? '';
  if (human !== '') console.log(human);

  if (timedOut) {
    if (stderr !== '') console.error(stderr);
    const budget = wantMicRevocation ? MIC_REVOCATION_TIMEOUT_MS : LAUNCH_TIMEOUT_MS;
    fail(
      `the app did not exit within ${budget / 1000}s and produced no report. ` +
        'Everything it managed to print is above — the last check named there is the one ' +
        `that did not come back.\n  Quit "Loom Clone" (it is still running) before ` +
        're-running this.',
    );
  }

  const scratch = stdout
    .split('\n')
    .find((line) => line.startsWith(SCRATCH))
    ?.slice(SCRATCH.length)
    .trim();
  if (scratch !== undefined && scratch !== '') {
    // Main has no filesystem (§0, rule 1), so cleaning up its scratch root is this
    // script's job.
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const report = slice(stdout);
  if (report === null) {
    console.error(stderr);
    fail('the app produced no machine-readable report. Its output is above.');
  }

  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n  report    ${outPath}`);

  const code = report.outcome === 'verified' ? 0 : report.outcome === 'failed' ? 1 : 2;
  if (code === 2) explainWhatIsMissing(report);
  process.exit(code);
}

await main();
