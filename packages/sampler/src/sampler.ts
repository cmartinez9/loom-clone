/**
 * `InputSampler` — the cursor and click sampler. Architecture report §2.5, §6.1.
 *
 * Runs `loom-input-sampler` alongside a recording, turns its wire lines into the
 * §2.5 on-disk shapes, and keeps an explicit, queryable account of what click
 * capture is actually doing.
 *
 * Three things it does *not* do, on purpose:
 *
 * - **It does not condition the signal.** §6.1's shake filter, decimation to 60 Hz
 *   and cursor-shape debounce are edit-time transforms with tuned constants, and
 *   applying them at write time would destroy the data the tuning needs. §2.5 says
 *   *log generously* — 126 KB/min, under 1 MB/hour gzipped — and that is the trade
 *   this takes.
 * - **It does not generate anything.** Cursor-follow and auto-zoom-on-click are
 *   phase 10, and they consume this log.
 * - **It does not ask for permissions.** Phase 2 owns every TCC prompt and the
 *   first-run flow. What this exposes is the state phase 2 drives them from:
 *   `probeInput()` before a recording, `capability` during one.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { BUNDLE, cursorImagePath, type CursorIndexDoc, type RecordingEvents } from '@loom/format';
import { describeClickCapability, needsRestart, type ClickCapability } from './capability.ts';
import { defaultHelperPath } from './native.ts';
import {
  HELPER_PROTOCOL_VERSION,
  LineSplitter,
  parseHelperLine,
  type ClickTapState,
  type ClickUnavailableReason,
  type HelperCursorImageLine,
  type HelperDisplayInfo,
} from './protocol.ts';
import type { EventLogSink } from './sink.ts';

/** §6.1: sample at 120 Hz — 24.2 px worst-case gap at 1885 px/s, vs 70.7 px at 30 Hz. */
export const DEFAULT_SAMPLE_HZ = 120;

/** §2.5: appended every 100 ms and `fsync`'d every second. */
export const DEFAULT_FLUSH_MS = 100;
export const DEFAULT_SYNC_MS = 1000;

/**
 * How long `start()` waits for the helper's first status line.
 *
 * The same bound `probeInput()` uses, for the same reason: a helper that spawns and
 * then never speaks must become a reported failure, not a recording that never begins.
 */
export const DEFAULT_START_TIMEOUT_MS = 5000;

/**
 * How long `stop()` waits for the helper to close its output before abandoning it.
 *
 * `'close'` rather than `'exit'` is what says the final flush window has been read,
 * and that is a promise somebody else has to keep: `'close'` needs *every* holder of
 * the pipe to let go, not just the process to be reaped. Two holders in this codebase
 * may not. The acceptance test's disclaim shim runs `spawn-disclaimed`, which
 * `posix_spawn`s a grandchild on the inherited fds and installs no signal handler, so
 * a `SIGTERM` kills the shim on the default disposition and orphans a grandchild that
 * still holds stdout. The production analogue is a main run loop wedged inside
 * `NSCursor.currentSystemCursor`, which outlives the helper's own `SIGTERM` dispatch
 * source because that source only asks `CFRunLoopStop` nicely. Neither may leave a
 * recording unable to finalize, so the wait is bounded and an abandoned helper is
 * reported rather than waited on.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 5000;

/**
 * How long the helper gets to leave on its own after `stop`, before `SIGTERM` and
 * then `SIGKILL`.
 *
 * `SIGKILL` is the escalation a wedged run loop cannot ignore, and the only one that
 * closes the stdout of a helper stuck inside AppKit. It cannot help against the
 * orphaned grandchild above — nothing this process can signal holds that pipe — which
 * is why the bound exists on top of it.
 */
const STOP_GRACE_MS = 1000;

/** `RecordingEvents.clicks.source` — the mechanism, so a log is diagnosable later. */
export const CLICK_SOURCE = 'cgeventtap';

