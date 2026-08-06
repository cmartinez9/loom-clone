/**
 * §7.4's camera banner, measured in pixels on a real screen.
 *
 * The banner was correct in the DOM and invisible to a user for the whole of phase
 * 4: the HUD role is 420x92, frameless and `overflow: hidden`, and the notice shelf
 * is appended *below* the 92 px bar — so `#camera` laid out at y=92, in a 92 px
 * viewport, with zero pixels of it on screen. The error line has sat on the same
 * shelf, with the same defect, since phase 1.
 *
 * An "the element exists" or "the class was applied" assertion is exactly what let
 * that ship, so this gate asserts none of those. It launches the shipping window —
 * the real `WindowRegistry` role, the real preload, the real
 * `loom://app/recorder.html` — pushes real `RecorderStatus` payloads at it, and
 * reads back `getBoundingClientRect` clipped to the viewport plus an
 * `elementFromPoint` hit test at what is left.
 *
 * **The control** is the same run with `installHudNoticeFit()` not installed
 * (`--no-fit`). It must measure zero visible pixels of banner — which is what makes
 * the numbers above a reading rather than a formality, in the shape
 * `packages/format/test/kill-mid-write.test.ts` uses for the crash gate.
 */

import { describe, expect, it } from 'vitest';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HudReport, Probe } from './hud/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** The HUD's shipping geometry. `apps/main/src/windows.ts` declares it. */
const HUD_WIDTH = 420;
const HUD_HEIGHT = 92;

const GATE_TIMEOUT_MS = 240_000;
const PROBE_TIMEOUT_MS = 120_000;

interface Built {
  rendererRoot: string;
  preloadPath: string;
  mainPath: string;
}

/**
 * Build what the window is made of, from source, into a scratch directory.
 *
 * The renderer goes through the project's own vite config, so the page under the
 * probe is the page the app ships — same CSP, same `loom://` relative asset paths,
 * same self-hosted fonts, which is what the banner's height depends on.
 */
async function buildWindow(dir: string): Promise<Built> {
  const rendererRoot = join(dir, 'renderer');
  const preloadPath = join(dir, 'preload.cjs');
  const mainPath = join(dir, 'main.cjs');
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
      entryPoints: [join(root, 'apps/main/src/preload.ts')],
      outfile: preloadPath,
    }),
    esbuild({ ...common, entryPoints: [join(here, 'hud/main.ts')], outfile: mainPath }),
    viteBuild({
      configFile: resolve(root, 'apps/renderer/vite.config.ts'),
      logLevel: 'warn',
      build: { outDir: rendererRoot, emptyOutDir: true, sourcemap: false },
    }),
  ]);
  return { rendererRoot, preloadPath, mainPath };
}

