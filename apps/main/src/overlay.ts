/**
 * The live drawing overlay, from main's side. Phase 12.
 *
 * A transparent, full-screen, always-on-top window with
 * `setContentProtection(true)`, plus the append-only log its strokes land in. §8's
 * gate for this phase is three sentences: *"strokes appear live, are **absent** from
 * the raw capture, and are deletable in the editor"*. The middle one is what
 * `contentProtected: true` on the `drawing-overlay` role in `windows.ts` buys, and
 * `overlay-content-protection` in `apps/main/src/verify/permissions-harness.ts` is
 * what proves it in captured pixels rather than in an assertion that the flag was
 * set — from the signed bundle, because capturing the screen needs the grant.
 * `test/phase12-overlay.test.ts` keeps the other two.
 *
 * ## The rule this file exists to keep
 *
 * **A drawing overlay must never break the recording.** It is an accessory: the
 * user pressed record to record their screen, and a pen that fails costs them a
 * pen. So every path out of here that could throw is caught, turned into
 * {@link OverlayStatus.error}, and the recording carries on. That is deliberately
 * the *opposite* of the blur and mask passes, which refuse a frame rather than
 * publish an unredacted one: failing closed protects the user there and would rob
 * them here.
 *
 * §7.3's shape is the same argument one level up — *"an audio failure never fails a
 * recording"* — and ink is further from the point of a recording than audio is.
 *
 * ## Click-through, and the one thing that makes it usable
 *
 * A full-screen always-on-top window that swallowed clicks would make the app being
 * recorded unusable for the length of the recording, and the recording is *of* that
 * app. So the window is created ignoring mouse events entirely, with
 * `{ forward: true }` so that *moves* still reach the page — that forwarding is what
 * lets the overlay notice the pointer arriving over its own palette and ask to be
 * armed. Two states, named on {@link OverlayStatus}:
 *
 * | state            | `setIgnoreMouseEvents` | what the user sees                        |
 * | ---------------- | ---------------------- | ----------------------------------------- |
 * | open, not armed  | `true, { forward }`    | ink already drawn; clicks reach the app    |
 * | open, armed      | `false`                | the pen draws; clicks are the overlay's    |
 *
 * And it never takes focus: `focusable: false` on the role, `showInactive()` here,
 * and no `focus()` call anywhere. On macOS that means clicking the palette does not
 * activate this app, so the window the user is demonstrating stays key — which also
 * means the overlay cannot receive **keyboard** events, and is why nothing here is
 * dismissed with a key. It is dismissed by its own close control, by the HUD's Draw
 * toggle, and by the recording ending.
 *
 * ## Where a stroke's `t` comes from
 *
 * Not from the renderer's clock. A renderer's `performance.now()` starts when its
 * document did and means nothing here, so {@link StrokeMsg} carries *ages* —
 * `startedMsAgo`, `endedMsAgo` — and this file subtracts them from
 * `RecorderSession.sourceTimeNowSec()`, which is the recording clock read at the
 * instant the message lands. A difference survives a process boundary; an origin
 * does not.
 */

import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import {
  BUNDLE,
  type DrawingClearEvent,
  type DrawingEraseEvent,
  type DrawingStrokeEvent,
  type DrawingTool,
  type RecordingId,
} from '@loom/format';
import { CHANNEL, type EraseMsg, type OverlayStatus, type StrokeMsg } from '@loom/ipc';
import type { DrawingSink } from './recorder/session.ts';
import type { ProjectStore } from './project-store.ts';
import type { WindowRegistry, WindowRole } from './windows.ts';

/**
 * What the overlay needs from the recorder, and all of it.
 *
 * An interface rather than the class, so `apps/main/test/overlay.test.ts` can drive
 * the clock instead of running a capture — and so that this file cannot reach for
 * anything else on a `RecorderSession` later without widening a declaration
 * somebody has to read.
 */
export interface RecordingClock {
  /** Source seconds into the recording right now, or `null` when none is running. */
  sourceTimeNowSec(): number | null;
}

