/**
 * `ResolvedState` — everything the compositor needs about one instant.
 *
 * Architecture report §3.6 declares this type; the fields and their order are
 * taken from it. It replaces the throwaway struct phase 6 shipped in
 * `packages/compositor/src/resolved-state.ts`, which was always meant to be
 * deleted here — §8: *"the compositor tells you what `ResolvedState` actually
 * needs to contain … Build the consumer, then the model, then delete the throwaway
 * state struct."*
 *
 * ## What phase 6 learned, and this type keeps
 *
 * `zoom.center` is in **normalized source coordinates** and `zoom.amount` is a
 * linear magnification ≥ 1. The compositor derives the sampled source rect from
 * those two numbers and nothing else (`sourceSampleRect`), and preview and export
 * must agree on that rect bit for bit (§4.5) — which is only true while the
 * derivation lives in one function fed by one state struct.
 *
 * ## Ownership: the returned state is borrowed, not yours
 *
 * §3.6 requires `resolve` to allocate nothing, so a `CompiledTimeline` owns exactly
 * one `ResolvedState` and hands the same object back on every call, overwritten in
 * place. Read it within the turn — the preview loop draws from it and drops it,
 * which is the same discipline the ring's `VideoFrame` gets. To keep one, call
 * {@link cloneResolvedState}.
 */

import type { Seconds } from '@loom/format';

/** Magnification and its centre. Identical in preview and export (§4.5). */
export interface ResolvedZoom {
  /** Linear magnification. `1` is the whole frame; `2` shows a quarter of its area. */
  amount: number;
  /** Centre of the visible region in normalized source coordinates, `[0..1]`. */
  center: [number, number];
}

/**
 * The webcam bubble. §3.3: *"The bubble shape falls out of geometry, not an enum"* —
 * `aspect` and `corner01` are numbers so that a square can *morph* into a circle.
 */
export interface ResolvedBubble {
  /**
   * False when no enabled bubble track covers this instant, or when the resolved
   * opacity is zero. A recording with no webcam simply has no bubble track.
   */
  visible: boolean;
  center: [number, number];
  /** Height as a fraction of the output height. */
  sizeY: number;
  /** Width / height. `1` is square; `cameraAspect` is "source". */
  aspect: number;
  /** Corner radius as a fraction of the half-minor-axis. `1` is a circle. */
  corner01: number;
  opacity: number;
  mirror: boolean;
}

/** Where the pointer was, and which bitmap to draw. `null` when nothing is known. */
export interface ResolvedCursor {
  /** Normalized against the logical display, matching `events/cursor.ndjson` (§2.5). */
  pos: [number, number];
  /** Resolved through `cursors/index.json`. */
  imageId: string;
  scale: number;
  opacity: number;
}

/**
 * One annotation span that covers this instant, with its own channels resolved.
 *
 * §3.3: *"because a span carries its own channels, an animated arrow is free rather
 * than a special case"*. The channel names are the span's own — `from`, `to`,
 * `center`, `size`, `opacity` — so the values arrive as a map rather than as fixed
 * fields; phase 11 owns what each `type` means by them. Every `Float64Array` here
 * is allocated once at compile time and rewritten in place, so reading one costs
 * nothing and keeping one past the turn reads the wrong frame.
 */
export interface ResolvedAnnotation {
  id: string;
  type: string;
  style: Record<string, unknown> | null;
  /** Channel name → its components. Borrowed; see the module comment. */
  values: ReadonlyMap<string, Float64Array>;
  /** The owning track's `activeRanges` window at this instant, `0..1`. */
  weight: number;
}

/** Linear gains, not decibels — §2.6 stores `gainDb`; the compositor multiplies. */
export interface ResolvedAudio {
  micGain: number;
  systemGain: number;
}

/** §3.6, in full. */
export interface ResolvedState {
  timelineTime: Seconds;
  sourceTime: Seconds;
  clipIndex: number;
  zoom: ResolvedZoom;
  bubble: ResolvedBubble;
  cursor: ResolvedCursor | null;
  annotations: ResolvedAnnotation[];
  audio: ResolvedAudio;
}

/**
 * The identity: whole frame, no bubble, no cursor, no annotations, unity gain.
 *
 * This is what a resolve produces when no track has an opinion, and it is the
 * starting value the track stack in §3.5 blends onto.
 */
export function identityState(timelineTime: Seconds = 0): ResolvedState {
  return {
    timelineTime,
    sourceTime: timelineTime,
    clipIndex: 0,
    zoom: { amount: IDENTITY_ZOOM_AMOUNT, center: [IDENTITY_ZOOM_CX, IDENTITY_ZOOM_CY] },
    bubble: {
      visible: false,
      center: [IDENTITY_BUBBLE_CX, IDENTITY_BUBBLE_CY],
      sizeY: IDENTITY_BUBBLE_SIZE_Y,
      aspect: IDENTITY_BUBBLE_ASPECT,
      corner01: IDENTITY_BUBBLE_CORNER01,
      opacity: IDENTITY_BUBBLE_OPACITY,
      mirror: false,
    },
    cursor: null,
    annotations: [],
    audio: { micGain: 1, systemGain: 1 },
  };
}

/** A detached copy, for the one caller in ten that needs to keep a state. */
export function cloneResolvedState(state: ResolvedState): ResolvedState {
  return {
    timelineTime: state.timelineTime,
    sourceTime: state.sourceTime,
    clipIndex: state.clipIndex,
    zoom: { amount: state.zoom.amount, center: [state.zoom.center[0], state.zoom.center[1]] },
    bubble: {
      visible: state.bubble.visible,
      center: [state.bubble.center[0], state.bubble.center[1]],
      sizeY: state.bubble.sizeY,
      aspect: state.bubble.aspect,
      corner01: state.bubble.corner01,
      opacity: state.bubble.opacity,
      mirror: state.bubble.mirror,
    },
    cursor:
      state.cursor === null
        ? null
        : {
            pos: [state.cursor.pos[0], state.cursor.pos[1]],
            imageId: state.cursor.imageId,
            scale: state.cursor.scale,
            opacity: state.cursor.opacity,
          },
    annotations: state.annotations.map((a) => ({
      id: a.id,
      type: a.type,
      style: a.style,
      values: new Map([...a.values].map(([name, v]) => [name, Float64Array.from(v)])),
      weight: a.weight,
    })),
    audio: { micGain: state.audio.micGain, systemGain: state.audio.systemGain },
  };
}

// The identity values, named so the fold in `resolve` and the struct above cannot
// drift apart. A track with no channel for a property leaves the value it found.
export const IDENTITY_ZOOM_AMOUNT = 1;
export const IDENTITY_ZOOM_CX = 0.5;
export const IDENTITY_ZOOM_CY = 0.5;
export const IDENTITY_BUBBLE_CX = 0.5;
export const IDENTITY_BUBBLE_CY = 0.5;
export const IDENTITY_BUBBLE_SIZE_Y = 0.25;
export const IDENTITY_BUBBLE_ASPECT = 1;
export const IDENTITY_BUBBLE_CORNER01 = 1;
/**
 * One, not zero.
 *
 * `visible` already answers "is there a bubble here" from whether any bubble track
 * covers the instant; an identity of zero would additionally make a bubble track
 * that carries no `opacity` channel invisible, which is not what "no opinion about
 * opacity" means.
 */
export const IDENTITY_BUBBLE_OPACITY = 1;
export const IDENTITY_CURSOR_SCALE = 1;
export const IDENTITY_CURSOR_OPACITY = 1;
export const IDENTITY_GAIN_DB = 0;
