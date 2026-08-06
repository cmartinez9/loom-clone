/**
 * §7.2's disk monitor: poll the volume, band the answer, call the stop.
 *
 * Architecture report §7.2 asks for a 2 s poll during a recording, a non-modal
 * banner below 5 GB, and a clean stop below 1 GB, under the rule the whole section
 * exists for:
 *
 * > **Never let a write fail.** Stopping at 1 GB with a good file beats hitting
 * > `ENOSPC` with a half-written fragment.
 *
 * Three things about the shape, each of which is the reason it is not simply a
 * `setInterval` inside `RecorderSession`.
 *
 * **1. It is an accessory, and the recording outranks it.** The same rule §7.3
 * gives audio and §7.4 gives the camera, applied one level further out: this class
 * is watching the recording, not part of it. So every callback it makes is wrapped,
 * every read that throws becomes a `DiskReading` of `level: 'unknown'` rather than
 * an exception with nowhere to go, and there is no path from a broken `statfs` to a
 * recording that stops. A monitor that could fail a recording would be a *new* way
 * to lose footage installed by the thing meant to prevent one.
 *
 * **2. It reads nothing itself.** The reader is injected — `ProjectStore.diskSpace`
 * in the app — because §0 rule 2 puts every syscall against the disk behind the
 * store, and because a monitor whose measurements can be driven is a monitor whose
 * threshold can be *watched being crossed*. §7.2's acceptance is a recording that
 * stops cleanly with a playable file, and waiting for a real volume to fill is not
 * a test anybody runs twice.
 *
 * **3. The stop fires once.** `onExhausted` is latched, so a poll landing while the
 * recording is already finalizing cannot ask for a second stop — and the latch is
 * cleared by {@link start} rather than by {@link stop}, so the next recording gets
 * its own.
 *
 * **4. Every wait has a deadline on it.** A read is the only unbounded thing here,
 * and it is a syscall against the volume the monitor is watching *because that volume
 * is in trouble*. Without a deadline a read that never settles leaves the in-flight
 * guard set for good: every later tick returns immediately, no reading is published,
 * nothing is logged, and §7.2's stop can never fire — a safety net that switches
 * itself off silently under exactly the condition it exists for, which is worse than
 * no net at all because the banner never appears and the user believes they are
 * covered. Same hazard, and the same answer, as `ENCODE_STALL_TIMEOUT_MS` and
 * `ExportRenderLoop.STALL_TIMEOUT_MS`.
 *
 * **5. An abandoned read is not a retired one, so there is a second guard under the
 * first.** A deadline lets the *poll* go; the `fs` request it was waiting on stays on
 * libuv's threadpool, which `ProjectStore`'s writes share. {@link
 * SingleFlightDiskRead} is what stops those piling up, and the two guards are
 * deliberately at different levels: the poll's flag must keep clearing on every
 * deadline, or point 4 is undone.
 */

import {
  DISK_THRESHOLDS,
  classifyDisk,
  diskRequiresStop,
  type CaptureRate,
  type DiskReading,
  type DiskSpace,
} from '@loom/ipc';

/** How the monitor asks. `ProjectStore.diskSpace` in the shipping app. */
export type DiskReader = () => Promise<DiskSpace>;

/**
 * How much of one poll interval a single read is given before it is given up on —
 * **half**, so 1 s against §7.2's 2 s.
 *
 * Derived from the interval rather than picked as a duration, because the property
 * that matters is the relation between the two: a timed-out read must land back
 * inside its own interval, or a stalled volume would stack a fresh poll on top of
 * every abandoned one and the in-flight guard would be doing nothing again. Half is
 * the loosest bound that keeps that true with room for the callbacks either side of
 * it. A `statfs` that has not answered in half a second was not about to answer
 * usefully — and the answer it would have given is about a volume half a second ago.
 */
const READ_DEADLINE_FRACTION = 0.5;

/** {@link readSpaceBeforeDeadline}'s deadline, from the interval it has to fit in. */
export function diskReadDeadlineMs(intervalMs: number): number {
  return Math.max(1, Math.round(intervalMs * READ_DEADLINE_FRACTION));
}