export interface OverlayControllerOptions {
  windows: WindowRegistry;
  store: ProjectStore;
  recorder: RecordingClock;
}

/** The roles allowed to open, close and arm the overlay. */
const CONTROLLING_ROLES: readonly WindowRole[] = ['recorder-hud', 'drawing-overlay'];

/**
 * The most points one stroke may carry across IPC.
 *
 * A renderer is untrusted input (§1.4), and a stroke is the one message on this
 * surface whose size the user's hand decides. The pen simplifies before it sends —
 * a minute of scribbling is a few hundred points — so this is a bound on a
 * malformed or hostile sender, and it matches `@loom/edl`'s `MAX_STROKE_POINTS` so
 * that a stroke this accepts is a stroke the importer can read back.
 */
const MAX_STROKE_POINTS = 4096;

/** Longest colour string accepted. `#rrggbbaa` is nine characters. */
const MAX_COLOR_LENGTH = 16;

export class OverlayController implements DrawingSink {
  readonly #options: OverlayControllerOptions;

  /** The recording ink is being logged into, or `null`. */
  #recordingId: RecordingId | null = null;
  /** True once `events/drawing.ndjson` exists on disk for {@link #recordingId}. */
  #logCreated = false;
  #strokeCount = 0;
  #armed = false;
  #error: string | null = null;
  /**
   * Serializes the log's writes.
   *
   * `ProjectStore` already serializes per project, so this is not about the file —
   * it is about {@link finish} not returning a stroke count while an append is
   * still queued behind it, which would write a `recording.json` that undercounts
   * its own log.
   */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: OverlayControllerOptions) {
    this.#options = options;
  }

  // ------------------------------------------------------------------- wiring

  install(): void {
    ipcMain.on(CHANNEL.overlaySetOpen, (event, raw: unknown) => {
      if (!this.#fromControllingWindow(event)) return;
      this.setOpen(raw === true);
    });
    ipcMain.on(CHANNEL.overlaySetArmed, (event, raw: unknown) => {
      if (!this.#fromControllingWindow(event)) return;
      this.setArmed(raw === true);
    });
    // The three that write. Accepted from the overlay window alone: the preload is
    // shared by every window in the app, so `overlay.stroke` exists in the library
    // and in the capture page too, and neither may put ink in a recording.
    ipcMain.on(CHANNEL.overlayStroke, (event, raw: unknown) => {
      if (!this.#fromOverlay(event)) return;
      this.#onStroke(raw);
    });
    ipcMain.on(CHANNEL.overlayErase, (event, raw: unknown) => {
      if (!this.#fromOverlay(event)) return;
      this.#onErase(raw);
    });
    ipcMain.on(CHANNEL.overlayClear, (event, raw: unknown) => {
      if (!this.#fromOverlay(event)) return;
      this.#onClear(raw);
    });
  }

  uninstall(): void {
    for (const channel of [
      CHANNEL.overlaySetOpen,
      CHANNEL.overlaySetArmed,
      CHANNEL.overlayStroke,
      CHANNEL.overlayErase,
      CHANNEL.overlayClear,
    ]) {
      ipcMain.removeAllListeners(channel);
    }
  }

  // --------------------------------------------------------------- the window

  /**
   * Open or close the overlay.
   *
   * Opening sizes the window to the display's **full bounds** rather than its work
   * area — ink over the menu bar and the Dock is ink the user meant — and shows it
   * with `showInactive()`, so the app being demonstrated keeps focus.
   *
   * Closing does not stop a recording, does not close the log, and does not discard
   * anything already written: the strokes are on disk and belong to the recording,
   * not to the window.
   */
  setOpen(open: boolean): void {
    try {
      if (!open) {
        const existing = this.#options.windows.get('drawing-overlay');
        // Disarmed *before* it goes, so a window that is destroyed and later
        // reopened cannot come back holding the last session's mouse capture.
        this.#armed = false;
        existing?.destroy();
        this.#publish();
        return;
      }

      const window = this.#options.windows.show('drawing-overlay');
      const display = screen.getPrimaryDisplay();
      window.setBounds(display.bounds);
      // Above ordinary always-on-top windows, and present on every space including
      // over a fullscreen app — a presenter demonstrating a fullscreen editor is
      // the ordinary case, not the exotic one.
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.#applyMousePolicy(window);
      window.showInactive();
      // The pen being *out* during a recording is itself a fact worth writing down:
      // it makes "present and empty" mean "the user had the pen and drew nothing",
      // which §2.5 keeps distinct from "there was never an overlay". Same three
      // states `clicks.ndjson` has, for the same reason.
      this.#noteOverlayOpenedDuringRecording();
      this.#publish();
    } catch (error) {
      this.#fail('the drawing overlay could not be opened', error);
    }
  }

  /**
   * Take mouse events, or let them fall through to whatever is underneath.
   *
   * Called by the overlay page as the pointer crosses into and out of its palette,
   * and by the HUD when the user picks the pen up or puts it down. Arming a
   * closed overlay is a no-op rather than an implicit open: "the pen is down" and
   * "the pen is on screen" are different statements and collapsing them would make
   * a stray message from any window cover the display.
   */
  setArmed(armed: boolean): void {
    const window = this.#options.windows.get('drawing-overlay');
    if (window === undefined) {
      this.#armed = false;
      this.#publish();
      return;
    }
    this.#armed = armed;
    this.#applyMousePolicy(window);
    this.#publish();
  }

  /**
   * The one place `setIgnoreMouseEvents` is called.
   *
   * `{ forward: true }` on the ignoring branch is the whole mechanism: without it
   * the page never sees the pointer and can never notice it arriving over the
   * palette, so the overlay could only be armed from another window and would be
   * useless on its own.
   */
  #applyMousePolicy(window: BrowserWindow): void {
    if (this.#armed) window.setIgnoreMouseEvents(false);
    else window.setIgnoreMouseEvents(true, { forward: true });
  }

  // ---------------------------------------------------- the recording's ledger

  /** {@link DrawingSink}. A recording began; ink from here belongs to it. */
  begin(id: RecordingId): void {
    this.#recordingId = id;
    this.#logCreated = false;
    this.#strokeCount = 0;
    this.#error = null;
    // The pen out *before* record was pressed is the ordinary order — a presenter
    // sets their tools up and then starts — and §2.5's three states have to survive
    // it. Without this the log is absent, which says "there was never an overlay",
    // and "the user had the pen and drew nothing" becomes unrepresentable in the one
    // ordering people actually use. Same note `setOpen` makes, from the other side.
    if (this.#options.windows.get('drawing-overlay') !== undefined) {
      this.#noteOverlayOpenedDuringRecording();
    }
    this.#publish();
  }

  /**
   * {@link DrawingSink}. The recording is closing.
   *
   * Returns `null` when no log was ever created, which is the honest description of
   * a recording nobody drew on — §2.5's three states again: an absent file and an
   * empty one mean different things, and `recording.json` is what distinguishes
   * them. The overlay creates the file the first time it is opened *during* a
   * recording, so "present and empty" means the pen was out and unused.
   */
  async finish(): Promise<{ file: string; strokeCount: number } | null> {
    // Closed to new ink **before** the await, and not after it. Everything already
    // queued still lands — that is what the await is for — but a stroke that arrives
    // during it would otherwise be counted into a log this call has already
    // described, and queued onto a chain nobody is waiting on.
    this.#recordingId = null;
    await this.#chain.catch(() => undefined);
    const created = this.#logCreated;
    const strokeCount = this.#strokeCount;
    this.#logCreated = false;
    this.#strokeCount = 0;
    // The recording ending is the third way out of the overlay, beside the palette's
    // Done button and the HUD's Draw toggle. A full-screen always-on-top window that
    // outlived what it was for would go on taking the display's clicks with nothing
    // recording. It goes through `setOpen(false)` rather than around it so there is
    // one close path — which is also what leaves the overlay **disarmed**, so a later
    // open cannot come back holding this session's mouse capture — and `setOpen`
    // catches its own failures, so a window that will not close costs the window and
    // never the recording finalizing around it.
    this.setOpen(false);
    return created ? { file: BUNDLE.drawingLog, strokeCount } : null;
  }

  // -------------------------------------------------------------- the messages

  #onStroke(raw: unknown): void {
    const message = strokeMessage(raw);
    if (message === null) return;
    const at = this.#clockFor(message.startedMsAgo);
    if (at === null) return;
    const ended = this.#clockFor(message.endedMsAgo);
    const event: DrawingStrokeEvent = {
      e: 'stroke',
      t: round(at),
      t1: round(Math.max(at, ended ?? at)),
      id: message.id,
      tool: message.tool,
      color: message.color,
      w: message.width,
      p: message.points.map(round),
    };
    // Counted when the line is on disk, never when the message arrived: this number
    // goes into `recording.json` as `events.drawing.strokeCount`, and a count that
    // included the strokes a full disk refused would describe a log that does not
    // hold them.
    this.#append(event, () => {
      this.#strokeCount += 1;
    });
  }

  #onErase(raw: unknown): void {
    const message = eraseMessage(raw);
    if (message === null || message.ids.length === 0) return;
    const at = this.#clockFor(message.atMsAgo);
    if (at === null) return;
    const event: DrawingEraseEvent = { e: 'erase', t: round(at), ids: message.ids };
    this.#append(event);
  }

  #onClear(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    // Through {@link age}, exactly as a stroke and an erase are. `typeof NaN` is
    // `'number'`, so an inline check of the type alone lets a `NaN` through, and a
    // `NaN` `t` is written by `JSON.stringify` as `null` — a line the importer
    // refuses, which leaves every stroke the user cleared composited over the rest
    // of the video.
    const at = this.#clockFor(age((raw as Record<string, unknown>)['atMsAgo']));
    if (at === null) return;
    const event: DrawingClearEvent = { e: 'clear', t: round(at) };
    this.#append(event);
  }

  /**
   * Where an event that happened `msAgo` milliseconds ago sits on the recording
   * clock, or `null` when there is nothing to sit on.
   *
   * Clamped at zero: a stroke that began a hair before the first frame did is a
   * stroke at t=0, not a stroke at a negative time the importer would have to have
   * an opinion about.
   */
  #clockFor(msAgo: number): number | null {
    if (this.#recordingId === null) return null;
    const now = this.#options.recorder.sourceTimeNowSec();
    if (now === null) return null;
    return Math.max(0, now - msAgo / 1000);
  }

  /**
   * Queue one line onto `events/drawing.ndjson`.
   *
   * Creates the file on the first write of a recording as well as when the overlay
   * opens, because the two orders both happen — the pen can be out before the user
   * presses record — and `create` is idempotent.
   *
   * `sync` after every event rather than on §2.5's one-second timer: that cadence is
   * sized for a 120 Hz cursor log, and this file gets a line every second or two at
   * the very most. One `fsync` per stroke costs nothing and removes the window in
   * which a crash loses ink that is already on the wire.
   *
   * `onWritten` runs inside the chain, after the `fsync`, so anything a caller counts
   * is something the log holds rather than something it was asked for.
   */
  #append(
    event: DrawingStrokeEvent | DrawingEraseEvent | DrawingClearEvent,
    onWritten?: () => void,
  ): void {
    const id = this.#recordingId;
    if (id === null) return;
    const line = `${JSON.stringify(event)}\n`;
    this.#chain = this.#chain.then(
      async () => {
        const store = this.#options.store;
        if (!this.#logCreated) {
          await store.createEventLog(id, 'drawing');
          this.#logCreated = true;
        }
        await store.appendEventLog(id, 'drawing', line);
        await store.syncEventLog(id, 'drawing');
        onWritten?.();
      },
      () => undefined,
    );
    // The catch is on the chain rather than around the await, so one failed write
    // does not stop the next stroke from being tried — and never reaches the
    // recorder.
    this.#chain = this.#chain.catch((error: unknown) => {
      this.#fail('a stroke could not be written', error);
    });
  }

  /** Open the log now, so "the pen was out and unused" is representable. */
  #noteOverlayOpenedDuringRecording(): void {
    const id = this.#recordingId;
    if (id === null || this.#logCreated) return;
    this.#chain = this.#chain
      .then(async () => {
        await this.#options.store.createEventLog(id, 'drawing');
        this.#logCreated = true;
      })
      .catch((error: unknown) => {
        this.#fail('the drawing log could not be created', error);
      });
  }

  // ------------------------------------------------------------------ plumbing

  status(): OverlayStatus {
    const window = this.#options.windows.get('drawing-overlay');
    return {
      open: window !== undefined,
      armed: this.#armed && window !== undefined,
      strokeCount: this.#strokeCount,
      error: this.#error,
    };
  }

  #publish(): void {
    const status = this.status();
    for (const window of this.#options.windows.all()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(CHANNEL.overlayStatus, status);
    }
  }

  /**
   * Record a failure as something the HUD can say, and carry on.
   *
   * There is no rethrow here and there must not be one: this is the function that
   * makes *"a drawing overlay must never break the recording"* true rather than
   * aspirational.
   */
  #fail(what: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#error = `${what}: ${detail}`;
    console.error('[overlay]', this.#error);
    this.#publish();
  }

  #fromOverlay(event: IpcMainEvent): boolean {
    return this.#roleOf(event) === 'drawing-overlay';
  }

  #fromControllingWindow(event: IpcMainEvent): boolean {
    const role = this.#roleOf(event);
    return role !== undefined && CONTROLLING_ROLES.includes(role);
  }

  #roleOf(event: IpcMainEvent): WindowRole | undefined {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (sender === null) return undefined;
    return this.#options.windows.roleOf(sender);
  }
}

