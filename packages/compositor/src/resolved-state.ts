/**
 * ## THROWAWAY. Phase 7 deletes this file.
 *
 * Architecture report §8, defending the build order: *"Phase 7 (the timeline model)
 * comes after phase 6 (decode + compositor) even though it is the more conceptual
 * piece. The reason: the compositor tells you what `ResolvedState` actually needs to
 * contain. Designing the model first and discovering in phase 8 that it cannot
 * express something the renderer requires is the expensive mistake. Build the
 * consumer, then the model, then delete the throwaway state struct."*
 *
 * This is that throwaway state struct. It is a **strict subset** of the
 * `ResolvedState` declared in §3.6 — the fields a screen-only preview consumes and
 * nothing else. When `packages/edl` lands with `compile()` and `resolve()`, this
 * file goes and the compositor imports the real type; because the shape here is a
 * subset, that swap is a deletion rather than a migration.
 *
 * Deliberately absent, and the phase that adds each: `bubble` (4), `cursor` (5),
 * `annotations` (11), `audio` (8). They are §3.6's, not new inventions — this file
 * adds no field the report does not already declare.
 *
 * ### What phase 6 learned, for phase 7 to honour
 *
 * `zoom.center` is in **normalized source coordinates** and `zoom.amount` is a
 * linear magnification ≥ 1. The compositor derives the sampled source rect from
 * those two numbers and nothing else, and clamps it inside the source — see
 * `sourceSampleRect`. Preview and export must agree bit for bit on that rect
 * (§4.5), which is only true while the derivation lives in one function fed by one
 * state struct.
 */

import type { Seconds } from '@loom/format';

/** Magnification and its centre. Identical in preview and export (§4.5). */
export interface ResolvedZoom {
  /** Linear magnification. `1` is the whole frame; `2` shows a quarter of its area. */
  amount: number;
  /** Centre of the visible region in normalized source coordinates, `[0..1]`. */
  center: [number, number];
}

/** The subset of §3.6's `ResolvedState` a screen-only preview needs. */
export interface ResolvedState {
  timelineTime: Seconds;
  sourceTime: Seconds;
  clipIndex: number;
  zoom: ResolvedZoom;
}

/** A state that shows the whole frame — the identity of the compositor's transform. */
export function identityState(timelineTime: Seconds = 0): ResolvedState {
  return {
    timelineTime,
    sourceTime: timelineTime,
    clipIndex: 0,
    zoom: { amount: 1, center: [0.5, 0.5] },
  };
}
