/**
 * `OverlayController` against a real `ProjectStore`, with `electron` replaced.
 *
 * Three of this phase's constraints are policies rather than pictures, and a gate
 * that renders pixels cannot see any of them. They are what this file is for:
 *
 * 1. **It must never break the recording.** Every failure mode reachable from here
 *    — a write that throws, a stroke that arrives with no recording, a message from
 *    the wrong window — has to end as a status line and not as an exception the
 *    recorder sees. There is a control: a store that fails *every* write must still
 *    leave the recorder able to finalize.
 * 2. **It must not swallow clicks meant for the app underneath.** The window is
 *    created ignoring mouse events with `{ forward: true }` and takes them only
 *    while armed, and the calls are asserted in order rather than at the end —
 *    "it ended up click-through" would pass on a window that swallowed the user's
 *    clicks for the whole recording and let go at the last moment.
 * 3. **It must not steal focus.** `showInactive()`, never `show()`/`focus()`.
 *
 * Plus the one arithmetic claim: a stroke's `t` is the recording clock **minus the
 * age the renderer reported**, because the two processes share no time origin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL } from '@loom/ipc';
import { BUNDLE, type RecordingId } from '@loom/format';
import { parseDrawingLog, strokeEndSec } from '@loom/edl';
import { ProjectStore } from '../src/project-store.ts';
import { OverlayController, type RecordingClock } from '../src/overlay.ts';
import type { WindowRegistry, WindowRole } from '../src/windows.ts';

type Listener = (event: unknown, payload?: unknown) => void;

interface FakeContents {
  id: number;
  sent: { channel: string; payload?: unknown }[];
  send(channel: string, payload?: unknown): void;
}

interface FakeWindow {
  webContents: FakeContents;
  /** Every window call the controller made, in order. This is the policy under test. */
  calls: string[];
  destroyed: boolean;
  isDestroyed(): boolean;
  destroy(): void;
  setBounds(bounds: unknown): void;
  setAlwaysOnTop(on: boolean, level?: string): void;
  setVisibleOnAllWorkspaces(on: boolean, options?: unknown): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  showInactive(): void;
  show(): void;
  focus(): void;
}

const harness = vi.hoisted(() => ({
  listeners: new Map<string, Listener[]>(),
  windows: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents: { id: number }) =>
      [...harness.windows.values()].find((w) => (w as FakeWindow).webContents.id === contents.id) ??
      null,
  },
  ipcMain: {
    on(channel: string, listener: Listener) {
      harness.listeners.set(channel, [...(harness.listeners.get(channel) ?? []), listener]);
    },
    removeAllListeners(channel: string) {
      harness.listeners.delete(channel);
    },
  },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1728, height: 1117 } }),
  },
}));

let nextContentsId = 0;

