/**
 * An Electron main process that records the screen for a few seconds and quits.
 *
 * Driven by `scripts/smoke-capture.mjs`. Not part of the app, and not part of
 * `npm test`: it needs a real display, a real GPU and a real Screen Recording
 * grant, none of which a CI runner has.
 *
 * It exists because the automated gate stops at the IPC boundary. Everything below
 * it — the fragment writer, recovery, the documents — is covered by
 * `apps/main/test/capture-crash.test.ts` and friends, replaying encoded frames from
 * a fixture. Nothing there proves that `getDisplayMedia` →
 * `MediaStreamTrackProcessor` → `VideoEncoder` → IPC actually produces those frames
 * on this machine. This does, against the same `RecorderSession` the app runs.
 *
 * Reports one line of JSON on stdout so the runner can assert on it rather than
 * read a log.
 */

import { app, shell } from 'electron';
import { join } from 'node:path';
import { ProjectStore } from '../../src/project-store.ts';
import { RecorderSession } from '../../src/recorder/session.ts';
import { installLoomProtocol, registerLoomScheme } from '../../src/protocol.ts';
import { WindowRegistry } from '../../src/windows.ts';
import { LOOM_BUNDLE_ID, LOOM_PRODUCT_NAME } from '../../src/identity.ts';

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? fallback : process.argv[at + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const recordingsRoot = arg('root');
const distRoot = arg('dist');
const seconds = Number(arg('seconds', '3'));

app.setName(LOOM_PRODUCT_NAME);
app.setAppUserModelId(LOOM_BUNDLE_ID);
registerLoomScheme();

const store = new ProjectStore({
  recordingsRoot,
  settingsPath: join(recordingsRoot, 'settings.json'),
  appVersion: app.getVersion(),
  trash: (path: string) => shell.trashItem(path),
});
const windows = new WindowRegistry({ preloadPath: join(distRoot, 'preload', 'index.cjs') });
const recorder = new RecorderSession({
  store,
  windows,
  appVersion: app.getVersion(),
  osVersion: process.getSystemVersion(),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

app
  .whenReady()
  .then(async () => {
    await store.loadSettings();
    installLoomProtocol({ store, rendererRoot: join(distRoot, 'renderer') });
    recorder.install();

    const recordingId = await recorder.start({ fps: 30, maxDimension: 1920, bitrate: 4_000_000 });
    await sleep(seconds * 1000);
    await recorder.stop();

    const summary = (await store.list()).find((s) => s.id === recordingId);
    const opened = await store.readProject(recordingId);
    const part = opened.recording?.tracks.screen?.parts[0];
    process.stdout.write(
      `${JSON.stringify({
        recordingId,
        state: summary?.state ?? null,
        error: opened.project.error ?? null,
        durationSec: part?.durationSec ?? 0,
        frameCount: part?.frameCount ?? 0,
        observedFps: part?.rate.observedFps ?? 0,
        size: part?.size ?? null,
        codec: part?.codec ?? null,
        droppedFrames: opened.recording?.capture.droppedFrames.screen ?? 0,
        path: summary?.path ?? null,
      })}\n`,
    );
    app.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`smoke capture failed: ${String(error)}\n`);
    app.exit(1);
  });
