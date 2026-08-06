/**
 * Electron main for the phase-15 gate: the editor's **controls**.
 *
 * Phase 14 proved a person can open a recording, watch it, scrub it and trim it. This
 * proves the four things the captain's editor-scope decision put beside that —
 * keyframe editing, **manual zoom control**, annotation tools, and §3.5's regenerate
 * and bake — and it proves the one thing that makes them worth anything: *what the
 * user did survives to disk and reaches an exported file*.
 *
 * Everything below the harness is the shipping path. The recording is built with the
 * shipping `ProjectStore` from the committed H.264 fixture; the event logs are written
 * through the shipping `createEventLog`/`appendEventLog`, the same calls `InputSampler`
 * makes; the editor is opened by clicking the library's own **Open** button; every
 * control is driven by a real `sendInputEvent` gesture or a real `click()` on a button
 * the page built; and the exports are the real `ExportSession` writing real MP4s that
 * §7.5's real verification then checks.
 *
 * ## The assertions this exists for, and why each needs a real run
 *
 * 1. **A generator runs from a button, over a real log.** `packages/edl`'s gate proves
 *    the generators over ten real recordings; nothing has ever run one from a window,
 *    and the parts that were missing — reading `events/*.ndjson` over `loom://`,
 *    hashing them for §3.5's fingerprint, asking `recording.json` whether the tap was
 *    live — are exactly the parts a pure test cannot exercise.
 *
 * 2. **§3.5's stack, measured rather than asserted.** The manual zoom must win *inside*
 *    its window and defer *outside* it, and the reading is `resolve(...)` off the
 *    shipping compiled timeline plus the composited pixels. Both, because a document
 *    that says the right thing and a picture that shows it are different claims.
 *
 * 3. **The generated track is untouched.** §3.5: *"Regeneration rewrites only the
 *    generated track. User edits survive by construction, because they were never in
 *    that track."* Taking manual control must therefore leave it byte-for-byte alone,
 *    and a *bake* must move the spec to `generatedFrom` and remove the block by name.
 *
 * 4. **It reaches an exported file.** Two real exports of one recording — one before
 *    the user takes manual control and one after — decoded back out of the finished
 *    MP4s at the same frame. **Inside** the manual window the two pictures must differ
 *    substantially; **outside** it they must agree, because there the generator drives
 *    both. The second half is the control: without it, "the export changed" is
 *    satisfied by an export that changed everywhere, which is what a broken clip list
 *    or a wrong frame selection would produce.
 *
 * ## What it deliberately does not measure
 *
 * The frame budget (`test/phase6-gate.test.ts` owns §8's 16.67 ms and the argument
 * about which hosts may be judged on it) and §4.5's per-pixel preview/export identity
 * (`test/phase8-gate.test.ts` owns that, over two contexts and two readers). A second,
 * weaker opinion about either would make both harder to trust.
 */

import { app, type BrowserWindow } from 'electron';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { ProjectStore } from '../../apps/main/src/project-store.ts';
import { EditorWindows } from '../../apps/main/src/editor.ts';
import { ExportSession } from '../../apps/main/src/export/session.ts';
import { registerExportRenderIpc, registerIpc } from '../../apps/main/src/ipc.ts';
import { installLoomProtocol, registerLoomScheme } from '../../apps/main/src/protocol.ts';
import { WindowRegistry } from '../../apps/main/src/windows.ts';
import {
  finalizedRecordingDoc,
  provisionalRecordingDoc,
  withVideoPart,
} from '../../apps/main/src/recorder/recording-doc.ts';
import { movieHeaderLength, parseMovie, HEADER_PROBE_BYTES } from '../../packages/mux/src/index.ts';
import { loadEncodedFixture } from '../../packages/mux/test/helpers/fixture.ts';
import type { ExportProgress } from '../../packages/ipc/src/index.ts';
import type { ControlsReport, ExportReading, FrameDelta, OnDisk, Reading } from './report.ts';

