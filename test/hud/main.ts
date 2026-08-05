/**
 * Electron main for the HUD notice gate.
 *
 * It opens the **real** recorder HUD: the shipping `WindowRegistry` role (420x92,
 * frameless, `resizable: false`, content-protected), the shipping preload, the
 * shipping `loom://app/recorder.html` bundle, and the shipping
 * `installHudNoticeFit()` wiring. Nothing about the window is reimplemented here,
 * because a gate that builds its own window measures its own window.
 *
 * What it fakes is only the other end of the conversation: real `RecorderStatus`
 * payloads are pushed on `CHANNEL.recorderStatus` in place of a live
 * `RecorderSession`, so a camera can be lost and found without a camera.
 *
 * `--no-fit` skips `installHudNoticeFit()`. That is the control: the same page, the
 * same statuses, the same measurement, with the one thing this gate is about
 * removed — and it must measure zero visible pixels of banner.
 */

import { app, type BrowserWindow } from 'electron';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CHANNEL,
  type CameraState,
  type RecorderPhase,
  type RecorderStatus,
  type RevocationNotice,
} from '@loom/ipc';
import { ProjectStore } from '../../apps/main/src/project-store.ts';
import { installLoomProtocol, registerLoomScheme } from '../../apps/main/src/protocol.ts';
import { WindowRegistry } from '../../apps/main/src/windows.ts';
import type { HudReport, Probe } from './report.ts';

interface Args {
  rendererRoot: string;
  preloadPath: string;
  out: string;
  fit: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string => {
    const index = argv.indexOf(`--${name}`);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (value === undefined) {
      if (fallback === undefined) throw new Error(`missing --${name}`);
      return fallback;
    }
    return value;
  };
  return {
    rendererRoot: resolve(get('renderer')),
    preloadPath: resolve(get('preload')),
    out: resolve(get('out')),
    fit: !argv.includes('--no-fit'),
    timeoutMs: Number.parseInt(get('timeout', '120000'), 10),
  };
}

const args = parseArgs(process.argv.slice(1));
const logs: string[] = [];
const probes: Probe[] = [];
let finished = false;

function note(message: string): void {
  logs.push(message);
  console.log(`[hud] ${message}`);
}

async function finish(ok: boolean, error: string): Promise<void> {
  if (finished) return;
  finished = true;
  const report: HudReport = { ok, error, fitInstalled: args.fit, probes, logs };
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report, null, 2));
  app.exit(ok ? 0 : 1);
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => {
    setTimeout(r, ms);
  });
}

/** `getContentSize()` is a `number[]`; this is the height, or 0 if there is none. */
function contentHeight(window: BrowserWindow): number {
  return window.getContentSize()[1] ?? 0;
}

/**
 * The reading, taken inside the renderer.
 *
 * `getBoundingClientRect` clipped to the viewport is what "visible" means here, and
 * `elementFromPoint` is the second opinion: a rect can sit inside the viewport while
 * something opaque covers it, and hit-testing the centre of what is left catches
 * that. Both are needed — the defect being covered produced a perfectly good rect
 * entirely below the fold.
 */
const PROBE_SCRIPT = `(() => {
  const view = window.innerHeight;
  const visible = (el) => {
    if (el === null) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.max(0, Math.min(r.bottom, view) - Math.max(r.top, 0));
  };
  const onTop = (el) => {
    const px = visible(el);
    if (px <= 0) return false;
    const r = el.getBoundingClientRect();
    const y = (Math.max(r.top, 0) + Math.min(r.bottom, view)) / 2;
    const hit = document.elementFromPoint(r.left + r.width / 2, y);
    return hit !== null && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const notice = document.getElementById('camera');
  const error = document.getElementById('error');
  const revoked = document.getElementById('revoked');
  const revokedButton = document.getElementById('revoked-settings');
  const record = document.getElementById('record');
  const stop = document.getElementById('stop');
  const control = record.hidden ? stop : record;
  return {
    innerHeight: view,
    noticeText: notice.hidden ? '' : (notice.textContent ?? ''),
    noticeHidden: notice.hidden,
    noticeVisiblePx: notice.hidden ? 0 : visible(notice),
    noticeOnTop: !notice.hidden && onTop(notice),
    errorVisiblePx: error.hidden ? 0 : visible(error),
    errorText: error.hidden ? '' : (error.textContent ?? ''),
    revokedHidden: revoked.hidden,
    revokedText: revoked.hidden ? '' : (revoked.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    revokedVisiblePx: revoked.hidden ? 0 : visible(revoked),
    revokedOnTop: !revoked.hidden && onTop(revoked),
    revokedButtonText: revoked.hidden ? '' : (revokedButton.textContent ?? ''),
    revokedButtonVisiblePx: revoked.hidden ? 0 : visible(revokedButton),
    controlText: control.textContent ?? '',
    controlVisiblePx: visible(control),
    controlOnTop: onTop(control),
    documentHeight: document.documentElement.scrollHeight,
  };
})()`;

function status(
  phase: RecorderPhase,
  camera: CameraState,
  error: string | null,
  revoked: RevocationNotice | null = null,
): RecorderStatus {
  return {
    phase,
    recordingId: phase === 'idle' ? null : 'rec-hud-gate',
    elapsedSec: phase === 'idle' ? 0 : 12.5,
    frameCount: phase === 'idle' ? 0 : 375,
    droppedFrames: 0,
    error,
    camera,
    cameraParts: camera === 'off' ? 0 : 1,
    revoked,
  };
}

/**
 * What main publishes after a Microphone grant is withdrawn mid-recording.
 *
 * `phase: 'idle'` on purpose: by the time the user reads this the recording has
 * already been stopped and finalized, which is the captain's decision working
 * (`decision-mic-revocation.md`) and is exactly the state the camera banner would
 * have hidden itself in.
 */
