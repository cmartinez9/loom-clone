/**
 * The launch gate: the shipping app, launched, with a window on screen and IPC that
 * answers.
 *
 * **`main()`'s startup path had never been exercised by any test.** Every phase gate
 * builds the piece it is about — a window role, a compositor, an export loop — and
 * none of them ever ran `apps/main/src/index.ts`. Twenty-four commits merged green
 * over an app that opened nothing for the first person who ran it, and the two
 * defects that produced that (`scripts/dev.mjs`, `test/dev-loop.test.ts`) plus the
 * one this gate reads directly were all on the launch and quit paths nothing looked
 * at.
 *
 * So this gate reimplements nothing. `test/launch/main.ts` `require`s the real
 * `dist/main/index.cjs` — the file `package.json`'s `main` names — and watches it
 * take the single-instance lock, install `loom://`, register its channels, run crash
 * recovery and open a window. The only thing arranged around it is `HOME` and
 * `--user-data-dir`, so the app's recordings root and settings land in a scratch
 * directory instead of the user's library; there is no test flag in production and
 * there must not be one.
 *
 * ## The three claims
 *
 * 1. **A window a person could see**, in both branches of the launch path — the
 *    setup window on a first run and the library on every run after. The reading is
 *    `document.visibilityState` inside the page, because that is what separates a
 *    window that was constructed from one that was revealed, and the **control** is
 *    a window the harness creates `show: false` on the same page: it must read
 *    `hidden`, or `visible` is a constant rather than a measurement.
 * 2. **Its IPC answers**, called from inside the page through the real preload
 *    bridge — the four calls the library makes as it loads. Beside them,
 *    `library.delete` with a nonsense id must **reject**: a row of `ok: true` from a
 *    probe that cannot report bad news is not evidence.
 * 3. **The quit does not disconnect a live window before the flush.** This is the
 *    captain's own line — `No handler registered for 'loom.library.list'`, twice,
 *    while a window was on screen — and it is the claim that fails against the code
 *    this gate was written for. `before-quit` tore the whole IPC surface down as its
 *    first act and then spent seconds finalizing a recording whose `capture.ended`
 *    message had nowhere to arrive.
 *
 * It deliberately does **not** measure the frame budget, per-pixel identity, or
 * anything a phase gate already owns. It is about one thing: the product opens.
 */

import { describe, expect, it } from 'vitest';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IpcReading, LaunchReport } from './launch/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const GATE_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Build the app the way `scripts/build.mjs` does, into a scratch `dist/`.
 *
 * The layout matters and is not incidental: `apps/main/src/index.ts` resolves its
 * preload and renderer roots from its own `__dirname`, so the entry has to sit at
 * `<dir>/main/index.cjs` with `<dir>/preload/index.cjs` and `<dir>/renderer/` beside
 * it or the app under test is not the app that ships.
 *
 * The native sampler is **not** built. It is an accessory — a missing helper costs
 * the click-tap probe and nothing else, `PermissionManager` catches it — and leaving
 * it out keeps this gate off `clang` and off the Accessibility grant.
 */
async function buildApp(dir: string): Promise<string> {
  const dist = join(dir, 'dist');
  const common = {
    bundle: true,
    platform: 'node' as const,
    format: 'cjs' as const,
    target: 'node20',
    external: ['electron'],
    sourcemap: 'inline' as const,
    logLevel: 'warning' as const,
  };
  await Promise.all([
    esbuild({
      ...common,
      entryPoints: [join(root, 'apps/main/src/index.ts')],
      outfile: join(dist, 'main', 'index.cjs'),
    }),
    esbuild({
      ...common,
      entryPoints: [join(root, 'apps/main/src/preload.ts')],
      outfile: join(dist, 'preload', 'index.cjs'),
    }),
    viteBuild({
      configFile: resolve(root, 'apps/renderer/vite.config.ts'),
      logLevel: 'warn',
      build: { outDir: join(dist, 'renderer'), emptyOutDir: true, sourcemap: false },
    }),
  ]);
  return dist;
}

/**
 * Run the probe once.
 *
 * `scenario: 'library'` seeds a `settings.json` that says setup is done, which is
 * what every launch after the first sees; `'setup'` leaves the scratch userData
 * empty, which is a first run. Those are the two branches of the one line in
 * `main()` that decides what the user meets.
 */