/** What {@link beforeDeadline} resolves to when the work did not. */
const TIMED_OUT = Symbol('the work passed its deadline');

/**
 * Any wait this feature makes against the filesystem, bounded. `null` for work that
 * did not answer in time — and it **says so**, because the defect this closes was
 * silent in both halves: nothing published and no line anywhere saying why, so an
 * instrument that had stopped watching looked exactly like a volume with nothing to
 * report.
 *
 * **One of these, because it is one hazard in three places.** A syscall against a
 * wedged volume never returns, and every path here runs one: the monitor's poll,
 * where it wedges the in-flight guard and silently disables §7.2's stop; the
 * preflight in `RecorderSession.start`, where it wedges the Record button with no
 * recording and no message; and the library walk behind the capacity estimate, which
 * is `readdir` and `stat` rather than `statfs` and hangs in exactly the same way.
 *
 * **A rejection is not caught here.** The callers log it — they already have that
 * line, and folding it in would make "the volume errored" and "the volume went
 * quiet" one message when they are different things to read in a log.
 */
export async function beforeDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
  timedOut: string,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, deadlineMs);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([work(), deadline]);
    if (answer === TIMED_OUT) {
      console.error(timedOut);
      return null;
    }
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

/** One read of the volume, bounded. `null` is `classifyDisk`'s `unknown`. */
export function readSpaceBeforeDeadline(
  read: DiskReader,
  deadlineMs: number,
): Promise<DiskSpace | null> {
  return beforeDeadline(
    read,
    deadlineMs,
    `[recorder] free space did not answer within ${String(deadlineMs)} ms; the volume ` +
      'reads as unknown and the recording continues',
  );
}

/**
 * At most one underlying read of the volume at a time: a caller arriving while one is
 * outstanding **joins** it rather than issuing a second.
 *
 * **This exists for the capture spine, and it is a second guard rather than a
 * replacement for the first.** {@link beforeDeadline} *abandons* a read that missed
 * its deadline — it cannot cancel one, because nothing in Node can cancel an `fs`
 * request — so without this a stalled volume would park one more request on libuv's
 * shared threadpool every poll. That pool is four threads wide by default and
 * `ProjectStore`'s media writes are on it too, so a few seconds of a stalled volume
 * would put `appendMediaChunk` behind the monitor's dead reads: the instrument
 * slowing the recording it is watching, which is the one thing §7.2's accessory rule
 * forbids. The poll's own guard is untouched and must stay so — it still completes on
 * its deadline, still publishes `unknown`, still logs.
 *
 * **Joining rather than skipping is what keeps §7.2's stop reachable.** A stalled
 * `statfs` returns when the volume comes back, and the poll that is waiting on it
 * gets that answer in the same tick, so the stop fires on the first real reading
 * rather than an interval later.
 *
 * **What it cannot do**, recorded rather than papered over: if the volume's metadata
 * stays wedged for ever while writes to it still succeed, this monitor stays blind,
 * because there is no way to retire the request that is stuck. The alternative —
 * a fresh read every two seconds — trades a blind instrument for a blocked capture
 * spine, and the recording outranks the instrument.
 */
export class SingleFlightDiskRead {
  private readonly source: DiskReader;
  /** The read still on the threadpool, if any. */
  private pending: Promise<DiskSpace> | null = null;

  constructor(source: DiskReader) {
    this.source = source;
  }

  read(): Promise<DiskSpace> {
    if (this.pending !== null) return this.pending;
    const attempt = this.source();
    this.pending = attempt;
    const settled = (): void => {
      if (this.pending === attempt) this.pending = null;
    };
    void attempt.then(settled, settled);
    return attempt;
  }
}

export interface DiskMonitorOptions {
  read: DiskReader;
  /**
   * What a second of *this* recording is costing, asked fresh on every poll.
   *
   * A function rather than a number because the answer changes: the first seconds
   * of a recording have nothing measurable in them and fall back to the library's
   * average, and by the second minute the recording is measuring itself.
   */
  rate: () => CaptureRate;
  /** Every poll, banded. The recorder republishes it; the HUD draws the banner. */
  onReading: (reading: DiskReading) => void;
  /**
   * §7.2's clean stop, called at most once per {@link start}.
   *
   * The monitor does not stop anything itself — it does not know what a recording
   * is. It says the disk is out, and the recorder decides what "stop cleanly" means.
   */
  onExhausted: (reading: DiskReading) => void;
  /** §7.2's 2 s. Overridden only by tests, which drive the clock rather than wait. */
  intervalMs?: number;
}