const MIC_REVOKED: RevocationNotice = {
  kind: 'microphone',
  recordingId: 'rec-hud-gate',
  recordedSec: 12.5,
};

/**
 * Wait for the whole round trip to come to rest: the renderer has applied the
 * status, main has finished resizing to what the renderer reported, and the
 * renderer has laid out at the new size.
 *
 * `ready` is a *precondition* — that the status arrived — not the assertion. What is
 * asserted is measured afterwards, in pixels.
 */
async function settle(window: BrowserWindow, ready: string): Promise<void> {
  const contents = window.webContents;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const applied = (await contents.executeJavaScript(ready)) as boolean;
    if (applied) break;
    await wait(20);
  }
  let height = contentHeight(window);
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await wait(20);
    const now = contentHeight(window);
    if (now !== height) {
      height = now;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= 250) break;
  }
  await contents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
  );
}

async function probe(window: BrowserWindow, label: string): Promise<Probe> {
  const measured = (await window.webContents.executeJavaScript(PROBE_SCRIPT)) as Omit<
    Probe,
    'label' | 'contentSize'
  >;
  const size = window.getContentSize();
  const width = size[0] ?? 0;
  const height = size[1] ?? 0;
  const reading: Probe = { label, contentSize: [width, height], ...measured };
  probes.push(reading);
  note(
    `${label}: window ${String(width)}x${String(height)}, ` +
      `notice ${reading.noticeVisiblePx.toFixed(1)}px visible, ` +
      `control "${reading.controlText}" ${reading.controlVisiblePx.toFixed(1)}px visible`,
  );
  return reading;
}

registerLoomScheme();

void app.whenReady().then(async () => {
  try {
    const scratch = await mkdtemp(join(tmpdir(), 'loom-hud-'));
    const store = new ProjectStore({
      recordingsRoot: join(scratch, 'recordings'),
      settingsPath: join(scratch, 'settings.json'),
      appVersion: '0.0.0-hud-gate',
      trash: () => Promise.resolve(),
    });
    installLoomProtocol({ store, rendererRoot: args.rendererRoot });

    const windows = new WindowRegistry({ preloadPath: args.preloadPath });
    // The one line under test. Skipped by `--no-fit`, which is the control.
    if (args.fit) windows.installHudNoticeFit();

    const hud = windows.show('recorder-hud');
    hud.webContents.on('console-message', (_event, _level, message) => {
      note(`renderer: ${message}`);
    });
    hud.webContents.on('preload-error', (_event, path, error) => {
      void finish(false, `preload ${path} failed: ${error.message}`);
    });
    setTimeout(() => {
      void finish(false, `the probe did not finish within ${String(args.timeoutMs)}ms`);
    }, args.timeoutMs).unref?.();

    await new Promise<void>((resolveLoad, rejectLoad) => {
      hud.webContents.once('did-finish-load', () => {
        resolveLoad();
      });
      hud.webContents.once('did-fail-load', (_event, code, description) => {
        rejectLoad(new Error(`recorder.html failed to load: ${description} (${String(code)})`));
      });
    });
    await hud.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await settle(hud, 'document.getElementById("camera") !== null');

    const send = (next: RecorderStatus): void => {
      hud.webContents.send(CHANNEL.recorderStatus, next);
    };
    const bannerIs = (shown: boolean): string =>
      `document.getElementById("camera").hidden === ${String(!shown)}`;

    // 1. Idle: nothing to say, so the bar is the bar and nothing else.
    await probe(hud, 'idle');

    // 2. Recording with the camera live: still nothing to say (§7.4 shows the
    //    banner only when the camera is gone, not while it is opening).
    send(status('recording', 'live', null));
    await settle(hud, bannerIs(false));
    await probe(hud, 'recording, camera live');

    // 3. The unplug. This is the reading the gate exists for.
    send(status('recording', 'lost', null));
    await settle(hud, bannerIs(true));
    await probe(hud, 'recording, camera lost');

    // 4. The camera comes back. The notice clears and the window must go back to
    //    the shipping geometry rather than keeping the room it borrowed.
    send(status('recording', 'live', null));
    await settle(hud, bannerIs(false));
    await probe(hud, 'recording, camera reacquired');

    // 5. §7.3's revoked Microphone grant. The recording has already been stopped and
    //    finalized by the time this is published, so it is read in `idle` — the state
    //    every other notice on this shelf hides itself in.
    send(status('idle', 'off', null, MIC_REVOKED));
    await settle(hud, 'document.getElementById("revoked").hidden === false');
    await probe(hud, 'idle, microphone revoked');

    // 6. And pressing record clears it. Main is what does that
    //    (`RecorderSession.start`); this is the HUD honouring the cleared field.
    send(status('recording', 'off', null, null));
    await settle(hud, 'document.getElementById("revoked").hidden === true');
    await probe(hud, 'recording again, notice cleared');

    // 7. And the error line, which shares the shelf and has had the same defect
    //    since phase 1. Last, because unlike the two notices above it is *sticky* —
    //    `render` shows it and only the record button clears it — so a probe after
    //    this one would be measuring the error line as well as its own subject.
    send(status('failed', 'off', 'The screen recording could not be written.'));
    await settle(hud, 'document.getElementById("error").hidden === false');
    await probe(hud, 'failed, error line');

    await finish(true, '');
  } catch (error: unknown) {
    await finish(false, error instanceof Error ? error.message : String(error));
  }
});

app.on('window-all-closed', () => {
  void finish(false, 'the HUD closed before the probe finished');
});

process.on('uncaughtException', (error: Error) => {
  void finish(false, `uncaught in main: ${error.message}`);
});
