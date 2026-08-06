/**
 * **The event logs, through the product's own recording path.**
 *
 * The first-run window asks for the Accessibility grant on one sentence —
 * *"Logs where your pointer is and when you click… That log is what makes
 * auto-zoom-on-click and cursor-follow possible later"* — and for ten phases nothing
 * in the app ever wrote that log. `startInputSampler` had exactly one caller and it
 * was `scripts/record-cursor-corpus.mjs`, a script. So `packages/edl`'s phase-10 gate
 * passed over ten real bundles that the product could not have produced.
 *
 * That is the shape of failure this file exists to close, and it dictates its
 * design: **everything below is driven through `RecorderSession`.** No bundle is
 * assembled by hand, no `InputSampler` is constructed here, and the sink, the clock
 * origin, the display and the click request are all whatever the recorder decided.
 * The only thing substituted is the *identity* the helper runs under, and only in the
 * denied case, where a grant cannot be taken away any other way — `untrusted.ts`
 * explains how, and it is the same mechanism the phase-5 gate uses.
 *
 * ## What is asserted, and what the machine decides
 *
 * The cursor half is unconditional: position needs no permission, so a recording that
 * does not write `events/cursor.ndjson` fails here on any machine.
 *
 * The click half is a **two-sided** assertion whose side is chosen by what macOS says
 * about *this* runner, never by what is convenient:
 *
 * - a runner whose tap can be live must produce `events/clicks.ndjson` and
 *   `clicks.available: true`;
 * - a runner that is not trusted must produce **no** `clicks.ndjson` at all, and say
 *   `accessibility-denied` rather than `not-requested` — the distinction §7.3 and
 *   `@loom/sampler` are both built around.
 *
 * The denied side is exercised on every machine, because `untrustedHelper` can always
 * produce an untrusted process. The granted side is exercised only where a grant
 * exists, and the test **annotates** loudly when it was not, so a green run cannot be
 * mistaken for evidence it was.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL } from '@loom/ipc';
import { BUNDLE, type RecordingDoc, type RecordingId } from '@loom/format';
import { probeInput } from '@loom/sampler';
import { buildNativeSampler } from '../../../packages/sampler/native/build.mjs';
import { untrustedHelper } from '../../../packages/sampler/test/untrusted.ts';
import { ProjectStore } from '../src/project-store.ts';
import { RecorderSession } from '../src/recorder/session.ts';
import type { WindowRegistry, WindowRole } from '../src/windows.ts';
import {
  loadEncodedFixture,
  type FixtureFrame,
} from '../../../packages/mux/test/helpers/fixture.ts';

interface FakeContents {
  id: number;
  sent: { channel: string; payload?: unknown }[];
  isLoadingMainFrame(): boolean;
  send(channel: string, payload?: unknown): void;
}

interface FakeWindow {
  webContents: FakeContents;
  isDestroyed(): boolean;
}

type Listener = (event: unknown, payload?: unknown) => void;

const harness = vi.hoisted(() => ({
  listeners: new Map<string, Listener[]>(),
  windows: new Map<WindowRole, FakeWindow>(),
}));

vi.mock('electron', () => {
  const display = {
    id: 1,
    label: 'Built-in Liquid Retina XDR',
    size: { width: 1728, height: 1117 },
    scaleFactor: 2,
    colorSpace: 'display-p3',
  };
  return {
    BrowserWindow: {
      fromWebContents: (contents: { id: number }) =>
        [...harness.windows.values()].find((w) => w.webContents.id === contents.id) ?? null,
    },
    desktopCapturer: { getSources: () => Promise.resolve([]) },
    ipcMain: {
      on(channel: string, listener: Listener) {
        harness.listeners.set(channel, [...(harness.listeners.get(channel) ?? []), listener]);
      },
      handle: () => undefined,
      removeHandler: () => undefined,
      removeAllListeners(channel: string) {
        harness.listeners.delete(channel);
      },
    },
    screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
    session: { defaultSession: { setDisplayMediaRequestHandler: () => undefined } },
    app: { isPackaged: false },
    shell: { openExternal: () => Promise.resolve() },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      isTrustedAccessibilityClient: () => false,
    },
  };
});

const fixture = loadEncodedFixture();

/**
 * How long the recording runs past its first frame before it is stopped.
 *
 * Sampling starts at the first frame, and the helper has to be spawned and reach its
 * first status line before it can sample at all — so this is spawn time plus enough
 * of §2.5's 100 ms flush cadence to leave a decisive number of samples on disk.
 */
