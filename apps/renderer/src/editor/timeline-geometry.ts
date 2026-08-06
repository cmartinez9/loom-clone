/**
 * Seconds to pixels and back, and where the ruler's ticks go.
 *
 * Pure and separate from the DOM for the ordinary reason — this is the arithmetic
 * that is wrong in a way you cannot see — but also because it is the one place the
 * editor's central layout decision is written down.
 *
 * ## The timeline is drawn in SOURCE time
 *
 * Its full width is the recording as captured, `0 … sourceDurationSec`. The trimmed
 * region is marked inside that, and the head and tail a trim removed stay on screen,
 * dimmed, with handles on them. Three things follow, and each is why:
 *
 *  - **Trimming does not move anything else on the timeline.** §3.2 anchors effect
 *    tracks in source time *"so that trimming does not re-time your zooms"*, and a
 *    ruler in timeline time would draw those tracks sliding under a trim they are
 *    explicitly independent of. A zoom keyframe stays over the frame it was placed
 *    on, which is what makes placing one by hand — `loom-p15`'s job — mean anything.
 *  - **You can see and undo what you cut.** A timeline-time ruler makes trimmed
 *    material vanish; the handles then have nothing to be dragged back out of.
 *  - **The cursor and click logs line up with the picture.** They are source-time
 *    streams (§2.5) and so is everything they annotate.
 *
 * The playhead is the one thing that has to cross: it is a *timeline* position, so
 * it is drawn at `resolve(...).sourceTime` and a drag on the ruler is converted the
 * other way with `timelineTimeAt`. `packages/edl/src/clips.ts` owns both directions;
 * nothing here re-derives them.
 */

import type { Seconds } from '@loom/format';

/** What is visible, and how wide it is on screen. */
export interface TimelineView {
  /** The whole recording, in source seconds. The ruler's extent at zoom 1. */
  durationSec: Seconds;
  /** ≥ 1. The visible span is `durationSec / zoom`. */
  zoom: number;
  /** Source time at the left edge. */
  scrollSec: Seconds;
  /** Width of the lane area in CSS pixels. */
  widthPx: number;
}

/** The largest zoom the ruler offers: about a frame of a 30 fps recording per 12 px. */
export const MAX_ZOOM_SPAN_SEC = 0.5;

/**
 * Blank pixels reserved at each end of the lane area.
 *
 * Not decoration. The lane area is `overflow: hidden` — it has to be, or a scrolled
 * clip would draw over the track headings — so anything centred on `x = 0` or
 * `x = widthPx` has half of itself clipped away, including its hit target. The two
 * things that live at exactly those coordinates are the trim handles, at the first
 * and last instants of the recording, which is where a person reaching for "trim
 * the very end" puts the pointer. Without this inset that grab lands on nothing.
 *
 * Wide enough for a handle's 11 px target and the playhead's 12 px flag to sit
 * inside the area they belong to, and narrow enough that the ruler still reads as
 * spanning the recording.
 */
export const EDGE_PX = 8;

/**
 * Pixels the ruler actually maps time onto — the width less both insets.
 *
 * Exported because a wheel scroll converts pixels to seconds too, and every such
 * conversion in this window has to divide by the same number: dividing by the raw
 * `widthPx` instead makes the content under the pointer run about 1.6% ahead of it
 * at a thousand-pixel lane area.
 */
export function trackPx(view: TimelineView): number {
  return Math.max(1, view.widthPx - 2 * EDGE_PX);
}

export function visibleSpanSec(view: TimelineView): Seconds {
  const duration = Math.max(view.durationSec, MAX_ZOOM_SPAN_SEC);
  return duration / Math.max(1, view.zoom);
}

/**
 * `scrollSec` clamped so the view never shows time the recording does not have.
 *
 * Applied on read rather than on write so that a zoom-out, which widens the visible
 * span, cannot leave a stored scroll that is only legal at the old zoom.
 */
export function scrollSecOf(view: TimelineView): Seconds {
  const span = visibleSpanSec(view);
  return Math.min(Math.max(0, view.scrollSec), Math.max(0, view.durationSec - span));
}

