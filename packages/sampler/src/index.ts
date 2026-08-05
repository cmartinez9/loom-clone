/**
 * `@loom/sampler` — the cursor and click sampler. Phase 5.
 *
 * Architecture report §2.5 (the cursor and click log), §6.1 (input conditioning),
 * §6.7 (cursor rendering), and the captain's settled decision in
 * `data/loom-scope/decision-accessibility-clicks.md`.
 *
 * The one thing to understand before using this: **cursor position and click capture
 * are not the same feature.** Position needs no permission and is the launch default.
 * Clicks need the macOS Accessibility grant, which cannot be requested
 * programmatically, needs a manual System Settings add plus an app restart, and —
 * the trap — *fails silently when absent*. So every consumer gets two distinguishable
 * facts and never one blurred one:
 *
 * - `capability.available` — whether clicks are being captured at all;
 * - `capability.count` — how many there were, or `null` if the question does not
 *   apply. It is never `0` for a recording where the tap was dead.
 *
 * Phase 10's auto-zoom-on-click reads this log. If it can read a zero out of a
 * machine that never had the permission, the feature silently does nothing on every
 * fresh install and nobody can tell why. That is the failure this package exists to
 * make impossible.
 *
 * Phase 2 owns the permission UI. What it drives it from is here:
 * `probeInput()` for a one-shot answer, `InputSampler.capability` and the
 * `onCapability` callback for live transitions, and `describeClickCapability()` so
 * main-process logs, `recording.json` and the window all say the same thing.
 */

export {
  CLICK_SOURCE,
  DEFAULT_FLUSH_MS,
  DEFAULT_SAMPLE_HZ,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  DEFAULT_SYNC_MS,
  InputSampler,
  type InputSamplerOptions,
  type SamplerHealth,
} from './sampler.ts';

export {
  describeClickCapability,
  failedClickCapability,
  initialClickCapability,
  needsRestart,
  type ClickCapability,
} from './capability.ts';

export {
  HELPER_BASENAME,
  HELPER_PATH_ENV,
  defaultHelperPath,
  probeInput,
  unpackedHelperPath,
  type InputProbe,
  type ProbeOptions,
} from './native.ts';

export {
  CLICK_UNAVAILABLE_REASONS,
  HELPER_PROTOCOL_VERSION,
  LineSplitter,
  isClickUnavailableReason,
  parseHelperLine,
  type ClickTapState,
  type ClickUnavailableReason,
  type HelperClickLine,
  type HelperCursorImageLine,
  type HelperCursorLine,
  type HelperDisplayInfo,
  type HelperDisplayLine,
  type HelperHealthLine,
  type HelperHelloLine,
  type HelperLine,
  type HelperProbeLine,
  type HelperStatusLine,
} from './protocol.ts';

export type { EventLogSink } from './sink.ts';
