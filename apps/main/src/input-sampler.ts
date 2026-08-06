/**
 * Wiring the phase-5 input sampler to the one thing that writes.
 *
 * `@loom/sampler` deliberately has no filesystem: it spawns the native helper, folds
 * its NDJSON into the §2.5 shapes, and hands the bytes to an `EventLogSink`. This
 * module is the only implementation of that sink, and it is `ProjectStore` — so
 * cursor samples go through the same per-project queue, the same bundle lock and the
 * same atomic writes as `edit.json`. Report §0, rule 2: main is the only writer, and
 * within main there is one.
 *
 * `RecorderSession` is the caller. It starts a sampler for every recording, at the
 * instant the recording clock's origin becomes known, and stops it before the bundle
 * is closed — see `recorder/session.ts`'s sampling section for the ordering and for
 * what the origin costs to measure.
 */

import { join } from 'node:path';
import {
  HELPER_BASENAME,
  InputSampler,
  probeInput,
  unpackedHelperPath,
  type ClickCapability,
  type EventLogSink,
} from '@loom/sampler';
import type { CursorIndexDoc, EventLogKind, RecordingId } from '@loom/format';
import type { ProjectStore } from './project-store.ts';

/**
 * An `EventLogSink` backed by `ProjectStore`.
 *
 * Every method is one call into the store, which enqueues it on the project's write
 * chain. There is no buffering here on purpose — the sampler already batches to
 * §2.5's 100 ms cadence, and a second buffer would only add a place for samples to
 * be lost in a crash.
 */
export class ProjectStoreEventSink implements EventLogSink {
  private readonly store: ProjectStore;
  private readonly id: RecordingId;

  constructor(store: ProjectStore, id: RecordingId) {
    this.store = store;
    this.id = id;
  }

  create(log: EventLogKind): Promise<void> {
    return this.store.createEventLog(this.id, log);
  }

  append(log: EventLogKind, ndjson: string): Promise<void> {
    return this.store.appendEventLog(this.id, log, ndjson);
  }

  sync(log: EventLogKind): Promise<void> {
    return this.store.syncEventLog(this.id, log);
  }

  writeCursorImage(sha256: string, png: Uint8Array): Promise<void> {
    return this.store.writeCursorImage(this.id, sha256, png);
  }

  writeCursorIndex(doc: CursorIndexDoc): Promise<void> {
    return this.store.writeCursorIndex(this.id, doc);
  }
}

/**
 * One reading of the helper's clock, paired with this process's own.
 *
 * The sampler's `t0Us` is on the helper's `CLOCK_UPTIME_RAW`, which nothing in Node
 * can read: `process.hrtime` is `mach_continuous_time`, the same *rate* but a
 * different epoch — the two differ by however long the machine has been asleep since
 * boot. So they are related the only way they can be, by reading one at a known
 * instant on the other.
 *
 * {@link atUs} is the **later** end of the interval the reading was taken in, not its
 * midpoint. Where in that interval the helper stamped is not unknown, so there is no
 * difference to split: `probeReport()` evaluates `nowUptimeUs()` in the dictionary
 * literal it returns — after `AXIsProcessTrusted`, after the `CGEventTap`
 * create/enable/release, after `measureDisplay` — with only JSON serialisation, one
 * write and process exit left to run. The stamp therefore sits close to the end of
 * the interval, and the nearest estimator of it is the reading taken after the helper
 * exited.
 *
 * {@link uncertaintyUs} is consequently the **full** width of the interval and a
 * one-sided *bound* rather than a half-width: `atUs` is at or after the instant `tUs`
 * names, never before it. Reported rather than assumed small — a probe that took a
 * second is a reading nothing should be placed against.
 */
export interface HelperClockReading {
  /** The helper's `CLOCK_UPTIME_RAW` microsecond. */
  tUs: number;
  /**
   * When that instant was, on this process's monotonic clock, in microseconds.
   *
   * At or after the true instant, by at most {@link uncertaintyUs} — never before.
   */
  atUs: number;
  /**
   * The full width of the interval `tUs` was read in.
   *
   * A bound on how much later {@link atUs} is than the instant `tUs` names, in one
   * direction only.
   */
  uncertaintyUs: number;
}

/**
 * This process's monotonic clock, in microseconds — the clock
 * {@link HelperClockReading.atUs} is on.
 *
 * `process.hrtime`, not `performance.now()`. Two reasons, and the second is the one
 * that bit: it is `mach_continuous_time` on macOS, the same *rate* as the helper's
 * `CLOCK_UPTIME_RAW`, which is the whole assumption a reading is carried across on —
 * and it is a `process` API, so it exists in every main-process context. `performance`
 * is a global, and a global can be absent: `test/phase4-gate.test.ts` installs a fake
 * capture platform over `globalThis` and the recorder ran without one.
 */
export function monotonicUs(): number {
  return Number(process.hrtime.bigint()) / 1000;
}