export interface InputSamplerOptions {
  sink: EventLogSink;
  /**
   * The recording clock's origin, in microseconds on the helper's monotonic uptime
   * clock — i.e. `recording.json`'s `clock.t0Us` (§2.3). Every `t` written to the
   * logs is `(tUs - t0Us) / 1e6`, which is what makes §2.5's *"`t` shares its origin
   * with `VideoFrame.timestamp`"* true rather than aspirational.
   */
  t0Us: number;
  /** Absolute path to the native helper. Defaults to `dist/native/loom-input-sampler`. */
  helperPath?: string;
  /**
   * Whether to attempt click capture at all.
   *
   * `false` is the honest setting when the user declined Accessibility: it produces
   * `reason: 'not-requested'` rather than `accessibility-denied`, and those are
   * different things to tell somebody.
   */
  clicks?: boolean;
  hz?: number;
  /** `CGDirectDisplayID` of the display being recorded. Defaults to the main display. */
  displayId?: number;
  flushMs?: number;
  syncMs?: number;
  /**
   * How long `start()` waits for the helper's first status line before giving up.
   *
   * A helper that spawns and then hangs — a stale binary behind `LOOM_INPUT_SAMPLER`,
   * an AppKit call that blocks in a session with no window server — would otherwise
   * leave `start()` pending forever, which is the one failure this module's contract
   * does not allow: a helper that cannot report is reported, never waited on.
   */
  startTimeoutMs?: number;
  /**
   * How long `stop()` waits for the helper to close its output before abandoning it.
   *
   * See {@link DEFAULT_STOP_TIMEOUT_MS} for the two ways a helper's stdout can outlive
   * every signal this process can send it.
   */
  stopTimeoutMs?: number;
  /** Called on every click-capability transition — never on every sample. */
  onCapability?: (capability: ClickCapability) => void;
  /** Background failures with no caller to return to. Logged loudly by default. */
  onError?: (error: Error) => void;
}

export interface SamplerHealth {
  /** Cursor samples written. */
  samples: number;
  /** Clicks written, or `null` when the tap was never live. */
  clicks: number | null;
  /** Lines the helper's bounded buffer dropped, plus lines this side could not parse. */
  dropped: number;
  running: boolean;
}

type SamplerState = 'idle' | 'running' | 'stopping' | 'stopped';

export class InputSampler {
  private readonly options: Required<Omit<InputSamplerOptions, 'onCapability' | 'onError'>> &
    Pick<InputSamplerOptions, 'onCapability' | 'onError'>;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly splitter = new LineSplitter();
  private state: SamplerState = 'idle';
  private readyResolve: (() => void) | null = null;
  private exit: Promise<void> = Promise.resolve();

  /** The last thing the helper said about the tap, unembellished. */
  private tap: ClickTapState;
  /**
   * The most recent timestamp the helper reported.
   *
   * The clock a transition is stamped with when the helper is no longer there to
   * stamp it — the last instant it was known to be alive. Starts at `t0Us`, so a
   * helper that never spoke at all puts its refusal at the top of the recording
   * rather than at a fabricated negative time.
   */
  private lastTUs: number;
  /** Set the first time the tap is confirmed live. `clicks.ndjson` exists from then on. */
  private clicksEverLive = false;
  private degradedAtSec: number | null = null;
  private clickCount = 0;
  private sampleCount = 0;
  private helperDropped = 0;
  private unparseableLines = 0;
  private display: HelperDisplayInfo | null = null;

