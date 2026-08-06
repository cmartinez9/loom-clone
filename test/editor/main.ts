/**
 * Electron main for the editor gate.
 *
 * It builds a **real** recording — the committed H.264 fixture pushed through the
 * shipping `ProjectStore`, the shipping `MediaPartWriter` and the shipping
 * `recording.json` helpers, exactly as `apps/main/test/helpers/capture-child.ts`
 * does — and then opens the **shipping** editor on it: the real `WindowRegistry`
 * role, the real preload, the real `EditorWindows`, the real `loom://app/editor.html`
 * with the real `registerIpc` behind it. Nothing about the window or the recording
 * is reimplemented here, because a gate that builds its own window measures its own
 * window (`test/hud-notice.test.ts` makes the same argument for the HUD).
 *
 * ## What it is for
 *
 * Two things nothing else in this repo can establish:
 *
 *  1. **The preview draws a picture, and playback moves it.** Every cheaper check —
 *     a frame counter, "the canvas exists", "the playhead moved" — passes when the
 *     compositor is holding one stale frame forever, which is precisely what a
 *     source primed at the wrong instant produces (§4.3's hold).
 *  2. **A trim maps timeline time onto source time.** The recording is `testsrc2`,
 *     whose picture changes every frame, so the pixels at a given source instant
 *     are a fingerprint of that instant. Trim two seconds off the front, put the
 *     playhead at timeline 0, and the picture must be **the same bytes** as the
 *     picture at source 2.0 s before the trim — with a control, in the test half,
 *     that those bytes differ from the picture at source 0, so the equality cannot
 *     pass vacuously.
 *
 * And the ordinary end-to-end claim underneath both: the library's Open button
 * produces an editor, a drag on the timeline trims, and the trim is on disk
 * afterwards — read back through a **fresh** `ProjectStore` both while the editor
 * still holds the bundle and again after the window has closed, so what is asserted
 * survived the journal, the snapshot and a reopen rather than living in a renderer.
 *
 * ## What it deliberately does not measure
 *
 * The frame budget. `test/phase6-gate.test.ts` owns §8's 16.67 ms and the whole
 * argument about which hosts may be judged on it; a second gate timing the same
 * loop on a different workload would be a second, weaker opinion about the same
 * number.
 */

import { app, type BrowserWindow } from 'electron';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ProjectStore } from '../../apps/main/src/project-store.ts';
import { EditorWindows } from '../../apps/main/src/editor.ts';
import { registerIpc } from '../../apps/main/src/ipc.ts';
import { installLoomProtocol, registerLoomScheme } from '../../apps/main/src/protocol.ts';
import { WindowRegistry } from '../../apps/main/src/windows.ts';
import {
  finalizedRecordingDoc,
  provisionalRecordingDoc,
  withVideoPart,
} from '../../apps/main/src/recorder/recording-doc.ts';
import { loadEncodedFixture } from '../../packages/mux/test/helpers/fixture.ts';
import type { EditorReport, OnDisk, Reading } from './report.ts';

interface Args {
  rendererRoot: string;
  preloadPath: string;
  fixture: string;
  out: string;
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
    fixture: resolve(get('fixture')),
    out: resolve(get('out')),
    timeoutMs: Number.parseInt(get('timeout', '180000'), 10),
  };
}

const args = parseArgs(process.argv.slice(1));
const logs: string[] = [];
const readings: Reading[] = [];
const disk: OnDisk[] = [];
let finished = false;

function note(message: string): void {
  logs.push(message);
  console.log(`[editor-gate] ${message}`);
}

let report: EditorReport = {
  ok: false,
  error: '',
  recording: { id: '', durationSec: 0, frameCount: 0, size: [0, 0] },
  openedFromLibrary: false,
  lanes: [],
  readings,
  disk,
  logs,
};

async function finish(ok: boolean, error: string): Promise<void> {
  if (finished) return;
  finished = true;
  report = { ...report, ok, error };
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report, null, 2));
  app.exit(ok ? 0 : 1);
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// ---------------------------------------------------------------- the recording

/**
 * Build one `.loomrec` from the committed encoded fixture.
 *
 * The frames are real H.264 from a real encoder, written by the production path, so
 * what the editor decodes is a file this app could have produced. `testsrc2` is what
 * they contain, and the point of that is that **every frame is different**: a
 * picture read back at a given instant is a fingerprint of that instant.
 */