const SAMPLE_WINDOW_MS = 900;

let nextContentsId = 0;
let scratch: string;
let store: ProjectStore;
let recorder: RecorderSession;
/** Everything main said while a recording was running, for the ordering control. */
let logged: string[] = [];

const windows = {
  show(role: WindowRole): FakeWindow {
    const existing = harness.windows.get(role);
    if (existing !== undefined) return existing;
    nextContentsId += 1;
    const sent: { channel: string; payload?: unknown }[] = [];
    const window: FakeWindow = {
      webContents: {
        id: nextContentsId,
        sent,
        isLoadingMainFrame: () => false,
        send: (channel: string, payload?: unknown) => sent.push({ channel, payload }),
      },
      isDestroyed: () => false,
    };
    harness.windows.set(role, window);
    return window;
  },
  get: (role: WindowRole): FakeWindow | undefined => harness.windows.get(role),
  all: (): FakeWindow[] => [...harness.windows.values()],
  roleOf: (window: unknown): WindowRole | undefined =>
    [...harness.windows.entries()].find(([, w]) => w === window)?.[0],
} as unknown as WindowRegistry;

function captureContents(): FakeContents {
  const capture = harness.windows.get('capture');
  if (capture === undefined) throw new Error('the capture window was never asked for');
  return capture.webContents;
}

function emit(channel: string, sender: FakeContents, payload?: unknown): void {
  for (const listener of harness.listeners.get(channel) ?? []) listener({ sender }, payload);
}

function metaMessage(): unknown {
  return {
    track: 'screen',
    part: 0,
    decoderConfig: {
      codec: 'avc1.64000d',
      codedWidth: fixture.width,
      codedHeight: fixture.height,
      description: fixture.avcC,
    },
  };
}

function chunkMessage(frame: FixtureFrame): unknown {
  return {
    track: 'screen',
    part: 0,
    kind: frame.isKey ? 'key' : 'delta',
    timestampUs: frame.timestampUs,
    durationUs: null,
    data: frame.data,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Position samples: every §2.5 line that is not an `e` meta event. */
function positions(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => line['e'] === undefined);
}

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Recorded {
  id: RecordingId;
  dir: string;
  doc: RecordingDoc;
  cursor: Record<string, unknown>[] | null;
  clicks: Record<string, unknown>[] | null;
}

/**
 * One whole recording, exactly as the app makes one.
 *
 * `RecorderSession.start`, the capture page's `meta` and chunks on the real IPC
 * channels, `RecorderSession.stop`. Nothing here touches `events/`, the sampler or
 * `recording.json` — every one of those is the recorder's own doing, which is the
 * point of the test.
 */
async function record(): Promise<Recorded> {
  const id = await recorder.start({ fps: fixture.fps });
  const contents = captureContents();
  const frames = fixture.frames.slice(0, 20);

  emit(CHANNEL.captureMeta, contents, metaMessage());
  emit(CHANNEL.captureChunk, contents, chunkMessage(frames[0]!));
  const dir = await store.directoryFor(id);

  // The cursor log is what says the sampler is really running, so the recording is
  // held open until it exists rather than for a fixed sleep.
  await until(() => exists(join(dir, BUNDLE.cursorLog)), 'the cursor log to be created');
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_WINDOW_MS));
  for (const frame of frames.slice(1)) emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
  await until(
    () => Promise.resolve(store.mediaFrameCount(id, 'screen') >= frames.length - 1),
    'every chunk to be written',
  );

  const last = frames[frames.length - 1]!;
  const stopping = recorder.stop();
  emit(CHANNEL.captureEnded, contents, {
    reason: 'stopped',
    endedAtUs: last.timestampUs + Math.round(1_000_000 / fixture.fps),
    framesEncoded: frames.length,
    framesDropped: 0,
  });
  await stopping;

  const cursorPath = join(dir, BUNDLE.cursorLog);
  const clickPath = join(dir, BUNDLE.clickLog);
  return {
    id,
    dir,
    doc: JSON.parse(await readFile(join(dir, 'recording.json'), 'utf8')) as RecordingDoc,
    cursor: (await exists(cursorPath)) ? readLines(await readFile(cursorPath, 'utf8')) : null,
    clicks: (await exists(clickPath)) ? readLines(await readFile(clickPath, 'utf8')) : null,
  };
}