/** Source seconds → pixels from the left edge of the lane area. */
export function xOf(view: TimelineView, t: Seconds): number {
  const span = visibleSpanSec(view);
  return EDGE_PX + ((t - scrollSecOf(view)) / span) * trackPx(view);
}

/** Pixels from the left edge of the lane area → source seconds, clamped to the recording. */
export function timeOf(view: TimelineView, x: number): Seconds {
  const span = visibleSpanSec(view);
  const t = scrollSecOf(view) + ((x - EDGE_PX) / trackPx(view)) * span;
  return Math.min(Math.max(0, t), Math.max(0, view.durationSec));
}

/**
 * Zoom about a fixed source instant — the one under the pointer, or the playhead.
 *
 * Anchoring is what makes zoom usable rather than disorienting: the frame you were
 * looking at is still under the same pixel afterwards. Without it, every zoom step
 * is followed by hunting for where you were.
 */
export function zoomAbout(view: TimelineView, zoom: number, anchorSec: Seconds): TimelineView {
  const anchorX = xOf(view, anchorSec);
  const next: TimelineView = { ...view, zoom: clampZoom(view, zoom) };
  const span = visibleSpanSec(next);
  const scrollSec = anchorSec - ((anchorX - EDGE_PX) / trackPx(view)) * span;
  return { ...next, scrollSec: Math.max(0, scrollSec) };
}

/**
 * Zoom held between 1 (the whole recording) and a span of {@link MAX_ZOOM_SPAN_SEC}.
 *
 * The upper bound is in *seconds of span* rather than in multiples, because a
 * multiple means something different on a ten-second recording than on an hour-long
 * one — and an unbounded zoom divides by a span approaching zero.
 */
export function clampZoom(view: TimelineView, zoom: number): number {
  const duration = Math.max(view.durationSec, MAX_ZOOM_SPAN_SEC);
  return Math.min(Math.max(1, zoom), duration / MAX_ZOOM_SPAN_SEC);
}

/**
 * Tick spacings, in seconds, from a frame-ish interval up to half an hour.
 *
 * A ladder rather than a computed decade because the readable steps for *time* are
 * not powers of ten: 15 s and 30 s belong, 100 s does not, and a ruler that offers
 * 10 s then 100 s is unusable across the middle of that range.
 *
 * The sub-second rungs are 0.1 and 0.5 and deliberately not 0.25: a label is a
 * timecode with one decimal place, so a 0.25 s step prints 0.75 s as `0:00.8` and a
 * ruler whose labels are not the times its ticks are on is worse than a coarser one.
 */
const TICK_LADDER: readonly number[] = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

/** Least pixels between two labelled ticks; below this the labels collide. */
const MIN_LABEL_PX = 76;

export interface Tick {
  t: Seconds;
  x: number;
  /** Labelled ticks are the ones with room for a timecode beside them. */
  major: boolean;
}

/**
 * The ruler's ticks for the visible span.
 *
 * Minor ticks are the ladder step; major (labelled) ticks are the first multiple of
 * it that clears {@link MIN_LABEL_PX}, so labels never overlap however far in the
 * ruler is zoomed. Both are computed from the *measured* width — nothing here
 * assumes a window size.
 */
export function ticks(view: TimelineView): Tick[] {
  const span = visibleSpanSec(view);
  if (!(span > 0) || !(view.widthPx > 2 * EDGE_PX)) return [];
  const pxPerSec = trackPx(view) / span;

  const step = TICK_LADDER.find((s) => s * pxPerSec >= MIN_LABEL_PX / 4) ?? TICK_LADDER.at(-1) ?? 1;
  const labelEvery = Math.max(1, Math.ceil(MIN_LABEL_PX / (step * pxPerSec)));

  const from = scrollSecOf(view);
  const to = Math.min(from + span, view.durationSec);
  const out: Tick[] = [];
  // Counted in ladder steps rather than accumulated in seconds: adding 0.1 four
  // hundred times lands at 40.00000000000031, and a ruler whose ticks drift off
  // their own labels is the sort of thing nobody can quite point at.
  const firstStep = Math.ceil(from / step - 1e-9);
  for (let n = firstStep; n * step <= to + 1e-9; n++) {
    const t = n * step;
    out.push({ t, x: xOf(view, t), major: n % labelEvery === 0 });
  }
  return out;
}
