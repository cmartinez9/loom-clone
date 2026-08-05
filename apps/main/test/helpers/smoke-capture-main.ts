/**
 * An Electron main process that records for a few seconds and quits.
 *
 * Driven by `scripts/smoke-capture.mjs`. Not part of the app, and not part of
 * `npm test`: it needs a real display, a real GPU and — in its default mode — a real
 * Screen Recording grant, none of which a CI runner has.
 *
 * It exists because the automated gate stops at the IPC boundary. Everything below
 * it — the fragment writer, recovery, the documents — is covered by
 * `apps/main/test/capture-crash.test.ts` and friends, replaying encoded frames from
 * a fixture. Nothing there proves that `MediaStreamTrackProcessor` → `VideoEncoder`
 * → IPC actually produces those frames on this machine. This does, against the same
 * `RecorderSession` the app runs.
 *
 * ## Two source modes, and exactly what each one proves
 *
 * - **the default, with no flag,** is the whole leg: `desktopCapturer`
 *   enumeration, `setDisplayMediaRequestHandler` authorising the capture frame, and
 *   `getDisplayMedia` handing back a real ScreenCaptureKit track. It needs the
 *   Screen Recording grant and refuses to run without it, because a run that starts
 *   without it produces black frames or no frames and looks like a bug in our code.
 * - **`--synthetic`** replaces **only** the source acquisition — two assignments,
 *   to `navigator.mediaDevices.getDisplayMedia` and `getUserMedia`, evaluated in the
 *   real capture page — with a canvas stream and an oscillator. Everything
 *   downstream is the shipped path: the same `MediaStreamTrackProcessor` loops, the
 *   same `VideoEncoder` and `AudioEncoder`, the same encoded-chunk IPC, the same
 *   `ProjectStore`, the same fragmented MP4 and M4A, the same finalize. It runs on a
 *   machine with no Screen Recording grant, and it therefore proves nothing at all
 *   about the things it stands in for — see the carried-forward obligations in
 *   `AGENTS.md`.
 *
 * Neither mode substitutes for phase 2's signed-bundle check: in development TCC is
 * inherited from the terminal (research report §7, trap 6).
 *
 * Reports one line of JSON on stdout so the runner can assert on it rather than
 * read a log.
 */

