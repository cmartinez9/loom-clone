/**
 * The event-log seams `compile` reaches the recording through.
 *
 * §3.6's `CompileContext` names `cursor: CursorEventStream` — *"memory-mapped view
 * over `events/cursor.ndjson`"* — and `clicks: ClickEventStream | null`. This
 * package is pure (§1.3: *"`edl` and `compositor` being framework-free is what lets
 * a headless test render frame 1,234 … and compare it byte-for-byte against the
 * exporter's frame 1,234"*), so it declares the shape of those views and never
 * opens a file. Whoever has the bytes builds one; {@link arrayCursorStream} and
 * {@link arrayClickStream} are the obvious implementations over already-parsed
 * samples, and a memory-mapped one can satisfy the same interface later without
 * touching a line of the model.
 *
 * ## Why `cursor` may be null here and is not in §3.6
 *
 * Absence is a real, distinguishable state in this format, and phase 5 exists to
 * keep it that way: §7.3 and research trap 2 require "no cursor log" and "an empty
 * cursor log" to mean different things, and `recording.json` marks clicks
 * `available: false` rather than writing an empty file. A `CompileContext` that
 * could not say "there is no cursor data" would force a caller to fabricate an
 * empty stream, which is exactly the collapse those phases were built to prevent.
 *
 * The accessors are index-based rather than object-returning on purpose: `resolve`
 * calls them once per rendered frame and must allocate nothing (§3.6).
 */

import type { Seconds } from '@loom/format';

/** A sorted view over `events/cursor.ndjson`'s position samples. */
export interface CursorEventStream {
  readonly count: number;
  /** Index of the last sample at or before `t`, or `-1` when there is none. */
  indexAt(t: Seconds): number;
  tAt(index: number): Seconds;
  xAt(index: number): number;
  yAt(index: number): number;
  /** Cursor-image id, resolved by the caller through `cursors/index.json`. */
  imageIdAt(index: number): string;
}

/** A sorted view over `events/clicks.ndjson`. Phase 10's auto-zoom generator reads it. */
export interface ClickEventStream {
  readonly count: number;
  /** Index of the last event at or before `t`, or `-1`. */
  indexAt(t: Seconds): number;
  tAt(index: number): Seconds;
  xAt(index: number): number;
  yAt(index: number): number;
  /** `'down'` or `'up'`. */
  phaseAt(index: number): 'down' | 'up';
  buttonAt(index: number): number;
}

/** Binary search: index of the last `t` in `times` at or before `t`, or `-1`. */
function lastAtOrBefore(times: Float64Array, t: Seconds): number {
  let low = 0;
  let high = times.length - 1;
  if (high < 0 || t < (times[0] ?? 0)) return -1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((times[mid] ?? 0) <= t) low = mid;
    else high = mid - 1;
  }
  return low;
}

export interface CursorSampleInput {
  t: Seconds;
  x: number;
  y: number;
  /** `c` in the log (§2.5). */
  c: string;
}

/**
 * A cursor stream over parsed samples.
 *
 * The caller supplies them in the log's own order; §2.5's log is written by one
 * monotonic sampler, so this sorts defensively rather than trusting the file and
 * then relies on the order for its binary search.
 */
export function arrayCursorStream(samples: readonly CursorSampleInput[]): CursorEventStream {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const times = new Float64Array(sorted.length);
  const xs = new Float64Array(sorted.length);
  const ys = new Float64Array(sorted.length);
  const ids: string[] = new Array<string>(sorted.length);
  sorted.forEach((s, i) => {
    times[i] = s.t;
    xs[i] = s.x;
    ys[i] = s.y;
    ids[i] = s.c;
  });
  return {
    count: sorted.length,
    indexAt: (t) => lastAtOrBefore(times, t),
    tAt: (i) => times[i] ?? 0,
    xAt: (i) => xs[i] ?? 0,
    yAt: (i) => ys[i] ?? 0,
    imageIdAt: (i) => ids[i] ?? '',
  };
}

export interface ClickEventInput {
  t: Seconds;
  e: 'down' | 'up';
  b: number;
  x: number;
  y: number;
}

export function arrayClickStream(events: readonly ClickEventInput[]): ClickEventStream {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const times = new Float64Array(sorted.length);
  const xs = new Float64Array(sorted.length);
  const ys = new Float64Array(sorted.length);
  const buttons = new Int32Array(sorted.length);
  const phases: ('down' | 'up')[] = new Array<'down' | 'up'>(sorted.length);
  sorted.forEach((s, i) => {
    times[i] = s.t;
    xs[i] = s.x;
    ys[i] = s.y;
    buttons[i] = s.b;
    phases[i] = s.e;
  });
  return {
    count: sorted.length,
    indexAt: (t) => lastAtOrBefore(times, t),
    tAt: (i) => times[i] ?? 0,
    xAt: (i) => xs[i] ?? 0,
    yAt: (i) => ys[i] ?? 0,
    phaseAt: (i) => phases[i] ?? 'up',
    buttonAt: (i) => buttons[i] ?? 0,
  };
}