interface Args {
  rendererRoot: string;
  preloadPath: string;
  fixture: string;
  out: string;
  timeoutMs: number;
  /**
   * Where to write PNGs of the editor as it goes, or `''` for none.
   *
   * Absent in the gate run and present when a person wants to *look* at this window.
   * It is here rather than in `scripts/screenshot.cjs` because that script boots the
   * real main process, whose recordings root is `homedir()` with no override — so it
   * cannot be pointed at a scratch library, and seeding the captain's real one is not
   * acceptable. This harness already builds a throwaway recording with logs in it and
   * drives every control; a `capturePage()` beside each reading costs a flag.
   *
   * `AGENTS.md` records two editor defects that only a screenshot found — a stage
   * fitted by CSS that went circular, and a missing `[hidden]` rule that left the
   * refusal card over the window permanently. Neither had a failing test.
   */
  shots: string;
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
    rendererRoot: resolvePath(get('renderer')),
    preloadPath: resolvePath(get('preload')),
    fixture: resolvePath(get('fixture')),
    out: resolvePath(get('out')),
    timeoutMs: Number.parseInt(get('timeout', '300000'), 10),
    shots: get('shots', ''),
  };
}

const args = parseArgs(process.argv.slice(1));
const notes: string[] = [];
const readings: Reading[] = [];
const disk: OnDisk[] = [];
const exports_: ExportReading[] = [];
const deltas: FrameDelta[] = [];
let finished = false;

function note(message: string): void {
  notes.push(message);
  console.log(`[p15] ${message}`);
}

let report: ControlsReport = {
  ok: false,
  error: '',
  recording: { id: '', durationSec: 0, frameCount: 0, size: [0, 0] },
  logs: { cursorSamples: 0, clickDowns: 0 },
  openedFromLibrary: false,
  lanes: [],
  tools: [],
  readings,
  disk,
  exports: exports_,
  deltas,
  notes,
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

// ------------------------------------------------------------------- the clicks

/**
 * Where the clicks go, and what §6.5 makes of them.
 *
 * Two clusters, chosen so the harness knows the answer before it runs: §6.5's
 * `clusterGapSec` is `preRollSec + postRollSec + mergeGapSec` = 2.6 s, so 4.0 and 4.5
 * are one cluster and 8.0 and 8.6 are another; `mergeGapSec` is 0.8 s and the gap
 * between the two segments is 1.7 s, so step 4 does not merge them. That gives
 * **two** segments, `[3.4, 5.7]` and `[7.4, 9.8]`, and two instants this gate can name:
 * one the user takes control of, and one where the generator is left alone.
 */
const CLICK_TIMES = [4.0, 4.5, 8.0, 8.6];
/** Inside the first segment's hold, a full settle past its first key. */
const INSIDE_SEC = 5.0;
/** Inside the **second** segment's hold — the generator's, all the way through. */
const OUTSIDE_SEC = 8.8;

/** §2.5's cursor log: a slow drift, at the sampler's own 120 Hz. */
function cursorNdjson(seconds: number): { text: string; samples: number } {
  const lines: string[] = [];
  const count = Math.round(seconds * 120);
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        t: i / 120,
        x: 0.2 + (0.6 * i) / count,
        y: 0.5,
        c: 'arrow',
        m: 0,
      }),
    );
  }
  return { text: `${lines.join('\n')}\n`, samples: count };
}

/** §2.5's click log. One `down`/`up` pair per click, at the same point. */
function clicksNdjson(): { text: string; downs: number } {
  const lines = CLICK_TIMES.flatMap((t) => [
    JSON.stringify({ t, e: 'down', b: 0, x: 0.4, y: 0.45, m: 0 }),
    JSON.stringify({ t: t + 0.05, e: 'up', b: 0, x: 0.4, y: 0.45, m: 0 }),
  ]);
  return { text: `${lines.join('\n')}\n`, downs: CLICK_TIMES.length };
}

// ---------------------------------------------------------------- the recording