async function seedRecording(store: ProjectStore): Promise<EditorReport['recording']> {
  const fixture = loadEncodedFixture(args.fixture);
  const { id } = await store.create('Gate recording');
  await store.openProject(id);
  await store.setState(id, 'recording');

  const file = store.mediaRelativePath('screen', 0);
  const provisional = withVideoPart(
    provisionalRecordingDoc({
      display: {
        id: 1,
        name: 'Editor Gate Display',
        logicalSize: [fixture.width, fixture.height],
        pixelSize: [fixture.width, fixture.height],
        scaleFactor: 1,
        colorSpace: 'srgb',
      },
      requestedFps: fixture.fps,
      capture: {
        app: '0.0.0-editor-gate',
        os: process.platform,
        permissions: {
          screen: 'granted',
          camera: 'not-determined',
          microphone: 'not-determined',
          accessibility: false,
        },
        resolutionClamp: '3840px',
      },
    }),
    {
      track: 'screen',
      file,
      index: file.replace(/\.mp4$/, '.index.json'),
      codec: 'avc1.64000d',
      size: [fixture.width, fixture.height],
      requestedFps: fixture.fps,
      rateMode: 'variable',
      startTimeSec: 0,
    },
  );
  await store.writeRecordingDoc(id, provisional);

  await store.beginMediaPart(id, {
    track: 'screen',
    part: 0,
    width: fixture.width,
    height: fixture.height,
    avcC: fixture.avcC,
    nominalFps: fixture.fps,
  });
  for (const frame of fixture.frames) {
    await store.appendMediaChunk(id, 'screen', {
      data: frame.data,
      isKey: frame.isKey,
      timestampUs: frame.timestampUs,
      durationUs: null,
    });
  }
  const finalized = await store.finalizeMediaPart(id, 'screen');
  await store.writeRecordingDoc(
    id,
    finalizedRecordingDoc(provisional, {
      video: {
        screen: {
          droppedFrames: 0,
          parts: [
            {
              part: 0,
              startTimeSec: 0,
              durationSec: finalized.durationSec,
              frameCount: finalized.frameCount,
              observedFps: finalized.observedFps,
              endedEarly: false,
            },
          ],
        },
      },
    }),
  );
  await store.setState(id, 'editable');
  // Closed so the editor's own `openProject` takes the lock, exactly as it would
  // for a recording made in an earlier session.
  await store.close(id);

  note(
    `seeded ${id}: ${String(finalized.frameCount)} frames, ` +
      `${finalized.durationSec.toFixed(3)}s, ${String(fixture.width)}x${String(fixture.height)}`,
  );
  return {
    id,
    durationSec: finalized.durationSec,
    frameCount: finalized.frameCount,
    size: [fixture.width, fixture.height],
  };
}

// ---------------------------------------------------------------- probing

/**
 * One reading, taken inside the editor window.
 *
 * The picture is hashed **in the renderer**: a 1920×1080 readback is 8.3 MB and
 * there is no reason to move that across a process boundary to compare it with
 * another one. `distinct` and `coverage` are what separate "a picture" from "a flat
 * field", which is the assertion a frame counter cannot make.
 */
const READ_SCRIPT = `(() => {
  const probe = window.__loomEditor;
  if (probe === undefined) return null;
  const px = probe.readPixels();
  let hash = 0x811c9dc5;
  const seen = new Set();
  let background = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    hash ^= r; hash = Math.imul(hash, 0x01000193);
    hash ^= g; hash = Math.imul(hash, 0x01000193);
    hash ^= b; hash = Math.imul(hash, 0x01000193);
    if (seen.size < 4096) seen.add((r << 16) | (g << 8) | b);
    if (r === 0 && g === 0 && b === 0) background += 1;
  }
  const pixels = px.length / 4;
  const trouble = document.getElementById('trouble');
  return {
    timelineSec: probe.timelineSec,
    sourceSec: probe.sourceSec,
    durationSec: probe.durationSec,
    playing: probe.playing,
    trim: { startSec: probe.trim.startSec, endSec: probe.trim.endSec },
    clips: probe.clips.map((c) => ({ ...c })),
    picture: {
      hash: (hash >>> 0).toString(16),
      distinct: seen.size,
      coverage: (pixels - background) / pixels,
    },
    trouble: trouble.hidden ? '' : (trouble.textContent ?? ''),
    timecode: document.getElementById('tcode').textContent ?? '',
  };
})()`;