function makeWindow(): FakeWindow {
  nextContentsId += 1;
  const calls: string[] = [];
  const sent: { channel: string; payload?: unknown }[] = [];
  return {
    webContents: {
      id: nextContentsId,
      sent,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
    calls,
    destroyed: false,
    isDestroyed(): boolean {
      return this.destroyed;
    },
    destroy(): void {
      this.destroyed = true;
      calls.push('destroy');
      harness.windows.delete('drawing-overlay');
    },
    setBounds: () => calls.push('setBounds'),
    setAlwaysOnTop: (_on, level) => calls.push(`alwaysOnTop:${String(level)}`),
    setVisibleOnAllWorkspaces: () => calls.push('allWorkspaces'),
    setIgnoreMouseEvents: (ignore, options) =>
      calls.push(`ignoreMouse:${String(ignore)}:${String(options?.forward ?? false)}`),
    showInactive: () => calls.push('showInactive'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
}

const windows = {
  show(role: WindowRole): FakeWindow {
    const existing = harness.windows.get(role) as FakeWindow | undefined;
    if (existing !== undefined && !existing.destroyed) return existing;
    const window = makeWindow();
    harness.windows.set(role, window);
    return window;
  },
  get: (role: WindowRole): FakeWindow | undefined =>
    harness.windows.get(role) as FakeWindow | undefined,
  all: (): FakeWindow[] => [...harness.windows.values()] as FakeWindow[],
  roleOf: (window: unknown): WindowRole | undefined =>
    ([...harness.windows.entries()].find(([, w]) => w === window)?.[0] ?? undefined) as
      WindowRole | undefined,
} as unknown as WindowRegistry;

/** A driven recording clock, so a stroke's `t` is arithmetic rather than a stopwatch. */
class FakeClock implements RecordingClock {
  nowSec: number | null = 10;
  sourceTimeNowSec(): number | null {
    return this.nowSec;
  }
}

let scratch: string;
let store: ProjectStore;
let clock: FakeClock;
let overlay: OverlayController;

beforeEach(async () => {
  harness.listeners.clear();
  harness.windows.clear();
  scratch = await mkdtemp(join(tmpdir(), 'loom-overlay-'));
  store = new ProjectStore({
    recordingsRoot: join(scratch, 'recordings'),
    settingsPath: join(scratch, 'userData', 'settings.json'),
    appVersion: '0.1.0',
    trash: (path) => rm(path, { recursive: true, force: true }),
    journalSyncMs: 1,
    snapshotDebounceMs: 1,
  });
  clock = new FakeClock();
  overlay = new OverlayController({ store, windows, recorder: clock });
  overlay.install();
});

afterEach(async () => {
  overlay.uninstall();
  await rm(scratch, { recursive: true, force: true });
});

function emit(channel: string, sender: FakeContents, payload?: unknown): void {
  for (const listener of harness.listeners.get(channel) ?? []) listener({ sender }, payload);
}

function overlayWindow(): FakeWindow {
  const window = windows.get('drawing-overlay') as FakeWindow | undefined;
  if (window === undefined) throw new Error('the overlay window was never opened');
  return window;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 2));
}

async function startRecording(): Promise<RecordingId> {
  const { id } = await store.create('drawing');
  await store.openProject(id);
  overlay.begin(id);
  return id;
}

async function readLog(id: RecordingId): Promise<string> {
  const summary = (await store.list()).find((s) => s.id === id);
  if (summary === undefined) throw new Error('no such recording');
  return readFile(join(summary.path, BUNDLE.drawingLog), 'utf8');
}

const STROKE = {
  id: 's1',
  startedMsAgo: 800,
  endedMsAgo: 200,
  tool: 'pen' as const,
  color: '#DC3F12',
  width: 0.004,
  points: [0.1, 0.2, 0.3, 0.4],
};

describe('the window policy', () => {
  it('opens click-through, with moves forwarded, and never takes focus', () => {
    overlay.setOpen(true);
    const window = overlayWindow();
    // In order: the window is click-through *before* it is on screen. A window that
    // appeared first and let go of the mouse afterwards would swallow whatever the
    // user clicked in between, on the display they are recording.
    expect(window.calls).toEqual([
      'setBounds',
      'alwaysOnTop:screen-saver',
      'allWorkspaces',
      'ignoreMouse:true:true',
      'showInactive',
    ]);
    expect(window.calls, 'the overlay activated the app').not.toContain('focus');
    expect(window.calls).not.toContain('show');
  });

  it('takes the mouse only while armed, and gives it back', () => {
    overlay.setOpen(true);
    const window = overlayWindow();
    overlay.setArmed(true);
    overlay.setArmed(false);
    expect(window.calls.filter((c) => c.startsWith('ignoreMouse'))).toEqual([
      'ignoreMouse:true:true',
      'ignoreMouse:false:false',
      'ignoreMouse:true:true',
    ]);
    expect(overlay.status().armed).toBe(false);
  });

  it('CONTROL: arming a closed overlay opens nothing and arms nothing', () => {
    // "The pen is down" and "the pen is on screen" are different statements. A
    // stray `setArmed` from any window must not put a full-screen sheet over the
    // display being recorded.
    overlay.setArmed(true);
    expect(windows.get('drawing-overlay')).toBeUndefined();
    expect(overlay.status().armed).toBe(false);
  });

  it('closes on request, and reports it', () => {
    overlay.setOpen(true);
    overlay.setArmed(true);
    overlay.setOpen(false);
    expect(overlay.status()).toMatchObject({ open: false, armed: false });
  });

  it('does not come back holding the last session’s mouse capture', () => {
    overlay.setOpen(true);
    overlay.setArmed(true);
    overlay.setOpen(false);
    overlay.setOpen(true);
    expect(overlay.status().armed).toBe(false);
    expect(overlayWindow().calls.filter((c) => c.startsWith('ignoreMouse'))).toEqual([
      'ignoreMouse:true:true',
    ]);
  });

  it('is dismissed by the recording ending, disarmed as well as closed', async () => {
    // The third way out, beside the palette's Done button and the HUD's Draw toggle.
    // A full-screen always-on-top window that outlived the recording would go on
    // taking every click on the display with nothing recording, and the user would
    // have to find Done to get their machine back.
    const id = await startRecording();
    overlay.setOpen(true);
    overlay.setArmed(true);
    // The control. Without it this passes just as well against a controller that
    // never opened the overlay at all.
    expect(overlay.status()).toMatchObject({ open: true, armed: true });

    await overlay.finish();

    expect(overlay.status()).toMatchObject({ open: false, armed: false });
    expect(windows.get('drawing-overlay')).toBeUndefined();

    // And it closed through `setOpen(false)` rather than round it, so the next open
    // does not inherit the last recording's mouse capture.
    overlay.setOpen(true);
    expect(overlay.status().armed).toBe(false);
    expect(overlayWindow().calls.filter((c) => c.startsWith('ignoreMouse'))).toEqual([
      'ignoreMouse:true:true',
    ]);
    await store.close(id);
  });
});

describe('who may say what', () => {
  it('accepts a stroke from the overlay and refuses the same one from the HUD', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    const hud = windows.show('recorder-hud') as unknown as FakeWindow;

    emit(CHANNEL.overlayStroke, hud.webContents, { ...STROKE, id: 'from-hud' });
    emit(CHANNEL.overlayStroke, overlayWindow().webContents, STROKE);
    await settle();

    const log = await readLog(id);
    expect(log).toContain('"id":"s1"');
    // The preload is shared by every window, so `overlay.stroke` exists in the HUD
    // too. Narrowing a capability is main's job, not a renderer's.
    expect(log).not.toContain('from-hud');
    await store.close(id);
  });

  it('refuses a stroke from a window it has never heard of', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    emit(CHANNEL.overlayStroke, { id: 9999, sent: [], send: () => undefined }, STROKE);
    await settle();
    expect(await readLog(id)).toBe('');
    await store.close(id);
  });
});

