/**
 * Whether clicks were captured at all — the one fact auto-zoom must not be able to
 * guess wrong.
 *
 * The captain's settled decision (`data/loom-scope/decision-accessibility-clicks.md`):
 *
 * > A user who declines Accessibility must still get a fully working recorder:
 * > cursor-follow by position, manual zoom, and everything else keep working. Only
 * > click-triggered auto-zoom and click highlights degrade.
 *
 * and the research finding underneath it: `CGEvent.tapCreate` **succeeds** without the
 * grant and then silently delivers nothing. `@loom/sampler`'s header states the
 * consequence for this phase by name — *"Phase 10's auto-zoom-on-click reads this log.
 * If it can read a zero out of a machine that never had the permission, the feature
 * silently does nothing on every fresh install and nobody can tell why"* — and keeps
 * `ClickCapability.count` at `null` rather than `0` so the mistake is a type error.
 *
 * `edl` is pure and cannot open `recording.json`, so this is the shape that carries
 * the same distinction across the seam. It is a **discriminated union on purpose**:
 * there is no way to hand {@link generateAutoZoom} a stream without also saying
 * whether that stream is a record of anything, and "no clicks" and "no tap" arrive as
 * different variants rather than as the same empty array.
 *
 * `@loom/format`'s `RecordingEvents.clicks.available` is the authority, and
 * {@link clickSourceFrom} is the one-line reading of it. `available` there is already
 * *"true only when the tap was live for the whole session"* — a tap that died mid-way
 * leaves a real but partial log, and no generator should treat partial as complete.
 */

import type { RecordingDoc } from '@loom/format';
import type { ClickEventStream } from '../streams.ts';

/** Why a machine has no clicks to zoom on. Each is a different sentence to a user. */
export type ClickUnavailable =
  /** The recording has no `events.clicks` block at all — pre-phase-5, or hand-built. */
  | 'not-recorded'
  /** `recording.json` says the tap was not live throughout. Accessibility, or a death. */
  | 'not-captured'
  /** The log is named and claimed available, but the caller could not open it. */
  | 'log-unreadable';

export type ClickSource =
  | { kind: 'captured'; stream: ClickEventStream }
  | { kind: 'unavailable'; reason: ClickUnavailable };

export function capturedClicks(stream: ClickEventStream): ClickSource {
  return { kind: 'captured', stream };
}

export function unavailableClicks(reason: ClickUnavailable): ClickSource {
  return { kind: 'unavailable', reason };
}

/**
 * Read `recording.json`'s answer, and refuse to improve on it.
 *
 * A `stream` of `null` with `available: true` is `log-unreadable` rather than
 * `not-captured`: the recording says the clicks are there, so the honest report is
 * that we could not read them, not that they never happened.
 */
export function clickSourceFrom(
  recording: RecordingDoc | null,
  stream: ClickEventStream | null,
): ClickSource {
  const clicks = recording?.events?.clicks;
  if (clicks === undefined) return unavailableClicks('not-recorded');
  if (!clicks.available) return unavailableClicks('not-captured');
  if (stream === null) return unavailableClicks('log-unreadable');
  return capturedClicks(stream);
}

/**
 * What the UI says when auto-zoom is unavailable.
 *
 * §6.5: *"If it was declined, cursor-follow and manual zoom still work — only this
 * generator is unavailable, and the UI says so plainly rather than producing
 * nothing."* Kept next to the state, like `describeClickCapability` in
 * `@loom/sampler`, so the editor and a log cannot say different things.
 */
export function describeClickUnavailable(reason: ClickUnavailable): string {
  switch (reason) {
    case 'not-recorded':
      return (
        'This recording has no click log, so auto-zoom-on-click has nothing to work ' +
        'from. Cursor-follow and manual zoom are unaffected.'
      );
    case 'not-captured':
      return (
        'Clicks were not captured for this recording — auto-zoom-on-click needs the ' +
        'macOS Accessibility permission, which is granted in System Settings and ' +
        'takes effect after a restart. Cursor-follow and manual zoom are unaffected.'
      );
    case 'log-unreadable':
      return (
        'This recording says clicks were captured, but the click log could not be ' +
        'read. Auto-zoom-on-click is unavailable until it can.'
      );
  }
}
