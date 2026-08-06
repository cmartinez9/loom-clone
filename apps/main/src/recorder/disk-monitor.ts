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
  private timer: NodeJS.Timeout | null = null;
  /** True while a poll is in flight, so a slow volume cannot queue polls behind it. */
  private polling = false;
  /** Latched by the first exhausted reading; cleared by {@link start}. */
  private exhausted = false;

  constructor(options: DiskMonitorOptions) {
    this.options = { intervalMs: DISK_THRESHOLDS.pollIntervalMs, ...options };
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
   * One poll, which by construction cannot throw.
   *
   * The `catch` around the *reading* turns an unreadable volume into `unknown`; the
   * `catch` around the *callbacks* is the accessory rule — a recorder that threw
   * while handling a banner must not leave the monitor wedged, and must not have
   * that throw arrive at a timer callback where the only receiver is the process's
   * unhandled-rejection handler.
   */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let space: DiskSpace | null = null;
      try {
        space = await this.options.read();
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
      const reading = classifyDisk(space, rate);
      this.emit(reading);
    } finally {
      this.polling = false;
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