describe('a stroke on the recording clock', () => {
  it('subtracts the age the renderer reported, because the clocks share no origin', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    clock.nowSec = 10;
    emit(CHANNEL.overlayStroke, overlayWindow().webContents, STROKE);
    await settle();

    const line = JSON.parse((await readLog(id)).trim()) as Record<string, unknown>;
    // 10 s now, the pen went down 800 ms ago and came up 200 ms ago.
    expect(line['t']).toBeCloseTo(9.2, 6);
    expect(line['t1']).toBeCloseTo(9.8, 6);
    expect(line['e']).toBe('stroke');
    expect(line['p']).toEqual([0.1, 0.2, 0.3, 0.4]);
    await store.close(id);
  });

  it('clamps a stroke that began before the first frame to zero', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    clock.nowSec = 0.1;
    emit(CHANNEL.overlayStroke, overlayWindow().webContents, STROKE);
    await settle();
    const line = JSON.parse((await readLog(id)).trim()) as Record<string, unknown>;
    expect(line['t']).toBe(0);
    await store.close(id);
  });

  it('drops a stroke when no recording is running, rather than inventing a time', async () => {
    overlay.setOpen(true);
    clock.nowSec = null;
    emit(CHANNEL.overlayStroke, overlayWindow().webContents, STROKE);
    await settle();
    expect(overlay.status().strokeCount).toBe(0);
  });
});