async function seedRecording(store: ProjectStore): Promise<ControlsReport['recording']> {
  const fixture = loadEncodedFixture(args.fixture);
  const { id } = await store.create('Controls gate');
  await store.openProject(id);
  await store.setState(id, 'recording');

  const file = store.mediaRelativePath('screen', 0);
  const provisional = withVideoPart(
    provisionalRecordingDoc({
      display: {
        id: 1,
        name: 'Controls Gate Display',
        logicalSize: [fixture.width, fixture.height],
        pixelSize: [fixture.width, fixture.height],
        scaleFactor: 1,
        colorSpace: 'srgb',
      },
      requestedFps: fixture.fps,
      capture: {
        app: '0.0.0-p15-gate',
        os: process.platform,
        permissions: {
          screen: 'granted',
          camera: 'not-determined',
          microphone: 'not-determined',
          // The grant a click log needs, and the gate is about what the editor does
          // with one — `apps/main/test/recorder-events.test.ts` is where the sampler's
          // own behaviour under a *denied* grant is measured.
          accessibility: true,
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

  // The event logs, through the sampler's own two calls. `createEventLog` before
  // `appendEventLog` because §2.5 makes the difference load-bearing: a `clicks.ndjson`
  // that exists asserts "we were watching", and creating one speculatively would be a
  // lie on a machine without the Accessibility grant.
  const cursor = cursorNdjson(finalized.durationSec);
  const clicks = clicksNdjson();
  await store.createEventLog(id, 'cursor');
  await store.appendEventLog(id, 'cursor', cursor.text);
  await store.syncEventLog(id, 'cursor');
  await store.createEventLog(id, 'clicks');
  await store.appendEventLog(id, 'clicks', clicks.text);
  await store.syncEventLog(id, 'clicks');
  report = { ...report, logs: { cursorSamples: cursor.samples, clickDowns: clicks.downs } };

  const doc = finalizedRecordingDoc(provisional, {
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
  });
  // §2.5's declaration of the two logs. `recording.json` is what says where they are
  // and — for clicks — whether the tap was ever live; the editor reads both from it
  // rather than probing the filesystem it does not have.
  await store.writeRecordingDoc(id, {
    ...doc,
    events: {
      ...doc.events,
      cursor: { file: 'events/cursor.ndjson', hz: 120, sampleCount: cursor.samples },
      clicks: { file: 'events/clicks.ndjson', available: true, source: 'cgeventtap' },
    },
  });
  await store.setState(id, 'editable');
  await store.close(id);

  note(
    `seeded ${id}: ${String(finalized.frameCount)} frames, ${finalized.durationSec.toFixed(3)}s, ` +
      `${String(cursor.samples)} cursor samples, ${String(clicks.downs)} clicks`,
  );
  return {
    id,
    durationSec: finalized.durationSec,
    frameCount: finalized.frameCount,
    size: [fixture.width, fixture.height],
  };
}

// ---------------------------------------------------------------- reading

/**
 * One reading, taken inside the editor window.
 *
 * The picture is hashed **in the renderer** — a 1920×1080 readback is 8.3 MB — and so
 * are the box statistics, because "the picture changed" and "it changed *here*" are
 * different claims and an annotation's whole job is the second one.
 */
function readScript(
  boxes: readonly { label: string; box: [number, number, number, number] }[],
): string {
  return `(() => {
  const probe = window.__loomEditor;
  if (probe === undefined) return null;
  const px = probe.readPixels();
  const [w, h] = probe.outputSize;
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
  const boxes = ${JSON.stringify(boxes)}.map((entry) => {
    const [x0, y0, x1, y1] = entry.box;
    const left = Math.max(0, Math.floor(x0 * w));
    const right = Math.min(w, Math.ceil(x1 * w));
    const top = Math.max(0, Math.floor(y0 * h));
    const bottom = Math.min(h, Math.ceil(y1 * h));
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (y * w + x) * 4;
        sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n += 1;
      }
    }
    const mean = n === 0 ? [0, 0, 0] : [sr / n, sg / n, sb / n];
    let variance = 0;
    if (n > 0) {
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const i = (y * w + x) * 4;
          const d = (px[i] + px[i + 1] + px[i + 2]) / 3 - (mean[0] + mean[1] + mean[2]) / 3;
          variance += d * d;
        }
      }
      variance /= n;
    }
    return { label: entry.label, mean, variance };
  });
  const trouble = document.getElementById('trouble');
  return {
    timelineSec: probe.timelineSec,
    sourceSec: probe.sourceSec,
    durationSec: probe.durationSec,
    zoom: probe.zoom,
    tracks: probe.tracks,
    regions: probe.regions.map((r) => ({
      index: r.index, startSec: r.startSec, endSec: r.endSec, amount: r.amount,
    })),
    annotations: probe.annotations,
    picture: { hash: (hash >>> 0).toString(16), distinct: seen.size, coverage: (pixels - background) / pixels, boxes },
    trouble: trouble.hidden ? '' : (trouble.textContent ?? ''),
  };
})()`;
}

/**
 * Where the mask is drawn, in fractions of the canvas.
 *
 * One constant, used both to aim the drag and to derive the box the reading is taken
 * over, so the two cannot drift — the first version measured a box **larger** than the
 * drag and reported a mask covering 73% of it as a failure.
 */
const MASK_DRAG = { x0: 0.38, y0: 0.38, x1: 0.62, y1: 0.62 };

/** Inset from the drag, so an edge feather cannot be mistaken for a mask that missed. */
const MASK_INSET = 0.04;

/** The boxes every reading measures: inside the mask, and a patch far from it. */
const BOXES = [
  {
    label: 'mask',
    box: [
      MASK_DRAG.x0 + MASK_INSET,
      MASK_DRAG.y0 + MASK_INSET,
      MASK_DRAG.x1 - MASK_INSET,
      MASK_DRAG.y1 - MASK_INSET,
    ] as [number, number, number, number],
  },
  { label: 'corner', box: [0.02, 0.02, 0.18, 0.18] as [number, number, number, number] },
];

/** A PNG of the editor, when `--shots` asked for one. A no-op otherwise. */
async function shoot(window: BrowserWindow, label: string): Promise<void> {
  if (args.shots === '') return;
  await mkdir(args.shots, { recursive: true });
  const image = await window.webContents.capturePage();
  await writeFile(join(args.shots, `${label.replace(/[^a-z0-9]+/gi, '-')}.png`), image.toPNG());
}

async function read(window: BrowserWindow, label: string): Promise<Reading> {
  const measured = (await window.webContents.executeJavaScript(readScript(BOXES))) as Omit<
    Reading,
    'label'
  > | null;
  if (measured === null) throw new Error(`the editor never published its probe (at "${label}")`);
  const reading: Reading = { label, ...measured };
  readings.push(reading);
  await shoot(window, label);
  note(
    `${label}: t=${reading.timelineSec.toFixed(3)} src=${reading.sourceSec.toFixed(3)} ` +
      `zoom=${reading.zoom.amount.toFixed(3)}@[${reading.zoom.center.map((v) => v.toFixed(3)).join(',')}] ` +
      `pic=${reading.picture.hash} tracks=${reading.tracks.map((t) => t.id).join('|')}` +
      (reading.trouble === '' ? '' : ` TROUBLE "${reading.trouble}"`),
  );
  return reading;
}

async function readDisk(recordingsRoot: string, id: string, label: string): Promise<OnDisk> {
  const fresh = new ProjectStore({
    recordingsRoot,
    settingsPath: join(recordingsRoot, '..', 'settings-read.json'),
    appVersion: '0.0.0-p15-gate',
    trash: () => Promise.resolve(),
  });
  await fresh.loadSettings();
  const opened = await fresh.readProject(id);
  const entry: OnDisk = {
    label,
    revision: opened.edit.revision,
    trackIds: opened.edit.tracks.map((track) => track.id),
    tracks: opened.edit.tracks.map((track) => ({
      id: track.id,
      origin: track.origin,
      generated: track.generator !== undefined,
      baked: track.origin === 'manual' && track.generatedFrom !== undefined,
      activeRanges: track.activeRanges.map((range) => [range[0], range[1]] as [number, number]),
      keyTimes: Object.fromEntries(
        Object.entries(track.channels).map(([name, channel]) => [
          name,
          channel.keys.map((key) => key.t),
        ]),
      ),
      spanIds: (track.spans ?? []).map((span) => span.id),
    })),
  };
  disk.push(entry);
  note(`disk ${label}: rev=${String(entry.revision)} tracks=${entry.trackIds.join('|')}`);
  return entry;
}

// ---------------------------------------------------------------- driving the UI

function paint(window: BrowserWindow): Promise<void> {
  return window.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
  ) as Promise<void>;
}

async function until(
  condition: () => Promise<boolean>,
  message: string,
  deadlineMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(50);
  }
  throw new Error(message);
}

/** Wait for the picture under the playhead to stop changing. Phase 14's rule. */
async function settled(window: BrowserWindow, deadlineMs = 20_000): Promise<string> {
  const script = `(() => {
    const px = window.__loomEditor.readPixels();
    let h = 0x811c9dc5;
    for (let i = 0; i < px.length; i += 4) {
      h ^= px[i]; h = Math.imul(h, 0x01000193);
      h ^= px[i + 1]; h = Math.imul(h, 0x01000193);
      h ^= px[i + 2]; h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  })()`;
  const deadline = Date.now() + deadlineMs;
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await paint(window);
    const hash = (await window.webContents.executeJavaScript(script)) as string;
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

/** Put the playhead at a source instant, exactly, through the probe's own seek path. */
async function seekTo(window: BrowserWindow, sourceSec: number): Promise<void> {
  // Through the transport's keyboard, so the path is the shipping one: Home, then
  // whole 1 s steps and 0.1 s steps. An exact instant matters — the assertions
  // compare the zoom the timeline resolves at a named time.
  await key(window, null, { key: 'Home' });
  const whole = Math.floor(sourceSec);
  for (let i = 0; i < whole; i++) await key(window, null, { key: 'ArrowRight', shiftKey: true });
  const tenths = Math.round((sourceSec - whole) * 10);
  for (let i = 0; i < tenths; i++) await key(window, null, { key: 'ArrowRight' });
  await settled(window);
}

/** Click a button the page built, found by a CSS selector, and fail loudly if absent. */
async function clickButton(window: BrowserWindow, selector: string): Promise<void> {
  const found = (await window.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return false;
       el.click();
       return true;
     })()`,
  )) as boolean;
  if (!found) throw new Error(`the editor has no ${selector}`);
  await wait(120);
}

/** Click a button by its visible text, inside a container. */
async function clickByText(window: BrowserWindow, container: string, text: string): Promise<void> {
  const found = (await window.webContents.executeJavaScript(
    `(() => {
       const host = document.querySelector(${JSON.stringify(container)});
       if (host === null) return false;
       const button = [...host.querySelectorAll('button')].find(
         (b) => (b.textContent ?? '').includes(${JSON.stringify(text)}),
       );
       if (button === undefined) return false;
       button.click();
       return true;
     })()`,
  )) as boolean;
  if (!found) throw new Error(`no button reading "${text}" inside ${container}`);
  await wait(150);
}

/** Set a range input and fire the `input` its listener commits on. */
async function setRange(window: BrowserWindow, name: string, value: number): Promise<void> {
  const found = (await window.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector('input[name=' + JSON.stringify(${JSON.stringify(name)}) + ']');
       if (el === null) return false;
       el.value = ${JSON.stringify(String(value))};
       el.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
  )) as boolean;
  if (!found) throw new Error(`the inspector has no field named ${name}`);
  await wait(200);
}

/**
 * Drag with **real** input events, in window CSS pixels.
 *
 * `sendInputEvent` goes in at the top of Chromium's input pipeline, so the page sees a
 * genuine pointer with a genuine id — which matters, because `setPointerCapture`
 * refuses an id that was never active — and the hit testing is the browser's opinion
 * about what is under a coordinate rather than the gate's.
 */
async function drag(
  window: BrowserWindow,
  from: { x: number; y: number },
  to: { x: number; y: number },
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
    contents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      button: 'left',
    });
    await wait(16);
  }
  contents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await wait(150);
}

async function boxOf(
  window: BrowserWindow,
  selector: string,
): Promise<{ left: number; top: number; width: number; height: number }> {
  const box = (await window.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return null;
       const r = el.getBoundingClientRect();
       return { left: r.left, top: r.top, width: r.width, height: r.height };
     })()`,
  )) as { left: number; top: number; width: number; height: number } | null;
  if (box === null) throw new Error(`the editor has no ${selector}`);
  return box;
}

// ---------------------------------------------------------------- the export

/**
 * Decode one frame out of a finished MP4, in a renderer, and report it.
 *
 * The sample table is read **off the disk** with `parseMovie` — the same reader §7.5's
 * verification demuxes with — the GOP containing the wanted frame is sliced out of the
 * file, and the chunks are handed to a real `VideoDecoder`. Nothing here trusts the
 * writer's memory: if the file's own tables do not describe the picture, this reports
 * whatever they do describe.
 */
async function decodeExportFrame(
  window: BrowserWindow,
  path: string,
  timelineSec: number,
  fps: number,
): Promise<{ hash: string; mean: [number, number, number] }> {
  const bytes = new Uint8Array(await readFile(path));
  const headerLength = movieHeaderLength(bytes.subarray(0, HEADER_PROBE_BYTES));
  if (headerLength === null) throw new Error(`${path} has no faststart header`);
  const movie = parseMovie(bytes.subarray(0, headerLength));
  const track = movie.tracks.find((candidate) => candidate.handler === 'vide');
  if (track === undefined) throw new Error(`${path} has no video track`);
  if (track.codecDescription === null) throw new Error(`${path} carries no avcC`);

  const wanted = Math.min(track.samples.length - 1, Math.max(0, Math.round(timelineSec * fps)));
  let syncAt = 0;
  for (let i = wanted; i >= 0; i--) {
    if (track.samples[i]?.isSync === true) {
      syncAt = i;
      break;
    }
  }
  const chunks = track.samples.slice(syncAt, wanted + 1).map((sample) => ({
    isKey: sample.isSync,
    timestampUs: Math.round((sample.decodeUnits / track.timescale) * 1e6),
    data: Buffer.from(bytes.subarray(sample.offset, sample.offset + sample.byteLength)).toString(
      'base64',
    ),
  }));
  const avcC = track.codecDescription;
  const codec = `avc1.${[avcC[1], avcC[2], avcC[3]]
    .map((byte) => (byte ?? 0).toString(16).padStart(2, '0'))
    .join('')}`;

  const measured = (await window.webContents.executeJavaScript(
    `(async () => {
      const chunks = ${JSON.stringify(chunks)};
      const description = Uint8Array.from(atob(${JSON.stringify(
        Buffer.from(avcC).toString('base64'),
      )}), (c) => c.charCodeAt(0));
      const frames = [];
      const decoder = new VideoDecoder({
        output: (frame) => { frames.push(frame); },
        error: (e) => { console.error('[p15 decode]', e.message); },
      });
      decoder.configure({
        codec: ${JSON.stringify(codec)},
        codedWidth: ${String(track.width)},
        codedHeight: ${String(track.height)},
        description,
      });
      for (const chunk of chunks) {
        decoder.decode(new EncodedVideoChunk({
          type: chunk.isKey ? 'key' : 'delta',
          timestamp: chunk.timestampUs,
          data: Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)),
        }));
      }
      await decoder.flush();
      decoder.close();
      if (frames.length === 0) throw new Error('the export decoded no frames');
      // Presentation order is decode order — the export encoder runs
      // \`latencyMode: 'realtime'\` precisely so that is true and \`FastStartWriter\`
      // needs no \`ctts\` — so the last frame out is the one asked for.
      const frame = frames[frames.length - 1];
      try {
        const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(frame, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 0x811c9dc5, sr = 0, sg = 0, sb = 0;
        for (let i = 0; i < data.length; i += 4) {
          hash ^= data[i]; hash = Math.imul(hash, 0x01000193);
          hash ^= data[i + 1]; hash = Math.imul(hash, 0x01000193);
          hash ^= data[i + 2]; hash = Math.imul(hash, 0x01000193);
          sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
        }
        const n = data.length / 4;
        return {
          hash: (hash >>> 0).toString(16),
          mean: [sr / n, sg / n, sb / n],
          pixels: [...data],
        };
      } finally {
        for (const f of frames) f.close();
      }
    })()`,
  )) as { hash: string; mean: [number, number, number]; pixels: number[] };

  decodedPixels.set(`${path}@${String(timelineSec)}`, measured.pixels);
  return { hash: measured.hash, mean: measured.mean };
}

/** RGBA of every decoded export frame, so two exports can be differenced. */
const decodedPixels = new Map<string, number[]>();

/** Mean absolute RGB difference between two decoded frames, `0..255`. */
function meanAbsDifference(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < length; i += 4) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    sum += Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0));
    sum += Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
    count += 3;
  }
  return count === 0 ? 0 : sum / count;
}