/** Milliseconds, to microsecond resolution. Times are seconds, float, everywhere. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Read an untrusted {@link StrokeMsg}, or `null`.
 *
 * Structural and strict, because this is the only message in the app whose length a
 * renderer chooses. A stroke that fails any check is dropped rather than repaired:
 * ink is a decoration, and half a stroke drawn from half a message is a picture
 * nobody authored.
 */
function strokeMessage(raw: unknown): StrokeMsg | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = o['id'];
  const points = o['points'];
  const width = o['width'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_STROKE_POINTS * 2) {
    return null;
  }
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > 1) return null;
  const clean: number[] = [];
  for (const value of points) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    clean.push(value);
  }
  if (clean.length % 2 !== 0) return null;
  const color = o['color'];
  const tool: DrawingTool = o['tool'] === 'highlighter' ? 'highlighter' : 'pen';
  return {
    id,
    startedMsAgo: age(o['startedMsAgo']),
    endedMsAgo: age(o['endedMsAgo']),
    tool,
    color:
      typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color.slice(0, MAX_COLOR_LENGTH))
        ? color
        : '#DC3F12',
    width,
    points: clean,
  };
}

function eraseMessage(raw: unknown): EraseMsg | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const ids = o['ids'];
  if (!Array.isArray(ids)) return null;
  return {
    ids: ids.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(0, 4096),
    atMsAgo: age(o['atMsAgo']),
  };
}

/**
 * An age in milliseconds: finite, non-negative, and no older than an hour.
 *
 * The bound is not defensiveness for its own sake. An age is *subtracted* from the
 * recording clock, so a large one places a stroke at t=0 and a negative one places
 * it in the future — and `Math.max(0, …)` in {@link OverlayController} hides the
 * first while doing nothing about the second.
 */
function age(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(Math.max(raw, 0), 3_600_000);
}
