/**
 * Track factories for the two targets phase 7 ships: manual zoom and the bubble.
 *
 * Decision 3 (`data/loom-clone-decisions.md`): *"**Manual keyframed zoom first**,
 * then automatic cursor-follow and auto-zoom-on-click layered onto the same
 * keyframe system"*. These build the *same* `Track` a generator will build in phase
 * 10 — §3.5's point is that there is no second kind — with the fields a hand-authored
 * track always has, so no caller has to remember that `domain` is explicit or that
 * a spring channel needs its parameters.
 *
 * They exist here rather than in the editor because the golden-frame test, the
 * exporter and the editor must all be able to build one, and §1.3 keeps `edl`
 * reachable from a headless test.
 */

import type { Keyframe, SpringParams, Track, Vec2 } from '@loom/format';

/** §6.3's defaults — Cap's `ScreenMovementSpring`, and the numbers §12.5 measured. */
export const DEFAULT_SPRING: SpringParams = { tension: 200, mass: 2.25, friction: 40 };

/** §2.6's manual zoom track uses 300 ms; the generated one 250 ms. */
export const DEFAULT_MANUAL_BLEND_MS = 300;

/**
 * "For the whole recording", written the way §2.6's reference document writes it.
 *
 * An `activeRanges` of `[[0, 1e9]]` rather than an open-ended encoding, because
 * `windowWeight` compares numbers and `1e9` seconds is thirty-one years.
 */
export const ALWAYS: [number, number][] = [[0, 1e9]];

export interface ManualZoomInput {
  id: string;
  /** Source-time ranges the track has an opinion over (§3.2 — effects are source-anchored). */
  activeRanges: [number, number][];
  amount: Keyframe[];
  center?: Keyframe[];
  /** Omit for curve keys; supply for `ease: {kind:'spring'}` keys. */
  spring?: SpringParams;
  /** §3.3's channel bound. Zoom below 1 would not fill the frame. */
  amountClamp?: [number, number];
  blendMs?: number;
}

/**
 * A hand-authored zoom track.
 *
 * `domain: 'source'` is not a default this function picked: §3.2 makes it the
 * meaning of a manual zoom. *"A zoom placed on 'the moment I clicked Deploy' stays
 * on that moment no matter how you trim around it."* It is written out here rather
 * than inferred anywhere.
 */
export function manualZoomTrack(input: ManualZoomInput): Track {
  const spring = input.spring;
  return {
    id: input.id,
    kind: 'transform',
    target: 'zoom',
    domain: 'source',
    origin: 'manual',
    blend: 'replace',
    blendMs: input.blendMs ?? DEFAULT_MANUAL_BLEND_MS,
    activeRanges: input.activeRanges,
    enabled: true,
    channels: {
      amount: {
        keys: input.amount,
        ...(spring === undefined ? {} : { spring }),
        ...(input.amountClamp === undefined ? {} : { clamp: input.amountClamp }),
      },
      ...(input.center === undefined
        ? {}
        : { center: { keys: input.center, ...(spring === undefined ? {} : { spring }) } }),
    },
  };
}

export interface BubbleInput {
  id: string;
  center: Vec2;
  sizeY: number;
  /** `1` square, `16/9` rectangle, the camera's own for "source". */
  aspect: number;
  /** `1` circle, `≈0.1` rounded square, `0` sharp. §3.3: the shape is geometry. */
  corner01: number;
  opacity?: number;
  mirror?: boolean;
  /** Only so the UI can show which chip is selected; the shape is the numbers. */
  shapePreset?: string;
  activeRanges?: [number, number][];
}

/**
 * A bubble track holding one still pose.
 *
 * Every property is a channel with a single `hold` key, which is what makes moving
 * or morphing the bubble later an ordinary `key.set` rather than a new feature —
 * §3.3: *"a square morphs into a circle by interpolating `corner01`"*.
 */
export function bubbleTrack(input: BubbleInput): Track {
  const hold = (v: number | Vec2): { keys: Keyframe[] } => ({
    keys: [{ t: 0, v, ease: { kind: 'hold' } }],
  });
  return {
    id: input.id,
    kind: 'transform',
    target: 'bubble',
    domain: 'source',
    origin: 'manual',
    blend: 'replace',
    blendMs: 0,
    activeRanges: input.activeRanges ?? ALWAYS,
    enabled: true,
    channels: {
      center: hold(input.center),
      sizeY: hold(input.sizeY),
      aspect: hold(input.aspect),
      corner01: hold(input.corner01),
      opacity: hold(input.opacity ?? 1),
      mirror: hold(input.mirror === true ? 1 : 0),
    },
    ...(input.shapePreset === undefined ? {} : { shapePreset: input.shapePreset }),
  };
}