/** Export settings both runs share, so the two files are comparable pixel for pixel. */
const EXPORT_WIDTH = 640;
const EXPORT_HEIGHT = 360;
const EXPORT_FPS = 30;

async function runExport(
  session: ExportSession,
  progress: Map<string, ExportProgress>,
  id: string,
  name: string,
): Promise<ExportProgress> {
  const { jobId } = await session.start(id, {
    name,
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    fps: EXPORT_FPS,
    // The gate is about the editor, not about §7.5's retention: a verified export
    // that deleted `media/` would take the recording out from under everything after
    // it. Phase 9's own gate is where deletion is measured.
    keepSources: true,
  });
  await until(
    () => {
      const latest = progress.get(jobId);
      return Promise.resolve(
        latest !== undefined && ['done', 'failed', 'cancelled'].includes(latest.phase),
      );
    },
    `the export "${name}" never finished`,
    240_000,
  );
  const final = progress.get(jobId);
  if (final === undefined) throw new Error(`no progress for the export "${name}"`);
  return final;
}

// ---------------------------------------------------------------- the run

registerLoomScheme();

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

void app.whenReady().then(async () => {
  setTimeout(() => {
    void finish(false, `the gate did not finish within ${String(args.timeoutMs)}ms`);
  }, args.timeoutMs).unref?.();

  try {
    const scratch = await mkdtemp(join(tmpdir(), 'loom-p15-gate-'));
    const recordingsRoot = join(scratch, 'recordings');
    const store = new ProjectStore({
      recordingsRoot,
      settingsPath: join(scratch, 'settings.json'),
      appVersion: '0.0.0-p15-gate',
      trash: () => Promise.resolve(),
    });
    await store.loadSettings();
    installLoomProtocol({ store, rendererRoot: args.rendererRoot });

    const recording = await seedRecording(store);
    report = { ...report, recording };

    const windows = new WindowRegistry({ preloadPath: args.preloadPath });
    const editors = new EditorWindows({ store, windows, activeRecordingId: () => null });
    editors.install();

    const progress = new Map<string, ExportProgress>();
    const exportSession = new ExportSession({
      store,
      openWindow: (jobId) => windows.show('export', jobId),
      findWindow: (jobId) => windows.get('export', jobId),
      closeWindow: (jobId) => {
        windows.get('export', jobId)?.destroy();
      },
      broadcast: (update) => progress.set(update.jobId, update),
      // The clipboard is global state no automated test may write to, and Finder is
      // not this gate's business. `apps/main/test/export-clipboard.test.ts` owns both.
      copyToClipboard: () => true,
      reveal: () => true,
    });
    // Both halves of the export's IPC, exactly as `apps/main/src/index.ts` wires them:
    // `registerIpc` for what a *visible* renderer asks for, and
    // `registerExportRenderIpc` for what the hidden export window sends back. Without
    // the second, every encoded chunk the window produces is dropped on the floor and
    // the job waits out `PASS_SILENCE_TIMEOUT_MS`.
    registerIpc({ store, appVersion: '0.0.0-p15-gate', exports: exportSession });
    registerExportRenderIpc({
      exports: exportSession,
      isExportWindow: (window) => windows.roleOf(window) === 'export',
    });

    // ---- the route a person takes -------------------------------------------
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

    const editor = windows.get('editor', recording.id);
    if (editor === undefined) throw new Error('no editor window');
    editor.webContents.on('console-message', (_event, _level, message) => {
      note(`renderer: ${message}`);
    });
    await loaded(editor, 'editor.html');
    await editor.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await until(
      async () =>
        (await editor.webContents.executeJavaScript(
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
      60_000,
    );

    report = {
      ...report,
      lanes: (await editor.webContents.executeJavaScript(
        `[...document.querySelectorAll('.hd')].map((h) => h.textContent.trim())`,
      )) as string[],
      tools: (await editor.webContents.executeJavaScript(
        `[...document.querySelectorAll('#rail .tb')].map((b) => b.dataset.tool)`,
      )) as string[],
    };

    // ---- before anything: what the picture is with no effects ----------------
    await seekTo(editor, INSIDE_SEC);
    await read(editor, 'before any zoom, inside');
    await seekTo(editor, OUTSIDE_SEC);
    await read(editor, 'before any zoom, outside');
    await readDisk(recordingsRoot, recording.id, 'before anything');

    // ---- the generator, from its own button ---------------------------------
    await until(
      async () =>
        (await editor.webContents.executeJavaScript(
          `window.__loomEditor.logsRead === true`,
        )) as boolean,
      'the editor never finished reading the event logs',
    );
    await clickByText(editor, `.gen[data-generator="auto-zoom-on-click"]`, 'Generate');
    await seekTo(editor, INSIDE_SEC);
    await read(editor, 'generated, inside');
    await seekTo(editor, OUTSIDE_SEC);
    await read(editor, 'generated, outside');
    await readDisk(recordingsRoot, recording.id, 'after generating');

    // ---- export A: the generator alone --------------------------------------
    const exportA = await runExport(exportSession, progress, recording.id, 'A-generated');
    note(`export A: ${exportA.phase} ${exportA.result?.path ?? exportA.error ?? ''}`);
    exports_.push({
      label: 'A-generated',
      ok: exportA.phase === 'done',
      error: exportA.error ?? '',
      path: exportA.result?.path ?? '',
      bytes: exportA.result?.bytes ?? 0,
      durationSec: exportA.result?.durationSec ?? 0,
      verified: exportA.result?.verified !== undefined,
      sourcesDeleted: exportA.result?.sourcesDeleted ?? false,
      frames: [],
    });

    // ---- the captain's own row: take manual control -------------------------
    await seekTo(editor, INSIDE_SEC);
    await clickByText(editor, '#zoom-panel', 'Take manual control');
    await wait(250);
    // Tuned with the real slider, to a magnification the generator cannot produce:
    // §6.5's `amountRange` tops out at 2.5, so 4.0 is unmistakably the user's.
    await setRange(editor, 'zoom-amount', 4);
    await settled(editor);
    await read(editor, 'manual, inside');
    await seekTo(editor, OUTSIDE_SEC);
    await read(editor, 'manual, outside');
    await readDisk(recordingsRoot, recording.id, 'after taking manual control');

    // ---- export B: the same recording with the override in it ---------------
    const exportB = await runExport(exportSession, progress, recording.id, 'B-manual');
    note(`export B: ${exportB.phase} ${exportB.result?.path ?? exportB.error ?? ''}`);
    exports_.push({
      label: 'B-manual',
      ok: exportB.phase === 'done',
      error: exportB.error ?? '',
      path: exportB.result?.path ?? '',
      bytes: exportB.result?.bytes ?? 0,
      durationSec: exportB.result?.durationSec ?? 0,
      verified: exportB.result?.verified !== undefined,
      sourcesDeleted: exportB.result?.sourcesDeleted ?? false,
      frames: [],
    });

    // ---- what reached the two files -----------------------------------------
    const pathA = exportA.result?.path;
    const pathB = exportB.result?.path;
    if (pathA !== undefined && pathB !== undefined) {
      for (const [label, at] of [
        ['inside', INSIDE_SEC],
        ['outside', OUTSIDE_SEC],
      ] as const) {
        const a = await decodeExportFrame(editor, pathA, at, EXPORT_FPS);
        const b = await decodeExportFrame(editor, pathB, at, EXPORT_FPS);
        exports_[0]?.frames.push({ label, timelineSec: at, ...a });
        exports_[1]?.frames.push({ label, timelineSec: at, ...b });
        const delta = meanAbsDifference(
          decodedPixels.get(`${pathA}@${String(at)}`) ?? [],
          decodedPixels.get(`${pathB}@${String(at)}`) ?? [],
        );
        deltas.push({ label, meanAbs: delta });
        note(`export delta ${label}: ${delta.toFixed(3)} / 255`);
      }
    }

    // ---- keyframe editing, with a real drag on the lane ---------------------
    // The first `amount` key of the manual region, dragged along the ruler. Its
    // `data-t` is what the lane wrote, so this finds the key rather than a pixel.
    // `[data-lane="zoom"]` rather than an index: the lanes a recording gets depend on
    // what it captured, and `:nth-child` would name whichever row that happened to be.
    // `:not(.kf-gen)` is the user's own key — a generated one is selectable and not
    // draggable, which is §3.5 and not a styling choice.
    const keyBox = await boxOf(editor, '#lane-stack .lane[data-lane="zoom"] .kf:not(.kf-gen)');
    const lanes = await boxOf(editor, '#lanes');
    await drag(
      editor,
      {
        x: Math.round(keyBox.left + keyBox.width / 2),
        y: Math.round(keyBox.top + keyBox.height / 2),
      },
      {
        x: Math.round(keyBox.left + keyBox.width / 2 + lanes.width * 0.02),
        y: Math.round(keyBox.top + keyBox.height / 2),
      },
    );
    await wait(250);
    await readDisk(recordingsRoot, recording.id, 'after dragging a keyframe');
    await key(editor, null, { key: 'z', metaKey: true });
    await wait(400);
    await readDisk(recordingsRoot, recording.id, 'after undoing the keyframe drag');

    // ---- an annotation, with a real drag on the picture ----------------------
    await seekTo(editor, INSIDE_SEC);
    await clickButton(editor, '#rail .tb[data-tool="mask"]');
    const film = await boxOf(editor, '#ovl');
    await drag(
      editor,
      {
        x: Math.round(film.left + film.width * MASK_DRAG.x0),
        y: Math.round(film.top + film.height * MASK_DRAG.y0),
      },
      {
        x: Math.round(film.left + film.width * MASK_DRAG.x1),
        y: Math.round(film.top + film.height * MASK_DRAG.y1),
      },
    );
    await wait(300);
    await settled(editor);
    await read(editor, 'masked, inside');
    await readDisk(recordingsRoot, recording.id, 'after masking');

    // ---- §3.5's bake --------------------------------------------------------
    await clickByText(editor, `.gen[data-generator="auto-zoom-on-click"]`, 'Bake');
    await wait(300);
    await readDisk(recordingsRoot, recording.id, 'after baking');

    // ---- and it is all still there once the window has gone -----------------
    editor.close();
    await until(
      () => Promise.resolve(windows.get('editor', recording.id) === undefined),
      'the editor window never closed',
    );
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