describe('the log’s three states (§2.5)', () => {
  it('is created empty when the pen is out and unused', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    await settle();
    expect(await readLog(id)).toBe('');
    // "Present and empty" is a claim — the user had the pen — so `recording.json`
    // gets a row for it.
    const finished = await overlay.finish();
    expect(finished).toEqual({ file: BUNDLE.drawingLog, strokeCount: 0 });
    await store.close(id);
  });

  it('is created empty when the pen was out before record was pressed', async () => {
    // The other ordering, and the one people actually use: pick the pen up, then
    // press record. §2.5's three states have to survive it too — without this the
    // log is absent, which says "there was never an overlay", and the state the
    // *previous* test names becomes unreachable in the natural order.
    overlay.setOpen(true);
    const id = await startRecording();
    await settle();
    expect(await readLog(id)).toBe('');
    expect(await overlay.finish()).toEqual({ file: BUNDLE.drawingLog, strokeCount: 0 });
    await store.close(id);
  });

  it('is absent, and reported as nothing, when the overlay never opened', async () => {
    const id = await startRecording();
    await settle();
    expect(await overlay.finish()).toBeNull();
    await expect(readLog(id)).rejects.toThrow();
    await store.close(id);
  });

  it('records an erase and a clear as events, not as silence', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    const contents = overlayWindow().webContents;
    clock.nowSec = 5;
    emit(CHANNEL.overlayStroke, contents, STROKE);
    clock.nowSec = 9;
    emit(CHANNEL.overlayErase, contents, { ids: ['s1'], atMsAgo: 0 });
    clock.nowSec = 12;
    emit(CHANNEL.overlayClear, contents, { atMsAgo: 0 });
    await settle();

    const lines = (await readLog(id))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { e: string });
    expect(lines.map((l) => l.e)).toEqual(['stroke', 'erase', 'clear']);
    await store.close(id);
  });

  it('counts only what is on disk when the recording closes', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    const contents = overlayWindow().webContents;
    for (let i = 0; i < 5; i++) {
      emit(CHANNEL.overlayStroke, contents, { ...STROKE, id: `s${String(i)}` });
    }
    // `finish` awaits the write chain rather than reading a counter, so the number
    // in `recording.json` cannot describe a file that is still being written.
    const finished = await overlay.finish();
    expect(finished?.strokeCount).toBe(5);
    expect((await readLog(id)).trim().split('\n')).toHaveLength(5);
    await store.close(id);
  });

  it('counts the writes that landed, not the strokes that were attempted', async () => {
    // `events.drawing.strokeCount` goes into `recording.json`, where it describes
    // this log. A count taken when the message arrived rather than when the line was
    // fsynced claims strokes a full disk refused — a recording that says it holds
    // five and holds one.
    const id = await startRecording();
    overlay.setOpen(true);
    const contents = overlayWindow().webContents;

    emit(CHANNEL.overlayStroke, contents, { ...STROKE, id: 'kept' });
    await settle();
    const failing = vi
      .spyOn(store, 'appendEventLog')
      .mockRejectedValue(new Error('no space left on device'));
    emit(CHANNEL.overlayStroke, contents, { ...STROKE, id: 'lost' });
    await settle();
    failing.mockRestore();

    const onDisk = (await readLog(id)).trim().split('\n').filter(Boolean);
    const finished = await overlay.finish();
    expect(onDisk).toHaveLength(1);
    expect(finished?.strokeCount).toBe(onDisk.length);
    await store.close(id);
  });
});

describe('an age the renderer got wrong', () => {
  /**
   * Every one of these is a `number` as far as `typeof` is concerned, which is what
   * an inline type check lets through. `age()` is the clamp that does not.
   */
  const HOSTILE: { name: string; atMsAgo: unknown }[] = [
    { name: 'NaN', atMsAgo: Number.NaN },
    { name: 'a negative age, which would stamp it in the future', atMsAgo: -5000 },
    { name: 'an age longer than any recording', atMsAgo: 1e18 },
  ];

  for (const { name, atMsAgo } of HOSTILE) {
    it(`writes a clear the importer still accepts when atMsAgo is ${name}`, async () => {
      // The failure this pins is not a wrong number, it is a *dropped line*: a `NaN`
      // `t` reaches the log as `{"e":"clear","t":null}`, which the importer refuses,
      // and every stroke the presenter cleared then runs to the end of the recording
      // and is composited over the rest of the video. So the assertion is the
      // consequence — where the stroke ends — and not just the timestamp.
      const id = await startRecording();
      overlay.setOpen(true);
      const contents = overlayWindow().webContents;
      clock.nowSec = 5;
      emit(CHANNEL.overlayStroke, contents, STROKE);
      clock.nowSec = 4000;
      emit(CHANNEL.overlayClear, contents, { atMsAgo });
      await settle();

      const events = parseDrawingLog(await readLog(id));
      const clear = events.find((e) => e.e === 'clear');
      if (clear === undefined)
        throw new Error('the clear never reached the log the importer reads');
      expect(Number.isFinite(clear.t)).toBe(true);
      expect(clear.t).toBeGreaterThanOrEqual(0);
      // Never ahead of the clock the message landed on, which a negative age would
      // put it — `Math.max(0, …)` hides an age that is too large and does nothing
      // about one that is negative.
      expect(clear.t).toBeLessThanOrEqual(4000);

      const drawn = events.find((e) => e.e === 'stroke');
      if (drawn?.e !== 'stroke') throw new Error('the stroke never reached the log');
      expect(strokeEndSec(drawn, events, 5000)).toBe(clear.t);
      await store.close(id);
    });
  }
});