  private readonly cursorImages = new Map<string, HelperCursorImageLine>();
  /** Buffered NDJSON per log, drained on the flush timer. */
  private readonly pending: Record<'cursor' | 'clicks', string> = { cursor: '', clicks: '' };
  /**
   * One promise chain for every write.
   *
   * Two `append`s awaited concurrently could land out of order, and an event log
   * whose lines are not in time order is not something a later phase can bisect.
   */
  private writes: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(options: InputSamplerOptions) {
    this.options = {
      helperPath: options.helperPath ?? defaultHelperPath(),
      clicks: options.clicks ?? true,
      hz: options.hz ?? DEFAULT_SAMPLE_HZ,
      displayId: options.displayId ?? 0,
      flushMs: options.flushMs ?? DEFAULT_FLUSH_MS,
      syncMs: options.syncMs ?? DEFAULT_SYNC_MS,
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      sink: options.sink,
      t0Us: options.t0Us,
      ...(options.onCapability === undefined ? {} : { onCapability: options.onCapability }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    };
    this.lastTUs = options.t0Us;
    this.tap = {
      available: false,
      // Not `null`. Before the helper has spoken, "clicks are fine" is not something
      // this build knows, and `null` is how the capability says exactly that.
      reason: this.options.clicks ? 'unknown' : 'not-requested',
      requested: this.options.clicks,
      axTrusted: false,
      tapCreated: false,
      tapEnabled: false,
    };
  }

  /**
   * The current click-capability state. Safe to read at any point in the lifecycle.
   *
   * Derived on read rather than cached, so `count` cannot go stale between the last
   * status line and the next click.
   */
  get capability(): ClickCapability {
    return {
      ...this.tap,
      restartRequired: needsRestart(this.tap),
      // `null`, not `0`. A consumer must not be able to read "no clicks happened"
      // out of a recording where clicks were never captured.
      count: this.clicksEverLive ? this.clickCount : null,
      degradedAtSec: this.degradedAtSec,
      liveThroughout: this.clicksEverLive && this.tap.available && this.degradedAtSec === null,
    };
  }

  get health(): SamplerHealth {
    return {
      samples: this.sampleCount,
      clicks: this.clicksEverLive ? this.clickCount : null,
      dropped: this.helperDropped + this.unparseableLines,
      running: this.state === 'running',
    };
  }

  /** The display positions are normalized against, once the helper has reported it. */
  get displayInfo(): HelperDisplayInfo | null {
    return this.display;
  }

  /**
   * Start sampling.
   *
   * Resolves once the helper has reported its first click status — so a caller that
   * awaits this knows, before the first frame, whether clicks are being captured. A
   * helper that cannot be spawned is not fatal: cursor position is the launch default
   * and a recording without clicks is still a recording, so the failure is reported
   * through `capability` and `onError` rather than thrown.
   */
  async start(): Promise<ClickCapability> {
    if (this.state !== 'idle') throw new Error('the input sampler has already been started');
    this.state = 'running';

    const args = [
      'run',
      '--hz',
      String(this.options.hz),
      '--flush-ms',
      String(this.options.flushMs),
    ];
    if (this.options.displayId > 0) args.push('--display', String(this.options.displayId));
    if (!this.options.clicks) args.push('--no-clicks');

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      return this.fail('helper-missing', describe(error));
    }
    this.child = child;

    const ready = new Promise<void>((fulfil) => {
      this.readyResolve = fulfil;
      // A helper that dies before saying anything must not hang `start()`. Both are
      // resolved on `close` rather than `exit` so the handler below — which turns the
      // death into a capability — has already run when this settles.
      child.once('error', fulfil);
      child.once('close', fulfil);
    });

    // `close`, not `exit`. `exit` fires when the process is reaped, which can be
    // while the last chunk it wrote is still in the pipe; `close` is the event that
    // means stdout has been drained. The helper flushes and returns from `main`
    // microseconds later, so the final flush window — the last samples, any
    // `cursorimg` in it, the `bye` — is exactly what `exit` would leave behind for a
    // `data` event that arrives after `stop()` has already finished writing.
    this.exit = new Promise<void>((fulfil) => {
      child.once('close', (code, signal) => {
        this.child = null;
        for (const line of this.splitter.flush()) this.handleLine(line);
        if (this.state === 'running') {
          this.fail(
            'helper-failed',
            `the input sampler exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
          );
        }
        fulfil();
      });
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of this.splitter.push(chunk)) this.handleLine(line);
      this.flushSoon();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) this.report(new Error(`[loom-input-sampler] ${text}`));
    });
    child.once('error', (error) => {
      if (this.state === 'running') this.fail('helper-missing', describe(error));
    });

    this.syncTimer = setInterval(() => {
      this.enqueue(() => this.syncLogs());
    }, this.options.syncMs);
    this.syncTimer.unref?.();

    const overdue = setTimeout(() => {
      if (this.state !== 'running') return;
      // The helper is alive and mute. Killing it is part of the failure: a process
      // that never reported would otherwise go on sampling into a pipe nobody reads
      // for the life of the app.
      child.kill('SIGTERM');
      this.fail(
        'helper-failed',
        `the input sampler did not report its status within ` +
          `${String(this.options.startTimeoutMs)} ms`,
      );
    }, this.options.startTimeoutMs);
    overdue.unref?.();

    await ready;
    clearTimeout(overdue);
    return this.capability;
  }

  /**
   * Stop sampling and flush everything.
   *
   * `stop` on stdin first, `SIGTERM` after a grace period, `SIGKILL` after another:
   * the helper's clean exit path disables the tap and flushes its own buffer, and
   * killing it outright would discard up to 100 ms of samples for no reason.
   *
   * The whole wait is bounded by {@link DEFAULT_STOP_TIMEOUT_MS}, because a pipe can
   * be held by something no signal of ours reaches. Whatever the helper managed to
   * say is written either way; what the bound gives up on is the helper, and that is
   * said out loud through `onError` rather than left as a recording that never
   * finalizes.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') {
      await this.finishWrites();
      return;
    }
    const wasRunning = this.state === 'running';
    this.state = 'stopping';

    const child = this.child;
    if (wasRunning && child !== null) {
      try {
        child.stdin.write('{"cmd":"stop"}\n');
        child.stdin.end();
      } catch {
        // The pipe is already gone; the exit handler covers it.
      }
      const term = setTimeout(() => child.kill('SIGTERM'), STOP_GRACE_MS);
      term.unref?.();
      const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS * 2);
      kill.unref?.();

      const abandoned = await this.awaitExit();
      clearTimeout(term);
      clearTimeout(kill);
      if (abandoned) {
        child.kill('SIGKILL');
        this.report(
          new Error(
            `the input sampler did not close its output within ` +
              `${String(this.options.stopTimeoutMs)} ms and has been abandoned; it may still ` +
              `hold a click event tap`,
          ),
        );
      }
    }

    this.clearTimers();
    this.state = 'stopped';
    // Whatever the helper managed to say before it went is still worth keeping.
    this.flushNow();
    this.enqueue(() => this.syncLogs());
    await this.finishWrites();
  }

  /**
   * The `recording.json` fragment describing what was captured (§2.3, `RecordingEvents`).
   *
   * `clicks` is **always present**, even when the log is not, because `available:
   * false` and an absent `clicks` key mean different things: the first says clicks
   * were attempted and could not be captured, the second says nothing at all. `file`
   * names the canonical path whether or not it exists — a consumer checks `available`
   * before opening it.
   *
   * `available` is `true` only when the tap was live for the whole session. A tap
   * that came up and later died leaves a real but incomplete log, and no generator
   * should treat incomplete as complete.
   */
  recordingEvents(): RecordingEvents {
    return {
      cursor: { file: BUNDLE.cursorLog, hz: this.options.hz, sampleCount: this.sampleCount },
      clicks: {
        file: BUNDLE.clickLog,
        available: this.capability.liveThroughout,
        source: CLICK_SOURCE,
      },
      cursorImages: BUNDLE.cursorIndex,
    };
  }

  /** `cursors/index.json` as it stands. Written through the sink as shapes appear. */
  cursorIndex(): CursorIndexDoc {
    const images: CursorIndexDoc['images'] = {};
    for (const [id, image] of this.cursorImages) {
      images[id] = { file: cursorImagePath(id), hotspot: image.hotspot, shape: image.shape };
    }
    return { schema: 'loom.cursors/1', images };
  }

  // -------------------------------------------------------------- line handling

  private handleLine(raw: string): void {
    const line = parseHelperLine(raw);
    if (line === null) {
      if (raw.trim().length > 0) this.unparseableLines += 1;
      return;
    }
    if (line.k !== 'cursorimg' && line.tUs > this.lastTUs) this.lastTUs = line.tUs;
    switch (line.k) {
      case 'hello':
        if (line.version !== HELPER_PROTOCOL_VERSION) {
          this.report(
            new Error(
              `the input sampler speaks protocol ${line.version}; this build speaks ` +
                `${HELPER_PROTOCOL_VERSION}`,
            ),
          );
        }
        break;

      case 'status':
        this.applyTapState(line.clicks, line.tUs);
        this.readyResolve?.();
        this.readyResolve = null;
        break;

      case 'cursor':
        this.sampleCount += 1;
        this.pending.cursor += `${JSON.stringify({
          t: this.seconds(line.tUs),
          x: line.x,
          y: line.y,
          c: line.c,
          m: line.m,
        })}\n`;
        break;

      case 'click':
        this.clickCount += 1;
        this.pending.clicks += `${JSON.stringify({
          t: this.seconds(line.tUs),
          e: line.e,
          b: line.b,
          x: line.x,
          y: line.y,
          m: line.m,
        })}\n`;
        break;

      case 'display':
        this.display = {
          display: line.display,
          logicalSize: line.logicalSize,
          scaleFactor: line.scaleFactor,
        };
        // §2.5: "A display reconfiguration mid-recording is representable." This is
        // that line, and it is what stops a resolution change from silently
        // reinterpreting every normalized position after it.
        this.pending.cursor += `${JSON.stringify({
          t: this.seconds(line.tUs),
          e: 'display',
          display: line.display,
          logicalSize: line.logicalSize,
          scaleFactor: line.scaleFactor,
        })}\n`;
        break;

      case 'cursorimg':
        this.recordCursorImage(line);
        break;

      case 'health':
        this.helperDropped = line.dropped;
        break;

      case 'bye':
      case 'probe':
        break;
    }
  }

  /**
   * Seconds since the recording clock's origin.
   *
   * Microsecond-exact, not rounded to §2.5's illustrative four decimals: the source
   * *is* microseconds, and throwing precision away in the one file whose whole job is
   * to line up with `VideoFrame.timestamp` buys nothing worth having.
   */
  private seconds(tUs: number): number {
    return (tUs - this.options.t0Us) / 1_000_000;
  }

  /**
   * Fold a helper status into the capability, and write the transition to the log.
   *
   * The transition goes into **`cursor.ndjson`**, as a §2.5 `e` event. Two reasons:
   * `clicks.ndjson` is typed as click events only, and — the real one — the cursor
   * log always exists, while the click log is exactly the file that is missing when
   * there is something to say. A record of "the tap died at t=42" that lives only in
   * the file the failure prevented from existing is no record at all.
   */
  private applyTapState(state: ClickTapState, tUs: number): void {
    const previous = this.capability;
    const wasLive = this.clicksEverLive;

    if (state.available) this.clicksEverLive = true;
    if (wasLive && !state.available && this.degradedAtSec === null) {
      this.degradedAtSec = this.seconds(tUs);
    }
    this.tap = state;
    const next = this.capability;

    const changed =
      previous.available !== next.available ||
      previous.reason !== next.reason ||
      previous.axTrusted !== next.axTrusted ||
      previous.tapCreated !== next.tapCreated ||
      previous.tapEnabled !== next.tapEnabled ||
      previous.restartRequired !== next.restartRequired;
    if (!changed) return;

    this.pending.cursor += `${JSON.stringify({
      t: this.seconds(tUs),
      e: 'clicks',
      available: next.available,
      reason: next.reason,
      axTrusted: next.axTrusted,
      tapCreated: next.tapCreated,
      tapEnabled: next.tapEnabled,
      note: describeClickCapability(next),
    })}\n`;

    // The moment clicks become real, the log becomes a claim: from here on, an empty
    // `clicks.ndjson` means "we watched and nothing happened" — which is exactly the
    // fact that must *not* exist when Accessibility is denied.
    if (state.available && !wasLive) {
      this.enqueue(() => this.options.sink.create('clicks'));
    }

    this.options.onCapability?.(next);
  }

  private recordCursorImage(line: HelperCursorImageLine): void {
    if (this.cursorImages.has(line.id)) return;
    this.cursorImages.set(line.id, line);
    const png = Buffer.from(line.png, 'base64');
    this.enqueue(async () => {
      await this.options.sink.writeCursorImage(line.id, png);
      // Rewritten on every new shape rather than once at stop: a crash mid-recording
      // must not leave `cursors/` full of bitmaps that `index.json` cannot name.
      await this.options.sink.writeCursorIndex(this.cursorIndex());
    });
  }

  // ------------------------------------------------------------------- plumbing

  private async syncLogs(): Promise<void> {
    await this.options.sink.sync('cursor');
    if (this.clicksEverLive) await this.options.sink.sync('clicks');
  }

  /**
   * Stop the flush and sync timers.
   *
   * Called from `stop()` and from `fail()`. A helper that dies takes the sampler with
   * it, and an interval nobody cleared would go on syncing a closed log for the life
   * of the process.
   */
  private clearTimers(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.syncTimer !== null) clearInterval(this.syncTimer);
    this.flushTimer = null;
    this.syncTimer = null;
  }

  private flushSoon(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, this.options.flushMs);
    this.flushTimer.unref?.();
  }

  private flushNow(): void {
    const cursor = this.pending.cursor;
    const clicks = this.pending.clicks;
    this.pending.cursor = '';
    this.pending.clicks = '';
    if (cursor.length > 0) this.enqueue(() => this.options.sink.append('cursor', cursor));
    if (clicks.length > 0) this.enqueue(() => this.options.sink.append('clicks', clicks));
  }

  private enqueue(work: () => Promise<void>): void {
    this.writes = this.writes.then(work, work).catch((error: unknown) => {
      this.report(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /**
   * Wait for the helper's output to close, bounded.
   *
   * Resolves `false` when the helper closed, `true` when the bound expired first and
   * the caller should treat it as abandoned.
   */
  private awaitExit(): Promise<boolean> {
    return new Promise<boolean>((fulfil) => {
      const bound = setTimeout(() => {
        fulfil(true);
      }, this.options.stopTimeoutMs);
      bound.unref?.();
      void this.exit.then(() => {
        clearTimeout(bound);
        fulfil(false);
      });
    });
  }

  /** Drain the write chain, including work the drained work itself enqueued. */
  private async finishWrites(): Promise<void> {
    let previous: Promise<void> | null = null;
    while (previous !== this.writes) {
      previous = this.writes;
      await previous;
    }
  }

  /**
   * The helper is gone. Report it as the click-availability transition it is.
   *
   * Through `applyTapState`, not around it: a helper that dies after the tap was live
   * leaves a populated `clicks.ndjson` that stops being a faithful record at a
   * particular moment, and that moment belongs in `cursor.ndjson` and in
   * `degradedAtSec` like every other transition. Stamped with the last time the helper
   * reported, which is the last instant the log is known to be trustworthy.
   */
  private fail(
    reason: Extract<ClickUnavailableReason, `helper-${string}`>,
    problem: string,
  ): ClickCapability {
    this.state = 'stopped';
    this.clearTimers();
    this.applyTapState({ ...this.tap, available: false, reason }, this.lastTUs);
    // Whatever was buffered when the helper went is still real data.
    this.flushNow();
    this.report(new Error(problem));
    this.readyResolve?.();
    this.readyResolve = null;
    return this.capability;
  }

  private report(error: Error): void {
    if (this.options.onError !== undefined) this.options.onError(error);
    else console.error('[InputSampler]', error.message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
