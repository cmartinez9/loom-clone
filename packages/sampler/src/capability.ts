/**
 * What the sampler can currently do, and what phase 2 needs in order to ask for more.
 *
 * Phase 5 deliberately stops here. The permission-request flow, the first-run setup
 * and every piece of TCC-prompting UI belong to phase 2; this module is the explicit
 * state phase 2 drives that UI from, and nothing else. The captain's decision
 * (`data/loom-scope/decision-accessibility-clicks.md`) settles the product shape:
 * ask for Accessibility up front, explain what breaks without it, handle the restart
 * gracefully, and *verify the grant with `AXIsProcessTrusted()`, never by assuming*.
 * The verification is here; the asking is not.
 */

import type { ClickTapState, ClickUnavailableReason } from './protocol.ts';

/**
 * The click tap's state, plus what a consumer can conclude from it.
 *
 * The one field to read first is `count`. It is `null`, not `0`, whenever clicks
 * were not captured — so a consumer that treats "no clicks" as a number gets a type
 * error instead of a wrong answer. Phase 10's auto-zoom-on-click generator has
 * exactly one input and this is it; if that generator can read `0` from a machine
 * where the tap was dead, the feature silently does nothing and nobody can tell why.
 */
export interface ClickCapability extends ClickTapState {
  /**
   * `true` when TCC says this process holds the grant but no live tap can be built.
   *
   * That combination has one cause and one fix: an Accessibility grant does not
   * reach a running process's event taps, so the app must be relaunched. This is the
   * "handle the restart gracefully" case in the captain's decision.
   *
   * The mirror case — the user has just added the app in System Settings but
   * `AXIsProcessTrusted()` is still false — is *not* detectable from in here; it
   * looks exactly like never having been granted. Phase 2 knows it sent the user to
   * Settings, so phase 2 owns that half.
   */
  restartRequired: boolean;
  /** Clicks captured so far, or `null` if clicks were never live. Never a zero that lies. */
  count: number | null;
  /** Seconds into the recording at which a live tap first went dead, or `null`. */
  degradedAtSec: number | null;
  /**
   * `true` only if the tap was live from the first sample to the last.
   *
   * A tap that came up and later died leaves a real, partial `clicks.ndjson`. The
   * clicks in it happened; the ones missing from it may have happened too. That is
   * not a log any generator should treat as complete, so it is not reported as
   * available.
   */
  liveThroughout: boolean;
}

/** The state before a sampler has started: honest about knowing nothing yet. */
export function initialClickCapability(requested: boolean): ClickCapability {
  return {
    available: false,
    reason: requested ? 'unknown' : 'not-requested',
    requested,
    axTrusted: false,
    tapCreated: false,
    tapEnabled: false,
    restartRequired: false,
    count: null,
    degradedAtSec: null,
    liveThroughout: false,
  };
}

export function failedClickCapability(
  reason: ClickUnavailableReason,
  requested = true,
): ClickCapability {
  return { ...initialClickCapability(requested), reason };
}

/** `restartRequired`: TCC says yes, the window server says no. Only a relaunch fixes it. */
export function needsRestart(state: ClickTapState): boolean {
  return state.requested && state.axTrusted && !state.tapEnabled;
}

/**
 * What the app should say, in one line, given a capability.
 *
 * Kept next to the state rather than in a window so that main-process logs, the
 * `recording.json` diagnosis and whatever phase 2 renders all say the same thing.
 * Phase 2 is free to write better copy; it is not free to invent a different set of
 * cases.
 */
export function describeClickCapability(capability: ClickCapability): string {
  if (capability.available) return 'Click capture is live.';
  switch (capability.reason) {
    case 'not-requested':
      return 'Click capture is off. Cursor position is still being recorded.';
    case 'accessibility-denied':
      return (
        'Click capture needs the Accessibility permission, which macOS only grants ' +
        'from System Settings. Cursor position is still being recorded.'
      );
    case 'tap-create-failed':
    case 'tap-dead':
      return capability.restartRequired
        ? 'Accessibility is granted, but the permission only reaches this app after a restart.'
        : 'macOS refused a click event tap. Cursor position is still being recorded.';
    case 'tap-disabled-by-timeout':
      return 'macOS disabled click capture because it stopped responding in time.';
    case 'tap-disabled-by-user-input':
      return 'Click capture was disabled by the system.';
    case 'helper-missing':
      return 'The input sampler is missing from this build. Cursor and clicks are both off.';
    case 'helper-failed':
      return 'The input sampler stopped unexpectedly.';
    default:
      return 'Click capture is unavailable for an unrecognised reason.';
  }
}