/**
 * A `t` no larger than this is on the recording clock; a larger one is not.
 *
 * The failure this guards is specific and has been measured on this machine: a log
 * whose origin was never subtracted carries the helper's `CLOCK_UPTIME_RAW` directly,
 * and 2,678,930 s was the reading. `@loom/edl`'s `MAX_SOURCE_TIME_SEC` drops such
 * samples in the §6.1 sanity pass, so the symptom of getting the origin wrong is not
 * a wrong log — it is generators that quietly produce nothing.
 */
const MAX_PLAUSIBLE_T_SEC = 600;

function assertOnTheRecordingClock(samples: Record<string, unknown>[]): void {
  expect(samples.length).toBeGreaterThan(0);
  let previous = -Infinity;
  for (const sample of samples) {
    const t = sample['t'];
    expect(typeof t).toBe('number');
    const seconds = t as number;
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeLessThan(MAX_PLAUSIBLE_T_SEC);
    // Sampling begins at the recording clock's origin, so no sample can predate it.
    // A small negative would mean the origin was extrapolated rather than measured.
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeGreaterThan(previous);
    previous = seconds;
    expect(typeof sample['x']).toBe('number');
    expect(typeof sample['y']).toBe('number');
  }
  // The origin is the first frame and the helper is spawned from it, so the first
  // sample lands a spawn later — not a `getDisplayMedia` later, which is what
  // starting the sampler in `start()` would have produced.
  expect(samples[0]!['t'] as number).toBeLessThan(2);
}

let builtHelper: string;
let helperScratch: string;
/** A helper macOS does not trust, for the denied side. */
let deniedHelper: string;
/** Whether *this* machine can bring a click tap up at all. */
let tapCanBeLive = false;