/** Just the hash, for the settle loop below — the cheapest thing that identifies a frame. */
const HASH_SCRIPT = `(() => {
  const px = window.__loomEditor.readPixels();
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i += 4) {
    h ^= px[i]; h = Math.imul(h, 0x01000193);
    h ^= px[i + 1]; h = Math.imul(h, 0x01000193);
    h ^= px[i + 2]; h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
})()`;

async function read(window: BrowserWindow, label: string): Promise<Reading> {
  const measured = (await window.webContents.executeJavaScript(READ_SCRIPT)) as Omit<
    Reading,
    'label'
  > | null;
  if (measured === null) throw new Error(`the editor never published its probe (at "${label}")`);
  const reading: Reading = { label, ...measured };
  readings.push(reading);
  note(
    `${label}: timeline ${reading.timelineSec.toFixed(3)}s source ${reading.sourceSec.toFixed(3)}s ` +
      `of ${reading.durationSec.toFixed(3)}s · picture ${reading.picture.hash} ` +
      `(${String(reading.picture.distinct)} distinct, ${(reading.picture.coverage * 100).toFixed(1)}% covered)` +
      (reading.trouble === '' ? '' : ` · trouble "${reading.trouble}"`),
  );
  return reading;
}

/**
 * `edit.json` on disk, through a store that has never seen this bundle before.
 *
 * `readProject` neither takes the lock nor migrates — the editor window still holds
 * it — and `readBundle` replays `edit.journal.ndjson` on top of the snapshot, which
 * is precisely what the next launch would read. So this is the durable state,
 * whether or not the 2-second snapshot debounce has fired yet.
 */
async function readDisk(recordingsRoot: string, id: string, label: string): Promise<OnDisk> {
  const fresh = new ProjectStore({
    recordingsRoot,
    settingsPath: join(recordingsRoot, '..', 'settings-read.json'),
    appVersion: '0.0.0-editor-gate',
    trash: () => Promise.resolve(),
  });
  await fresh.loadSettings();
  const opened = await fresh.readProject(id);
  const entry: OnDisk = {
    label,
    revision: opened.edit.revision,
    clips: opened.edit.clips.map((clip) => ({ ...clip })),
  };
  disk.push(entry);
  note(`disk ${label}: revision ${String(entry.revision)} clips ${JSON.stringify(entry.clips)}`);
  return entry;
}

/** Wait until the editor has published its probe and composited something. */
async function firstPicture(window: BrowserWindow, deadlineMs = 40_000): Promise<void> {
  await until(
    async () =>
      (await window.webContents.executeJavaScript(
        `(() => {
           const probe = window.__loomEditor;
           if (probe === undefined) return false;
           const px = probe.readPixels();
           for (let i = 0; i < px.length; i += 4) {
             if (px[i] !== 0 || px[i + 1] !== 0 || px[i + 2] !== 0) return true;
           }
           return false;
         })()`,
      )) as boolean,
    'the editor never composited anything that was not the background',
    deadlineMs,
  );
}

/** Two animation frames, so a change has been rendered before it is measured. */
function paint(window: BrowserWindow): Promise<void> {
  return window.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
  ) as Promise<void>;
}

/**
 * Wait for the picture under the playhead to stop changing.
 *
 * A seek is not instantaneous: `prime` reads bytes and the decoder produces frames
 * on its own schedule, and §4.3's hold leaves the previous composite on screen until
 * the right one arrives. Reading the hash immediately after a seek would therefore
 * sometimes read the frame *before* it — a flake that looks exactly like the defect
 * this gate exists to catch. Three identical reads is the settled picture.
 */
async function settledPicture(window: BrowserWindow, deadlineMs = 20_000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await paint(window);
    const hash = (await window.webContents.executeJavaScript(HASH_SCRIPT)) as string;
    if (hash === previous) {
      stable += 1;
      if (stable >= 3) return hash;
    } else {
      stable = 0;
      previous = hash;
    }
    await wait(30);
  }
  throw new Error('the picture never settled after a seek');
}