/**
 * Read the helper's clock, so an instant this process observed can be named on it.
 *
 * Costs one run of the native helper (`probe`, which changes nothing and prompts for
 * nothing). `null` when the helper could not be run or did not report a usable
 * timestamp — and a `null` here means the recording gets no cursor log, deliberately:
 * placing a log against a fabricated origin is worse than not writing one, because
 * the generators would consume it and frame the shot against the wrong second.
 *
 * **`0` is refused alongside `null`.** `InputProbe.tUs` is `null` only when the helper
 * never answered; `parseHelperLine` coerces a missing or non-finite `tUs` on an
 * otherwise well-formed line to `0`, and that line is shared by every helper message
 * kind, so narrowing it is a protocol change rather than a fix here. An origin built
 * on `0` is the machine's uptime, which is exactly the log `MAX_SOURCE_TIME_SEC` in
 * `@loom/edl` drops sample by sample without saying so.
 *
 * **Which way the residual runs.** `atUs` is the reading taken *after* the helper
 * exited, so it is at or after the instant `tUs` names. The origin derived from it —
 * `tUs + (originAtUs - atUs)` — is therefore too small by at most
 * {@link HelperClockReading.uncertaintyUs}, and every `t` in the log, being measured
 * from that origin, is too large: samples are labelled **late**. That is the opposite
 * direction to the first frame's unmeasured encode and IPC latency, which makes the
 * origin too large and labels samples early (AGENTS.md, carried-forward item 10), so
 * the two partially cancel. Under the midpoint this used to take, they added.
 */
export async function readHelperClock(helperPath?: string): Promise<HelperClockReading | null> {
  const before = monotonicUs();
  const probe = await probeInput(helperPath === undefined ? {} : { helperPath });
  const after = monotonicUs();
  if (probe.tUs === null || probe.tUs <= 0) return null;
  return {
    tUs: probe.tUs,
    atUs: after,
    uncertaintyUs: after - before,
  };
}

export interface StartInputSamplerOptions {
  store: ProjectStore;
  id: RecordingId;
  /** `recording.json`'s `clock.t0Us` — the origin every `t` in the logs is measured from. */
  t0Us: number;
  /** `CGDirectDisplayID` of the display being recorded. */
  displayId?: number;
  /**
   * Whether to attempt click capture.
   *
   * `false` means *this caller opted out*, and reads back as `not-requested` — a
   * different sentence to show a user than the tap's own `accessibility-denied`.
   * `RecorderSession` therefore always passes `true` and never conditions the request
   * on `AXIsProcessTrusted()`: the app asked for Accessibility on the promise of this
   * log, so a grant the user declined has to arrive as the denial it was. See
   * `recorder/session.ts`'s sampling section.
   */
  clicks?: boolean;
  /** Where the helper lives. Defaults to `dist/native/loom-input-sampler`. */
  helperPath?: string;
  onCapability?: (capability: ClickCapability) => void;
}

/**
 * Start sampling into a recording bundle.
 *
 * Resolves once click capability is known, so the caller has the tap's own answer to
 * put into `recording.json`'s `events.clicks` rather than inferring one from whether
 * a log file exists. It is not where `capture.permissions.accessibility` comes from:
 * that is `readAxTrusted()` at the provisional write, before the first frame and
 * before any sampler exists.
 *
 * **The project must already be open, and it must stay open until `sampler.stop()`
 * has resolved.** Sampling writes from timers, so a `store.close(id)` that lands
 * first turns the tail of the cursor log into an `UnknownRecordingError` reported
 * through `onError`. `ProjectStore`'s event-log section states the same contract from
 * the other side.
 */
export async function startInputSampler(options: StartInputSamplerOptions): Promise<InputSampler> {
  const sampler = new InputSampler({
    sink: new ProjectStoreEventSink(options.store, options.id),
    t0Us: options.t0Us,
    ...(options.helperPath === undefined ? {} : { helperPath: options.helperPath }),
    ...(options.displayId === undefined ? {} : { displayId: options.displayId }),
    ...(options.clicks === undefined ? {} : { clicks: options.clicks }),
    ...(options.onCapability === undefined ? {} : { onCapability: options.onCapability }),
    onError: (error) => {
      // A sampler failure must never take a recording down with it: position and
      // clicks are both additive to the video, and §7.3's rule is that a lost
      // permission degrades the recording rather than ending it.
      console.error('[input-sampler]', error.message);
    },
  });
  await sampler.start();
  return sampler;
}

/**
 * Where the helper sits relative to the bundled main process.
 *
 * `dist/main/index.cjs` → `dist/native/loom-input-sampler`, unpacked out of the asar
 * archive by `electron-builder.yml` because an executable inside an archive cannot
 * be run. Passed explicitly rather than left to the package's own default so the one
 * place that knows this layout is the one place that owns `dist/`.
 *
 * `unpackedHelperPath` is not optional decoration: `spawn` is not asar-aware, so the
 * path has to name `app.asar.unpacked/` rather than rely on the `fs` shim.
 */
export function helperPathFor(distRoot: string): string {
  return unpackedHelperPath(join(distRoot, 'native', HELPER_BASENAME));
}