describe('untrusted input', () => {
  it('drops a malformed stroke rather than repairing it', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    const contents = overlayWindow().webContents;
    const bad: unknown[] = [
      null,
      { ...STROKE, points: [0.1] },
      { ...STROKE, points: [0.1, Number.NaN] },
      { ...STROKE, points: [0.1, 0.2, 0.3] },
      { ...STROKE, width: 0 },
      { ...STROKE, width: 12 },
      { ...STROKE, id: '' },
      { ...STROKE, id: 'x'.repeat(200) },
    ];
    for (const message of bad) emit(CHANNEL.overlayStroke, contents, message);
    await settle();
    expect(overlay.status().strokeCount).toBe(0);
    expect(await readLog(id)).toBe('');
    await store.close(id);
  });

  it('refuses a colour it cannot store, and falls back rather than dropping the ink', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    emit(CHANNEL.overlayStroke, overlayWindow().webContents, {
      ...STROKE,
      color: 'javascript:alert(1)',
    });
    await settle();
    const line = JSON.parse((await readLog(id)).trim()) as Record<string, unknown>;
    expect(line['color']).toBe('#DC3F12');
    await store.close(id);
  });
});

describe('it never breaks the recording', () => {
  it('turns a failed write into a status line and keeps accepting strokes', async () => {
    const id = await startRecording();
    overlay.setOpen(true);
    const contents = overlayWindow().webContents;

    const failing = vi
      .spyOn(store, 'appendEventLog')
      .mockRejectedValue(new Error('no space left on device'));
    emit(CHANNEL.overlayStroke, contents, STROKE);
    await settle();
    expect(overlay.status().error).toMatch(/no space left on device/);

    // And the *next* stroke is still attempted, because one failed write must not
    // take the pen away for the rest of the recording.
    failing.mockRestore();
    emit(CHANNEL.overlayStroke, contents, { ...STROKE, id: 's2' });
    await settle();
    expect(await readLog(id)).toContain('"id":"s2"');
    await store.close(id);
  });

  it('CONTROL: finish() still resolves when every write failed', async () => {
    // The recorder awaits this in `finalize`. A rejection here would take down a
    // recording over a pen, which is the exact inversion this phase must not have.
    const id = await startRecording();
    overlay.setOpen(true);
    vi.spyOn(store, 'createEventLog').mockRejectedValue(new Error('disk on fire'));
    vi.spyOn(store, 'appendEventLog').mockRejectedValue(new Error('disk on fire'));
    emit(CHANNEL.overlayStroke, overlayWindow().webContents, STROKE);
    await expect(overlay.finish()).resolves.toBeNull();
    vi.restoreAllMocks();
    await store.close(id);
  });

  it('CONTROL: the same write really does succeed when the store is not broken', async () => {
    // Without this the test above would pass against a controller that silently
    // wrote nothing at all.
    const id = await startRecording();
    overlay.setOpen(true);
    emit(CHANNEL.overlayStroke, overlayWindow().webContents, STROKE);
    await settle();
    expect(overlay.status().error).toBeNull();
    expect(await readLog(id)).toContain('"id":"s1"');
    await store.close(id);
  });
});