async function runProbe(scenario: 'setup' | 'library'): Promise<LaunchReport> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-launch-gate-'));
  try {
    const dist = await buildApp(dir);
    const home = join(dir, 'home');
    const userData = join(dir, 'userData');
    const recordings = join(home, 'Movies', 'Loom Clone');
    await mkdir(recordings, { recursive: true });
    await mkdir(userData, { recursive: true });
    if (scenario === 'library') {
      await writeFile(
        join(userData, 'settings.json'),
        JSON.stringify({
          schema: 'loom.settings/2',
          recordingsRoot: recordings,
          setup: { completedAt: new Date().toISOString(), accessibilityOpenedAt: null },
        }),
      );
    }

    const harness = join(dir, 'harness.cjs');
    await esbuild({
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      sourcemap: 'inline',
      logLevel: 'warning',
      entryPoints: [join(here, 'launch/main.ts')],
      outfile: harness,
    });

    const out = join(dir, 'report.json');
    const require = createRequire(import.meta.url);
    const electron = require('electron') as unknown as string;

    const child = spawn(
      electron,
      [
        harness,
        '--dist',
        dist,
        '--out',
        out,
        '--scenario',
        scenario,
        '--timeout',
        String(PROBE_TIMEOUT_MS),
        `--user-data-dir=${userData}`,
      ],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        // `HOME` is what `os.homedir()` reads on POSIX, and it is what puts the
        // app's default recordings root (`~/Movies/Loom Clone`) in the scratch tree.
        // A launch gate that wrote into the user's own library would be a test that
        // records their screen to prove a window opened.
        env: { ...process.env, HOME: home, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      },
    );

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exitCode = await new Promise<number | null>((r) => {
      child.once('exit', (code) => {
        r(code);
      });
    });

    try {
      return JSON.parse(await readFile(out, 'utf8')) as LaunchReport;
    } catch {
      throw new Error(
        `the launch probe produced no report (electron exited ${String(exitCode)}).\n` +
          `--- electron output ---\n${output.slice(-4000)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function describeRun(report: LaunchReport): string {
  return [
    '',
    `scenario            ${report.scenario}`,
    `windows before      ${String(report.windowsBeforeLaunch)}`,
    ...(report.error === '' ? [] : [`error               ${report.error}`]),
    ...report.windows.map(
      (w) =>
        `  window ${w.url.padEnd(28)} visible=${String(w.isVisible).padEnd(5)} ` +
        `state=${w.visibilityState.padEnd(8)} ${w.contentSize.join('x').padEnd(9)} ` +
        `colours ${String(w.capturedColours).padStart(3)} ` +
        `heading ${w.headingVisiblePx.toFixed(0).padStart(4)}px "${w.headingText}"`,
    ),
    `  hidden control    visible=${String(report.hiddenControl?.isVisible ?? 'not taken')} ` +
      `state=${report.hiddenControl?.visibilityState ?? '-'} ` +
      `colours ${String(report.hiddenControl?.capturedColours ?? '-')}`,
    ...report.ipc.map(
      (c) => `  ipc ${c.call.padEnd(20)} ${c.ok ? `ok ${c.value}` : `REJECTED ${c.error}`}`,
    ),
    report.quit === null
      ? '  quit              not taken'
      : `  quit              windows=${String(report.quit.windowsAlive)} ` +
        `library.list handled=${String(report.quit.libraryListHandled)} ` +
        `capture.ended listeners=${String(report.quit.captureEndedListeners)}`,
    '',
  ].join('\n');
}

function ipcAt(report: LaunchReport, call: string): IpcReading {
  const found = report.ipc.find((c) => c.call === call);
  if (found === undefined) throw new Error(`the probe never called ${call}`);
  return found;
}

/** One launch per scenario, shared by the assertions that read it. */
const runs = new Map<'setup' | 'library', Promise<LaunchReport>>();
function probe(scenario: 'setup' | 'library'): Promise<LaunchReport> {
  let run = runs.get(scenario);
  if (run === undefined) {
    run = runProbe(scenario);
    runs.set(scenario, run);
  }
  return run;
}

describe('the app opens', () => {
  it(
    'puts the library on screen, painted, on an ordinary launch',
    async () => {
      const report = await probe('library');
      const detail = describeRun(report);
      console.log(detail);

      expect(report.error, detail).toBe('');
      expect(report.ok, detail).toBe(true);
      // The window is the app's doing: there was nothing on screen before it ran.
      expect(report.windowsBeforeLaunch, detail).toBe(0);

      const library = report.windows.find((w) => w.url.endsWith('/library.html'));
      expect(library, detail).toBeDefined();
      if (library === undefined) return;

      // The reading the whole gate is about. A role is created `show: false` and
      // revealed on `ready-to-show`, so this is what a `ready-to-show` that never
      // fires — or a `reveal()` that is not reached — fails on.
      expect(library.isVisible, detail).toBe(true);
      expect(library.contentSize[0], detail).toBeGreaterThan(0);
      expect(library.contentSize[1], detail).toBeGreaterThan(0);
      // ...and it painted, in two independent ways. The heading is the document's
      // own layout; the colour count is the window's compositor output, which is
      // what a window that opened over a renderer bundle that did not load — a
      // `loom://` protocol that failed to install, a CSP that refused the entry —
      // would fail while still laying out nothing at all.
      expect(library.headingText, detail).toBe('Recordings.');
      expect(library.headingVisiblePx, detail).toBeGreaterThan(0);
      expect(library.capturedColours, detail).toBeGreaterThan(1);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'puts the first-run setup window on screen instead, when setup has not been done',
    async () => {
      const report = await probe('setup');
      const detail = describeRun(report);
      console.log(detail);

      expect(report.error, detail).toBe('');
      expect(report.ok, detail).toBe(true);
      expect(report.windowsBeforeLaunch, detail).toBe(0);

      const setup = report.windows.find((w) => w.url.endsWith('/setup.html'));
      expect(setup, detail).toBeDefined();
      if (setup === undefined) return;

      expect(setup.isVisible, detail).toBe(true);
      expect(setup.headingText, detail).toBe('Four things, then you can record.');
      expect(setup.headingVisiblePx, detail).toBeGreaterThan(0);
      expect(setup.capturedColours, detail).toBeGreaterThan(1);
      // The branch is exclusive: a first run must not open the library beside it,
      // which is the "one deliberate onboarding step" the captain's decision asks
      // for and the thing `second-instance` and `activate` also gate on.
      expect(
        report.windows.filter((w) => w.url.endsWith('/library.html')),
        detail,
      ).toHaveLength(0);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'CONTROL: a window that was never revealed reads hidden through the same instrument',
    async () => {
      const report = await probe('library');
      const detail = describeRun(report);

      // Same page, same preload, same protocol, created `show: false` — the state a
      // window whose `ready-to-show` never fired is left in. Without this row, the
      // `isVisible` above is a constant nobody has watched come back any other way.
      expect(report.hiddenControl, detail).not.toBeNull();
      expect(report.hiddenControl?.isVisible, detail).toBe(false);

      // And the reading this control retired, recorded rather than dropped: an
      // unrevealed Electron window still reports `document.visibilityState` as
      // `visible`, so the renderer's own opinion of whether it is on screen is not
      // an instrument. It was the obvious first choice and it measures nothing.
      expect(report.hiddenControl?.visibilityState, detail).toBe('visible');
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'answers the four calls the library makes as it loads',
    async () => {
      const report = await probe('library');
      const detail = describeRun(report);

      // The captain's line was `No handler registered for 'loom.library.list'`. This
      // is that call, made from inside the real page through the real preload.
      for (const call of ['app.info', 'library.list', 'library.recovery', 'recorder.preflight']) {
        const reading = ipcAt(report, call);
        expect(reading.error, `${detail}\n${call}`).toBe('');
        expect(reading.ok, `${detail}\n${call}`).toBe(true);
      }
      // An empty scratch library is an empty list, not a missing one.
      expect(ipcAt(report, 'library.list').value, detail).toBe('[]');
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'CONTROL: a call that should fail comes back rejected, so the row above is a reading',
    async () => {
      const report = await probe('library');
      const detail = describeRun(report);

      const bad = ipcAt(report, 'library.delete');
      expect(bad.ok, detail).toBe(false);
      expect(bad.error, detail).not.toBe('');
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'keeps a live window connected to main until the shutdown flush is done',
    async () => {
      const report = await probe('library');
      const detail = describeRun(report);

      expect(report.quit, detail).not.toBeNull();
      const quit = report.quit;
      if (quit === null) return;

      // The reading is only worth anything while there is still a window to be
      // disconnected from — that is what made the captain's two errors visible.
      expect(quit.windowsAlive, detail).toBeGreaterThan(0);

      // The symptom, at its source: `before-quit` used to call `unregisterIpc()` as
      // its first act, so every channel died while the window stayed on screen for
      // the whole of a flush that can take seconds.
      expect(quit.libraryListHandled, detail).toBe(true);

      // ...and the half that costs data rather than a list. `unregisterIpc` removes
      // every channel in `CHANNEL`, including `capture.ended` — the message
      // `RecorderSession.stop()` waits for. Without it the stop waits out its 5 s
      // timeout and the recording is finalized with no end report: nominal
      // `measuredSampleRate` in place of the measured one, `endReason: "crash"` on
      // every part of a recording that did not crash, and no frame counts.
      expect(quit.captureEndedListeners, detail).toBeGreaterThan(0);
    },
    GATE_TIMEOUT_MS,
  );
});