/**
 * Dispatch a key at an element, or at the window when `selector` is null.
 *
 * Synthetic rather than `sendInputEvent` because a key's whole path through this
 * page is a `keydown` listener reading `key`, `shiftKey` and `metaKey` — there is no
 * default action to trigger and no focus to chase. The pointer is different, and
 * {@link drag} says why.
 */
function key(
  window: BrowserWindow,
  selector: string | null,
  init: { key: string; shiftKey?: boolean; metaKey?: boolean },
): Promise<void> {
  const target =
    selector === null ? 'window' : `document.querySelector(${JSON.stringify(selector)})`;
  return window.webContents.executeJavaScript(
    `(${target}.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({
      bubbles: true,
      cancelable: true,
      ...init,
    })})), true)`,
  ) as Promise<void>;
}

/** An element's centre, in the window's own CSS pixels. */
async function centreOf(
  window: BrowserWindow,
  selector: string,
): Promise<{ x: number; y: number }> {
  return (await window.webContents.executeJavaScript(
    `(() => {
       const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
     })()`,
  )) as { x: number; y: number };
}

/**
 * Drag with **real** input events.
 *
 * `webContents.sendInputEvent` goes in at the top of Chromium's input pipeline, so
 * what the page sees is a genuine pointer with a genuine id — which matters,
 * because `setPointerCapture` refuses an id that was never active and a synthetic
 * `PointerEvent` has none. It also means the hit testing is the browser's opinion
 * about which element is under a coordinate rather than the gate's.
 */
async function drag(
  window: BrowserWindow,
  from: { x: number; y: number },
  toX: number,
): Promise<void> {
  const contents = window.webContents;
  contents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
  await wait(20);
  contents.sendInputEvent({
    type: 'mouseDown',
    x: from.x,
    y: from.y,
    button: 'left',
    clickCount: 1,
  });
  await wait(20);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((toX - from.x) * i) / steps);
    contents.sendInputEvent({ type: 'mouseMove', x, y: from.y, button: 'left' });
    await wait(16);
  }
  contents.sendInputEvent({ type: 'mouseUp', x: toX, y: from.y, button: 'left', clickCount: 1 });
  await wait(80);
}

async function until(
  condition: () => Promise<boolean>,
  message: string,
  deadlineMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(50);
  }
  throw new Error(message);
}

function loaded(window: BrowserWindow, what: string): Promise<void> {
  return new Promise<void>((resolveLoad, rejectLoad) => {
    window.webContents.once('did-finish-load', () => {
      resolveLoad();
    });
    window.webContents.once('did-fail-load', (_event, code, description) => {
      rejectLoad(new Error(`${what} failed to load: ${description} (${String(code)})`));
    });
  });
}

// ---------------------------------------------------------------- the run

registerLoomScheme();