import { app, shell, systemPreferences, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { ProjectStore } from '../../src/project-store.ts';
import { RecorderSession } from '../../src/recorder/session.ts';
import { installLoomProtocol, registerLoomScheme } from '../../src/protocol.ts';
import { WindowRegistry } from '../../src/windows.ts';
import { LOOM_BUNDLE_ID, LOOM_PRODUCT_NAME } from '../../src/identity.ts';

/** Exit code the runner reads as "the grant is missing", not "capture is broken". */
const EXIT_NO_SCREEN_PERMISSION = 3;

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? fallback : process.argv[at + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const recordingsRoot = arg('root');
const distRoot = arg('dist');
const seconds = Number(arg('seconds', '3'));
const synthetic = process.argv.includes('--synthetic');
const audio = !process.argv.includes('--no-audio');

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

/**
 * Refuse to record the screen without the grant, and say what to do about it.
 *
 * The alternative is what this script used to do: start anyway, watch
 * `desktopCapturer.getSources` reject with "Failed to get sources", and report
 * `state: "failed", error: "Invalid capture constraints"` — three layers away from
 * the one fact that matters.
 *
 * Nothing here asks for the permission. In development the grant belongs to the
 * terminal, not to us (research report §7, trap 6), so prompting would either do
 * nothing or grant the wrong binary; and a dev binary inheriting the terminal's TCC
 * is exactly the misleading pass phase 2's signed-bundle gate exists to prevent.
 */
function screenPermissionProblem(): string | null {
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return null;
  return [
    `Screen Recording is "${status}" for the process running this smoke capture, so`,
    'there is no screen to record.',
    '',
    'Grant it in System Settings > Privacy & Security > Screen & System Audio',
    'Recording, to the program you ran this from — in development that is your',
    'terminal (Terminal, iTerm, or the editor whose integrated terminal this is),',
    'NOT an entry called "Loom Clone", because a dev build inherits the terminal\'s',
    'TCC. Quit and reopen that program afterwards; the grant is read at launch.',
    '',
    'To exercise everything below the display source without the grant:',
    '',
    '    node scripts/smoke-capture.mjs --synthetic',
    '',
    'That substitutes only getDisplayMedia. It does not exercise desktopCapturer',
    'enumeration, setDisplayMediaRequestHandler, or setContentProtection.',
  ].join('\n');
}

/**
 * Put a canvas stream where the display source would be, inside the real page.
 *
 * One assignment, evaluated in the capture page's own world before it is told to
 * start, so `begin()` runs the shipped code from `MediaStreamTrackProcessor`
 * onwards against a track it cannot tell apart from a screen. The canvas is
 * repainted on a timer rather than `requestAnimationFrame` because the capture
 * window is a hidden 1×1 (§1.2) and a hidden window's frame callbacks do not fire;
 * and it is repainted at all because `captureStream` emits a frame when the canvas
 * changes, so a static canvas would reproduce the very "screen stopped changing"
 * silence the stop-instant fix exists to handle.
 */
function syntheticSourceScript(width: number, height: number, fps: number): string {
  return `(() => {
    const canvas = document.createElement('canvas');
    canvas.width = ${String(width)};
    canvas.height = ${String(height)};
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('the synthetic source could not get a 2d context');
    const stream = canvas.captureStream(${String(fps)});
    const track = stream.getVideoTracks()[0];
    let n = 0;
    const timer = setInterval(() => {
      if (track === undefined || track.readyState !== 'live') {
        clearInterval(timer);
        return;
      }
      n += 1;
      ctx.fillStyle = '#F4F0E4';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#C7442E';
      const span = Math.max(1, canvas.width - 160);
      ctx.fillRect((n * 11) % span, canvas.height / 3, 160, canvas.height / 3);
      ctx.fillStyle = '#100E09';
      ctx.font = '64px monospace';
      ctx.fillText('frame ' + String(n), 32, 96);
    }, ${String(Math.max(1, Math.round(1000 / fps)))});
    // A tone for the audio half. The oscillator goes through the same
    // MediaStreamTrackProcessor -> AudioEncoder path a loopback track would, so
    // what this exercises is the pipeline and the clock, not the device.
    const audioContext = new AudioContext({ sampleRate: 48000 });
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    const audioTrack = destination.stream.getAudioTracks()[0];

    navigator.mediaDevices.getDisplayMedia = (options) => {
      const out = new MediaStream(stream.getVideoTracks());
      if (options && options.audio && audioTrack !== undefined) out.addTrack(audioTrack.clone());
      return Promise.resolve(out);
    };
    navigator.mediaDevices.getUserMedia = () => {
      if (audioTrack === undefined) return Promise.reject(new Error('no synthetic microphone'));
      return Promise.resolve(new MediaStream([audioTrack.clone()]));
    };
    return String(canvas.width) + 'x' + String(canvas.height);
  })()`;
}

/**
 * Open the capture page and wait for it, so the substitution lands before the
 * `start` command does. `RecorderSession.start` reuses this same window.
 */
async function readyCapturePage(): Promise<BrowserWindow> {
  const window = windows.show('capture');
  const contents = window.webContents;
  if (contents.isLoadingMainFrame()) {
    await new Promise<void>((resolve, reject) => {
      contents.once('did-finish-load', () => {
        resolve();
      });
      contents.once('did-fail-load', (_event: unknown, code: number, description: string) => {
        reject(new Error(`the capture page failed to load: ${description} (${String(code)})`));
      });
    });
  }
  return window;
}

app
  .whenReady()
  .then(async () => {
    if (!synthetic) {
      const problem = screenPermissionProblem();
      if (problem !== null) {
        process.stderr.write(`${problem}\n`);
        app.exit(EXIT_NO_SCREEN_PERMISSION);
        return;
      }
    }

    await store.loadSettings();
    installLoomProtocol({ store, rendererRoot: join(distRoot, 'renderer') });
    recorder.install();

    const options = {
      fps: 30,
      maxDimension: 1920,
      bitrate: 4_000_000,
      systemAudio: audio,
      micDeviceId: audio ? 'default' : null,
    };
    if (synthetic) {
      const width = Math.min(1280, options.maxDimension);
      const window = await readyCapturePage();
      await window.webContents.executeJavaScript(
        syntheticSourceScript(width, Math.round((width * 9) / 16), options.fps),
      );
    }

    const recordingId = await recorder.start(options);
    await sleep(seconds * 1000);
    await recorder.stop();

    const summary = (await store.list()).find((s) => s.id === recordingId);
    const opened = await store.readProject(recordingId);
    const part = opened.recording?.tracks.screen?.parts[0];
    // Every fact A/V sync rests on, for a human to read: what the device claimed,
    // what it actually ran at, where it started relative to the first screen frame,
    // and whether macOS honoured the constraints of research trap 3.
    const audioTracks = (['mic', 'system'] as const).flatMap((key) => {
      const track = opened.recording?.tracks[key];
      const audioPart = track?.parts[0];
      if (track === undefined || audioPart === undefined) return [];
      return [
        {
          track: key,
          deviceName: track.deviceName ?? null,
          constraints: track.constraints ?? null,
          sampleRate: audioPart.sampleRate,
          measuredSampleRate: audioPart.measuredSampleRate,
          startTimeSec: audioPart.startTimeSec,
          durationSec: audioPart.durationSec,
          gaps: audioPart.gaps.length,
        },
      ];
    });
    process.stdout.write(
      `${JSON.stringify({
        recordingId,
        source: synthetic ? 'synthetic' : 'screen',
        state: summary?.state ?? null,
        error: opened.project.error ?? null,
        durationSec: part?.durationSec ?? 0,
        frameCount: part?.frameCount ?? 0,
        observedFps: part?.rate.observedFps ?? 0,
        size: part?.size ?? null,
        codec: part?.codec ?? null,
        droppedFrames: opened.recording?.capture.droppedFrames.screen ?? 0,
        audio: audioTracks,
        path: summary?.path ?? null,
      })}\n`,
    );
    app.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`smoke capture failed: ${String(error)}\n`);
    app.exit(1);
  });