export class DiskMonitor {
  private readonly options: Required<DiskMonitorOptions>;
  /** One read's deadline. See {@link READ_DEADLINE_FRACTION}. */
  private readonly deadlineMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** True while a poll is in flight, so a slow volume cannot queue polls behind it. */
  private polling = false;
  /**
   * Which {@link start} the in-flight poll belongs to.
   *
   * A poll left over from the previous recording must neither swallow this one's
   * promised immediate reading nor publish against it once it lands, and the flag
   * alone cannot tell the two apart.
   */
  private generation = 0;
  /** Latched by the first exhausted reading; cleared by {@link start}. */
  private exhausted = false;

  constructor(options: DiskMonitorOptions) {
    this.options = { intervalMs: DISK_THRESHOLDS.pollIntervalMs, ...options };
    this.deadlineMs = diskReadDeadlineMs(this.options.intervalMs);
  }

  /**
   * Begin watching. Polls **immediately** and then on the interval.
   *
   * Immediately, because a recording started on a volume that is already low should
   * carry its banner from the first status rather than from the third — the user
   * pressed record two seconds ago and is still looking at the HUD.
   */
  start(): void {
    this.stop();
    this.exhausted = false;
    // A poll the previous recording left in flight belongs to the previous
    // recording: it does not get to hold this one's guard, and it does not get to
    // publish once it lands. Clearing the flag is what makes the immediate poll
    // below actually immediate.
    this.generation += 1;
    this.polling = false;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.intervalMs);
    // Nothing about a recording should keep the process alive on its own account.
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether the monitor is running. Read by the recorder's status, not by policy. */
  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * One poll, which by construction cannot throw and cannot wait for ever.
   *
   * The `catch` around the *reading* turns an unreadable volume into `unknown`; the
   * `catch` around the *callbacks* is the accessory rule — a recorder that threw
   * while handling a banner must not leave the monitor wedged, and must not have
   * that throw arrive at a timer callback where the only receiver is the process's
   * unhandled-rejection handler. The guard is released on **every** exit, including
   * a read that never answered, or the first stalled poll would be the last poll.
   */
  private async poll(): Promise<void> {
    if (this.polling) return;
    const generation = this.generation;
    this.polling = true;
    try {
      let space: DiskSpace | null = null;
      try {
        space = await readSpaceBeforeDeadline(() => this.options.read(), this.deadlineMs);
      } catch (error) {
        // Logged once per poll rather than latched: a volume that comes back is
        // worth seeing come back, and 2 s is not a rate that floods anything.
        console.error('[recorder] free space could not be read:', error);
      }
      let rate: CaptureRate;
      try {
        rate = this.options.rate();
      } catch (error) {
        console.error('[recorder] the capture rate could not be measured:', error);
        // A rate that could not be taken must not be reported as a measured zero:
        // `classifyDisk` substitutes the reference figure for a non-positive rate,
        // and this says out loud that that is what happened.
        rate = { bytesPerSec: 0, source: 'reference', sampleCount: 0 };
      }
      // A reading taken for a recording that has since been replaced is a fact about
      // the volume at a moment nobody is watching any more.
      if (generation !== this.generation) return;
      const reading = classifyDisk(space, rate);
      this.emit(reading);
    } finally {
      if (generation === this.generation) this.polling = false;
    }
  }

  private emit(reading: DiskReading): void {
    try {
      this.options.onReading(reading);
    } catch (error) {
      console.error('[recorder] the disk reading could not be published:', error);
    }
    if (!diskRequiresStop(reading) || this.exhausted) return;
    this.exhausted = true;
    // Watching stops here. §7.2's stop is a finalize, and a poll arriving in the
    // middle of one is a reading about a recording that no longer exists.
    this.stop();
    try {
      this.options.onExhausted(reading);
    } catch (error) {
      console.error('[recorder] the disk-full stop could not be started:', error);
    }
  }
}