void app.whenReady().then(async () => {
  setTimeout(() => {
    void finish(false, `the gate did not finish within ${String(args.timeoutMs)}ms`);
  }, args.timeoutMs).unref?.();

  try {
    const scratch = await mkdtemp(join(tmpdir(), 'loom-editor-gate-'));
    const recordingsRoot = join(scratch, 'recordings');
    const store = new ProjectStore({
      recordingsRoot,
      settingsPath: join(scratch, 'settings.json'),
      appVersion: '0.0.0-editor-gate',
      trash: () => Promise.resolve(),
    });
    await store.loadSettings();
    installLoomProtocol({ store, rendererRoot: args.rendererRoot });
    registerIpc({ store, appVersion: '0.0.0-editor-gate' });

    const recording = await seedRecording(store);
    report = { ...report, recording };

    const windows = new WindowRegistry({ preloadPath: args.preloadPath });
    const editors = new EditorWindows({
      store,
      windows,
      // Nothing is being recorded in this run; the refusal has its own coverage in
      // `apps/main/test/editor-window.test.ts`.
      activeRecordingId: () => null,
    });
    editors.install();

    // ---- the route a person takes: the library's Open button -----------------
    const library = windows.show('library');
    await loaded(library, 'library.html');
    await library.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await until(
      async () =>
        (await library.webContents.executeJavaScript(
          `document.querySelectorAll('.row').length > 0`,
        )) as boolean,
      'the library never listed the seeded recording',
    );
    await library.webContents.executeJavaScript(
      `(() => {
         const row = document.querySelector('.row');
         const open = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('Open'));
         if (open === undefined) throw new Error('the library row has no Open button');
         open.click();
         return true;
       })()`,
    );
    await until(
      () => Promise.resolve(windows.get('editor', recording.id) !== undefined),
      'clicking Open in the library produced no editor window',
    );
    report = { ...report, openedFromLibrary: true };
    note('the library opened the editor');

    const editor = windows.get('editor', recording.id);
    if (editor === undefined) throw new Error('no editor window');
    editor.webContents.on('console-message', (_event, _level, message) => {
      note(`renderer: ${message}`);
    });
    await loaded(editor, 'editor.html');
    await editor.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await firstPicture(editor);

    report = {
      ...report,
      lanes: (await editor.webContents.executeJavaScript(
        `[...document.querySelectorAll('.hd')].map((h) => h.textContent.trim())`,
      )) as string[],
    };

    // ---- the picture is a picture, and playback moves it ----------------------
    await key(editor, null, { key: 'Home' });
    await settledPicture(editor);
    await read(editor, 'playhead at 0');

    // Two seconds in, one 0.1 s arrow step at a time. Keys rather than a pointer so
    // the instant is an exact number and the comparison at the end can be on bytes.
    for (let i = 0; i < 20; i++) await key(editor, null, { key: 'ArrowRight' });
    await settledPicture(editor);
    await read(editor, 'playhead at 2s');

    // Playback: press space, let it run, read, and stop.
    await key(editor, null, { key: ' ' });
    await wait(900);
    await read(editor, 'playing');
    await key(editor, null, { key: ' ' });
    await wait(60);

    // ---- trimming, with a real drag ------------------------------------------
    await readDisk(recordingsRoot, recording.id, 'before any trim');
    const handle = await centreOf(editor, '#handle-end');
    const lanes = (await editor.webContents.executeJavaScript(
      `(() => { const r = document.getElementById('lanes').getBoundingClientRect();
                return { left: r.left, width: r.width }; })()`,
    )) as { left: number; width: number };
    // Two thirds of the way along the ruler, which for this recording is ~6.7 s.
    await drag(editor, handle, Math.round(lanes.left + lanes.width * (2 / 3)));
    await wait(200);
    await read(editor, 'after dragging the end handle');
    await readDisk(recordingsRoot, recording.id, 'after dragging the end handle');

    // ---- the domain proof ----------------------------------------------------
    // Undo the drag, then trim the *start* to exactly 2.0 s with the handle's own
    // keyboard nudge — two shifted steps of one second each — so the instant under
    // the playhead at timeline 0 is a number rather than wherever a pointer landed.
    await key(editor, null, { key: 'z', metaKey: true });
    await wait(150);
    await key(editor, '#handle-start', { key: 'ArrowRight', shiftKey: true });
    await key(editor, '#handle-start', { key: 'ArrowRight', shiftKey: true });
    await wait(150);
    await key(editor, null, { key: 'Home' });
    await settledPicture(editor);
    await read(editor, 'timeline 0 after trimming 2s off the front');
    await readDisk(recordingsRoot, recording.id, 'after trimming 2s off the front');

    // ---- and it is still there once the window has gone ----------------------
    // Closing the editor is what releases the bundle lock and writes the final
    // snapshot (`EditorWindows` installs that rule). Reading afterwards is the
    // round trip a person actually makes: edit, close, come back.
    editor.close();
    await until(
      () => Promise.resolve(windows.get('editor', recording.id) === undefined),
      'the editor window never closed',
    );
    // `store.close` is queued from the `closed` event, so give it its turn.
    await wait(1500);
    await readDisk(recordingsRoot, recording.id, 'after the editor window closed');

    await finish(true, '');
  } catch (error: unknown) {
    await finish(false, error instanceof Error ? error.message : String(error));
  }
});

app.on('window-all-closed', () => {
  void finish(false, 'every window closed before the gate finished');
});

process.on('uncaughtException', (error: Error) => {
  void finish(false, `uncaught in main: ${error.message}`);
});