async function runProbe(fit: boolean): Promise<HudReport> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-hud-gate-'));
  try {
    const built = await buildWindow(dir);
    const out = join(dir, 'report.json');
    const require = createRequire(import.meta.url);
    const electron = require('electron') as unknown as string;

    const child = spawn(
      electron,
      [
        built.mainPath,
        '--renderer',
        built.rendererRoot,
        '--preload',
        built.preloadPath,
        '--out',
        out,
        '--timeout',
        String(PROBE_TIMEOUT_MS),
        ...(fit ? [] : ['--no-fit']),
      ],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
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
      return JSON.parse(await readFile(out, 'utf8')) as HudReport;
    } catch {
      throw new Error(
        `the HUD probe produced no report (electron exited ${String(exitCode)}).\n` +
          `--- electron output ---\n${output.slice(-4000)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The one `--fit` run, shared by the two gates that read different labels out of it.
 *
 * A probe is a full esbuild, a full vite build and an Electron launch through the
 * whole sequence, and both gates below read the *same* report — the camera labels and
 * the §7.3 revocation labels come out of one pass. The control is deliberately not
 * shared: `--no-fit` is a different run of the harness and has to stay independent.
 */
let fittedRun: Promise<HudReport> | null = null;
function fittedProbe(): Promise<HudReport> {
  fittedRun ??= runProbe(true);
  return fittedRun;
}

function describeRun(report: HudReport): string {
  return [
    '',
    `fit installed  ${String(report.fitInstalled)}`,
    ...(report.error === '' ? [] : [`error          ${report.error}`]),
    ...report.probes.map(
      (p) =>
        `  ${p.label.padEnd(28)} window ${p.contentSize.join('x').padEnd(8)} ` +
        `inner ${String(p.innerHeight).padEnd(4)} doc ${String(p.documentHeight).padEnd(4)} ` +
        `notice ${p.noticeVisiblePx.toFixed(1).padStart(6)}px on-top=${String(p.noticeOnTop)} ` +
        `control ${p.controlVisiblePx.toFixed(1).padStart(6)}px on-top=${String(p.controlOnTop)}` +
        (p.noticeText === '' ? '' : `  "${p.noticeText}"`),
    ),
    '',
  ].join('\n');
}

function probeAt(report: HudReport, label: string): Probe {
  const found = report.probes.find((p) => p.label === label);
  if (found === undefined) throw new Error(`the probe never reported "${label}"`);
  return found;
}

describe('the recorder HUD says what §7.4 requires, where a user can read it', () => {
  it(
    'grows to show the camera notice and shrinks back to 420x92 when it clears',
    async () => {
      const report = await fittedProbe();
      const detail = describeRun(report);
      console.log(detail);

      expect(report.error, detail).toBe('');
      expect(report.ok, detail).toBe(true);

      // ---- before: the shipping geometry, and no shelf ------------------------
      for (const label of ['idle', 'recording, camera live']) {
        const quiet = probeAt(report, label);
        expect(quiet.contentSize, `${detail}\n${label}`).toEqual([HUD_WIDTH, HUD_HEIGHT]);
        expect(quiet.noticeVisiblePx, `${detail}\n${label}`).toBe(0);
        // No empty paper reserved for a notice that is not there: what is laid out
        // fits the window exactly.
        expect(quiet.documentHeight, `${detail}\n${label}`).toBeLessThanOrEqual(HUD_HEIGHT);
        expect(quiet.controlVisiblePx, `${detail}\n${label}`).toBeGreaterThan(0);
      }

      // ---- the unplug: the banner reaches the screen ---------------------------
      const lost = probeAt(report, 'recording, camera lost');
      expect(lost.noticeText, detail).toBe(
        'Camera disconnected — still recording screen and audio.',
      );
      // The assertion the finding was about, in the unit the finding was in.
      expect(lost.noticeVisiblePx, detail).toBeGreaterThan(0);
      // ...and all of it, not a clipped sliver.
      expect(lost.documentHeight, detail).toBeLessThanOrEqual(lost.innerHeight);
      expect(lost.noticeOnTop, detail).toBe(true);
      // The window grew to make room rather than the bar giving room up.
      expect(lost.contentSize[0], detail).toBe(HUD_WIDTH);
      expect(lost.contentSize[1], detail).toBeGreaterThan(HUD_HEIGHT);

      // The control row is still there and still usable: the notice was added
      // beside the controls, not in place of them.
      expect(lost.controlText, detail).toBe('Stop');
      expect(lost.controlVisiblePx, detail).toBeGreaterThan(0);
      expect(lost.controlOnTop, detail).toBe(true);

      // ---- and back: the borrowed room is given back --------------------------
      const back = probeAt(report, 'recording, camera reacquired');
      expect(back.contentSize, detail).toEqual([HUD_WIDTH, HUD_HEIGHT]);
      expect(back.noticeVisiblePx, detail).toBe(0);
      expect(back.controlVisiblePx, detail).toBeGreaterThan(0);

      // ---- the error line shares the shelf and had the same defect -------------
      const failed = probeAt(report, 'failed, error line');
      expect(failed.errorText, detail).toBe('The screen recording could not be written.');
      expect(failed.errorVisiblePx, detail).toBeGreaterThan(0);
      expect(failed.contentSize[1], detail).toBeGreaterThan(HUD_HEIGHT);
      expect(failed.controlVisiblePx, detail).toBeGreaterThan(0);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'shows a revoked Microphone grant as a revoked permission, on screen, after the stop',
    async () => {
      const report = await fittedProbe();
      const detail = describeRun(report);
      console.log(detail);

      expect(report.error, detail).toBe('');
      expect(report.ok, detail).toBe(true);

      const revoked = probeAt(report, 'idle, microphone revoked');

      // The whole of `decision-mic-revocation.md`, as a string assertion: the notice
      // names a **permission that was turned off**, and says nothing about a device
      // that disconnected. Both halves matter — the old behaviour said the second.
      expect(revoked.revokedText, detail).toContain('Microphone access was turned off');
      expect(revoked.revokedText, detail).not.toContain('disconnect');
      // ...and that the recording it stopped survived, with how much of it.
      expect(revoked.revokedText, detail).toContain('0:12');
      expect(revoked.revokedText, detail).toContain('in your library');
      // ...and how to put it back, which is the other half of what the captain asked
      // for: not just told, but asked to re-grant.
      expect(revoked.revokedButtonText, detail).toContain('Microphone');
      expect(revoked.revokedButtonVisiblePx, detail).toBeGreaterThan(0);

      // Measured, not asserted-into-existence: this shelf lives below the same 92 px
      // fold that hid §7.4's banner for the whole of phase 4.
      expect(revoked.revokedVisiblePx, detail).toBeGreaterThan(0);
      expect(revoked.revokedOnTop, detail).toBe(true);
      expect(revoked.documentHeight, detail).toBeLessThanOrEqual(revoked.innerHeight);
      expect(revoked.contentSize[1], detail).toBeGreaterThan(HUD_HEIGHT);
      // The recording is over, so the button the user needs is Record, and it is not
      // covered by the notice.
      expect(revoked.controlText, detail).toBe('Record screen');
      expect(revoked.controlVisiblePx, detail).toBeGreaterThan(0);

      // Pressing record clears it and gives the borrowed room back.
      const cleared = probeAt(report, 'recording again, notice cleared');
      expect(cleared.revokedHidden, detail).toBe(true);
      expect(cleared.revokedVisiblePx, detail).toBe(0);
      expect(cleared.contentSize, detail).toEqual([HUD_WIDTH, HUD_HEIGHT]);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'CONTROL: without main growing the window, the banner measures zero visible pixels',
    async () => {
      const report = await runProbe(false);
      const detail = describeRun(report);
      console.log(detail);

      expect(report.error, detail).toBe('');
      expect(report.ok, detail).toBe(true);

      const lost = probeAt(report, 'recording, camera lost');
      // Everything a weaker assertion would have checked still passes here: the
      // element is there, un-hidden, with §7.4's exact words in it.
      expect(lost.noticeHidden, detail).toBe(false);
      expect(lost.noticeText, detail).toBe(
        'Camera disconnected — still recording screen and audio.',
      );
      // And the user sees none of it. This is the defect, reproduced.
      expect(lost.contentSize, detail).toEqual([HUD_WIDTH, HUD_HEIGHT]);
      expect(lost.noticeVisiblePx, detail).toBe(0);
      expect(lost.documentHeight, detail).toBeGreaterThan(lost.innerHeight);

      // The §7.3 shelf is below the same fold and fails the same way without the fit.
      // Without this row, "the notice is populated" would be the only thing the
      // revocation gate above actually proved.
      const revoked = probeAt(report, 'idle, microphone revoked');
      expect(revoked.revokedHidden, detail).toBe(false);
      expect(revoked.revokedText, detail).toContain('Microphone access was turned off');
      expect(revoked.revokedVisiblePx, detail).toBe(0);
    },
    GATE_TIMEOUT_MS,
  );
});