describe.skipIf(process.platform !== 'darwin')('a recording writes its event logs', () => {
  beforeAll(async () => {
    builtHelper = await buildNativeSampler();
    helperScratch = await mkdtemp(join(tmpdir(), 'loom-recorder-events-helper-'));
    deniedHelper = (await untrustedHelper(builtHelper, helperScratch)).path;
    tapCanBeLive = (await probeInput({ helperPath: builtHelper })).clicks.available;
  }, 120_000);

  afterAll(async () => {
    await rm(helperScratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    harness.listeners.clear();
    harness.windows.clear();
    logged = [];
    for (const stream of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((value) => String(value)).join(' '));
      });
    }
    scratch = await mkdtemp(join(tmpdir(), 'loom-recorder-events-'));
    store = new ProjectStore({
      recordingsRoot: join(scratch, 'recordings'),
      settingsPath: join(scratch, 'settings.json'),
      appVersion: '0.1.0-test',
      trash: () => Promise.resolve(),
    });
    await store.loadSettings();
  });

  afterEach(async () => {
    recorder.uninstall();
    vi.restoreAllMocks();
    await store.closeAll().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  });

  function build(helperPath: string): void {
    recorder = new RecorderSession({
      store,
      windows,
      appVersion: '0.1.0-test',
      osVersion: '14.0.0',
      stopTimeoutMs: 2_000,
      statusIntervalMs: 10_000,
      inputHelperPath: helperPath,
    });
    recorder.install();
  }

  it('writes cursor.ndjson and names it in recording.json', async () => {
    build(builtHelper);
    const recorded = await record();

    expect(recorded.cursor).not.toBeNull();
    const samples = positions(recorded.cursor!);
    assertOnTheRecordingClock(samples);

    // What the bundle says about itself has to match what is in it. The count is the
    // recorder's, written from the sampler that ran — not recomputed here from the
    // file, which would make the document agree with itself by construction.
    expect(recorded.doc.events.cursor).toEqual({
      file: BUNDLE.cursorLog,
      hz: 120,
      sampleCount: samples.length,
    });
    expect(recorded.doc.events.cursorImages).toBe(BUNDLE.cursorIndex);
    // `capture.permissions.accessibility` said `true` while `events` said nothing at
    // all for ten phases. The two must now describe the same recording.
    expect(recorded.doc.events.clicks?.source).toBe('cgeventtap');
  }, 60_000);

  it('stops the sampler before the bundle is closed', async () => {
    build(builtHelper);
    await record();

    // `ProjectStore`'s event-log writes refuse a closed project rather than
    // reopening it, so reversing the order in `finalize` turns the tail of the log
    // into a typed refusal reported through the sampler's `onError`. Nothing else in
    // a healthy recording produces that word.
    const refusals = logged.filter((line) => /unknown recording/i.test(line));
    expect(refusals).toEqual([]);
    // And the sampler itself reported nothing at all.
    expect(logged.filter((line) => line.startsWith('[input-sampler]'))).toEqual([]);
  }, 60_000);

  it('writes the cursor log with no Accessibility grant, and no clicks log', async () => {
    build(deniedHelper);
    const recorded = await record();

    // Cursor position needs no permission. A user who declines Accessibility gets
    // this, in full, or the grant was asked for under false pretences.
    expect(recorded.cursor).not.toBeNull();
    assertOnTheRecordingClock(positions(recorded.cursor!));

    // No empty file. An empty `clicks.ndjson` would say "we watched and nobody
    // clicked", which is the one thing that must not be readable out of a recording
    // whose tap was never alive (§7.3, and phase 10's auto-zoom is the consumer).
    expect(recorded.clicks).toBeNull();
    expect(recorded.doc.events.clicks).toEqual({
      file: BUNDLE.clickLog,
      available: false,
      source: 'cgeventtap',
    });

    // And it is `accessibility-denied`, not `not-requested`: the recorder asks for
    // clicks on every recording, so an absent log is macOS's answer and never ours.
    const notice = recorded.cursor!.find((line) => line['e'] === 'clicks');
    expect(notice?.['reason']).toBe('accessibility-denied');
    expect(notice?.['axTrusted']).toBe(false);
  }, 60_000);

  it('writes clicks.ndjson when the tap is live', async ({ annotate, skip }) => {
    if (!tapCanBeLive) {
      await annotate(
        'This runner holds no Accessibility grant, so the granted half of the click ' +
          'contract was not exercised. The denied half above was. Grant Accessibility ' +
          'to the process running these tests to cover it.',
      );
      skip();
      return;
    }
    build(builtHelper);
    const recorded = await record();

    // The tap came up, so the log exists and is a claim: from here on an empty
    // `clicks.ndjson` means nobody clicked, and that is a fact about the recording.
    expect(recorded.clicks).not.toBeNull();
    expect(recorded.doc.events.clicks).toEqual({
      file: BUNDLE.clickLog,
      available: true,
      source: 'cgeventtap',
    });
    for (const click of recorded.clicks!) {
      expect(typeof click['t']).toBe('number');
      expect(click['t'] as number).toBeLessThan(MAX_PLAUSIBLE_T_SEC);
    }
  }, 60_000);
});
