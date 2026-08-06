/**
 * The cursor-follow generator — §6.1 conditioning, §6.2 dead zone, §6.3 spring,
 * §6.4 phase lead, checked against §6.6 before it is returned.
 *
 * The output is an ordinary `Track` (§3.5: *"The output is an ordinary `Track`. It
 * appears in the timeline as normal keyframes, is draggable, and stacks under the
 * user's manual track"*), and every part of the motion that is *not* in the keyframes
 * is in the model: the keys are the **step targets** and §6.3's spring is integrated
 * over them on the fixed 8 ms grid at compile time by `precomputeSpring`. Nothing
 * here integrates anything. That is §3.4's rule, and it is worth 82.6 px at 3456 wide.
 *
 * ## What this track says, and what it deliberately does not
 *
 * A `center` channel and nothing else. §3.5's stack is read **per channel** — *"a
 * zoom track carrying only `amount` leaves the centre the track below it set"* — and
 * the mirror of that is what makes cursor-follow composable: it has an opinion about
 * where the camera looks and none about how far in it is, so a manual zoom, an
 * auto-zoom segment or a plain "1.4× for the whole video" above it all keep their
 * `amount` while the follow keeps driving the centre wherever they have not overridden
 * it.
 *
 * `zoomAmount` is therefore a *framing assumption*, not an output: §6.2's rest box and
 * the frame-safe clamp are both fractions of the visible zoomed viewport, so the
 * generator has to know what magnification it is following at. Pass
 * {@link CursorFollowInput.geometry} to follow under a zoom that changes.
 *
 * ## Why `blendMs` defaults to 0 on this track and 250 on auto-zoom's
 *
 * §3.5's crossfade exists so a *handover* does not pop, and a handover has two sides.
 * The manual and auto-zoom tracks that sit above this one fade in over their own
 * `blendMs`; this one is the bottom of the stack and spans the whole recording, so its
 * only edges are the first and last instants of the video. A crossfade there is not a
 * handover — it is the camera sliding in from the centre of the frame over the first
 * quarter-second, which is both a pan nobody asked for and, at 0.25 UV over 250 ms,
 * a **1.0 UV/s** one against §6.6's 0.35 budget. The camera should simply open
 * already looking at the cursor, which is what `followTarget` starting on the first
 * sample and a hard leading edge give it. It is a parameter, not a constant: a caller
 * that parks this track over part of a recording wants the crossfade at those edges.
 */

import type { IsoTimestamp, Keyframe, Seconds, SpringParams, Track, Vec2 } from '@loom/format';
import { DEFAULT_SPRING } from '../tracks.ts';
import type { CursorEventStream } from '../streams.ts';
import {
  conditionCursor,
  DEFAULT_CONDITIONING,
  type ConditionedCursor,
  type ConditioningParams,
} from './conditioning.ts';
import {
  constantFollowGeometry,
  DEFAULT_REST_BOX,
  followTarget,
  type FollowGeometry,
} from './dead-zone.ts';
import {
  describeSeasickness,
  measureTrack,
  SEASICKNESS_BUDGET,
  seasicknessPenalty,
  type SeasicknessLimits,
  type SeasicknessReport,
} from './budget.ts';

/** The magnification the follow is framed for when the caller does not say. */
export const DEFAULT_FOLLOW_AMOUNT = 2;

/**
 * §6.6's remedy ladder — **three attempts, and what each one softens.**
 *
 * §6.6 says: *"If any fails, widen the rest box by 20% and regenerate, up to three
 * attempts, then return the best attempt with a warning in the UI."* Three attempts in
 * total, the first at §6.2's and §6.3's own numbers — so a recording that meets the
 * budget is generated with exactly the parameters the report specifies and nothing
 * here ever runs.
 *
 * ## Why the later rungs change more than the rest box
 *
 * **Measured, on the ten real recordings in `packages/edl/test/corpus/`.** Widening the
 * rest box alone moves the two failing metrics by under 5%, and 8 of the 10 fail:
 *
 * ```
 * rest box only (§6.6 as written)  2/10 pass   worst speed 1.18 UV/s, accel 7.03 UV/s²
 * + spring softened to 0.7×ω₀      3/10 pass   worst speed 0.97,      accel 4.74
 * + target speed capped at 0.3     5/10 pass   worst speed 0.33,      accel 1.99
 * both, at the third rung below   10/10 pass   worst speed 0.26,      accel 0.95
 * ```
 *
 * The reason is structural rather than a matter of degree. §6.2's target sits at a
 * fixed offset from the cursor once the cursor is outside the box, so **the target's
 * velocity is the cursor's velocity**, and a wider box changes when that starts, not
 * how fast it is. §6.3's spring then passes that velocity through nearly intact: its
 * velocity time constant is `1/(ζω₀) = 0.11 s`, while §6.6's own budget implies about
 * `0.35 / 1.2 = 0.29 s` of ramp — the two numbers are three times apart, so a camera
 * that reaches the speed limit necessarily breaks the acceleration limit. Softening the
 * spring closes that ratio; capping the target's speed keeps the camera under the
 * speed limit on a fast flick. Neither alone reaches 10/10; together they do, with
 * margin.
 *
 * ## What this is a divergence from, and what it is not
 *
 * §6.3 calls its parameters *"**Default** parameters … Cap's `ScreenMovementSpring`"*,
 * and Cap drives that spring between discrete zoom *segments*, where 0.45 s of settling
 * after a step is exactly right. Cursor-follow is continuous tracking of a moving
 * target, where what matters is velocity bandwidth rather than step settling — a
 * different job for the same spring. `maxTargetSpeedUvPerSec` has no §6 counterpart at
 * all; `dead-zone.ts` says so at the field.
 *
 * So: the report's numbers are the default and are what a passing recording gets, the
 * measured budget is the arbiter, and the ladder is the documented remedy — which is
 * §6.6's own structure, with more than one knob on the later rungs. This was raised
 * rather than taken: see `AGENTS.md` § Phase 10.
 *
 * `springScale` scales ω₀ and leaves ζ alone (`k ← k·s²`, `c ← c·s`, `m` unchanged), so
 * every rung keeps §6.3's *character* — 0.943, visually critically damped — and only
 * its speed changes. §6.4's phase lead is `friction / tension`, so it lengthens with the
 * spring automatically and stays the exact cancellation §6.4 measured.
 */
export interface ComfortRung {
  /** Multiplier on §6.2's `restBox`. §6.6's own knob: 1.2× per rung. */
  restBoxScale: number;
  /** Multiplier on §6.3's ω₀. `1` is §6.3 exactly. */
  springScale: number;
  /** {@link DeadZoneOptions.maxTargetSpeedUvPerSec}. `null` is §6.2 exactly. */
  maxTargetSpeedUvPerSec: number | null;
}

export const COMFORT_LADDER: readonly ComfortRung[] = [
  { restBoxScale: 1, springScale: 1, maxTargetSpeedUvPerSec: null },
  { restBoxScale: 1.2, springScale: 0.7, maxTargetSpeedUvPerSec: 0.3 },
  { restBoxScale: 1.44, springScale: 0.55, maxTargetSpeedUvPerSec: 0.25 },
];

/** §6.6 counts attempts, not retries. The ladder has one rung per attempt. */
export const BUDGET_ATTEMPTS = COMFORT_LADDER.length;
export const REST_BOX_WIDEN = 1.2;

/** Scale a spring's ω₀ by `s`, keeping ζ. `k ← k·s²`, `c ← c·s`, `m` unchanged. */
export function scaleSpring(spring: SpringParams, s: number): SpringParams {
  if (!(s > 0) || s === 1) return { ...spring };
  return { tension: spring.tension * s * s, mass: spring.mass, friction: spring.friction * s };
}

/**
 * How far apart two step targets must be before the second gets its own keyframe.
 *
 * Not a smoothing knob — the spring does the smoothing — but a bound on two costs
 * that pull opposite ways. Too large and the target moves in visible jumps: a step of
 * `q` UV kicks the spring with `ω₀²q` of acceleration, which at §6.3's parameters is
 * `88.9 q` UV/s² against §6.6's budget of 1.2, so `q` above ~0.013 UV blows the
 * acceleration assertion on its own. Too small and a long recording carries a
 * keyframe per conditioned sample, at 60 Hz, into `edit.json`. 0.001 UV is 3.5 px at
 * 3456 wide and 0.089 UV/s² of kick — 7% of the acceleration budget — which leaves
 * the assertion measuring the camera rather than the quantiser.
 */
export const DEFAULT_KEY_EPSILON_UV = 0.001;

export interface CursorFollowParams {
  /** §6.2, as a fraction of the visible zoomed viewport. */
  restBox: [number, number];
  /** The magnification this follow is framed for. See the module header. */
  zoomAmount: number;
  /** §6.3's spring — Cap's `ScreenMovementSpring`. */
  spring: SpringParams;
  /**
   * §6.4's phase lead, seconds. `null` means `friction / tension`, which is the
   * spring's own steady-state trail and therefore the value that cancels it exactly:
   * §6.4 predicted 0.200 s, measured 0.196 s, and −0.0040 s with the compensation on.
   *
   * Left `null`, it tracks the spring the comfort ladder chose, which is the whole
   * point of it being a property of the spring rather than a constant.
   */
  leadSec: Seconds | null;
  keyEpsilonUv: number;
  blendMs: number;
  conditioning: ConditioningParams;
  /**
   * Overrides the ladder's cap on every rung. `null` lets the ladder decide, which is
   * what a caller wants unless it is pinning one configuration for a test.
   */
  maxTargetSpeedUvPerSec: number | null;
}

export const DEFAULT_CURSOR_FOLLOW_PARAMS: CursorFollowParams = {
  restBox: [DEFAULT_REST_BOX[0], DEFAULT_REST_BOX[1]],
  zoomAmount: DEFAULT_FOLLOW_AMOUNT,
  spring: DEFAULT_SPRING,
  leadSec: null,
  keyEpsilonUv: DEFAULT_KEY_EPSILON_UV,
  blendMs: 0,
  conditioning: DEFAULT_CONDITIONING,
  maxTargetSpeedUvPerSec: null,
};

export interface CursorFollowInput {
  cursor: CursorEventStream | null;
  /** Overrides on top of {@link DEFAULT_CURSOR_FOLLOW_PARAMS}. */
  params?: Partial<CursorFollowParams>;
  /** A zoom that changes over source time. Defaults to a constant `params.zoomAmount`. */
  geometry?: FollowGeometry;
  trackId?: string;
  /** `GeneratorSpec.inputs` — `{ cursor: 'sha256:…' }`. The caller has the bytes. */
  inputs?: Record<string, string>;
  /** `GeneratorSpec.generatedAt`. Supplied so a test can be deterministic. */
  generatedAt?: IsoTimestamp;
  /** How long the recording is, when it outlasts the cursor log. */
  durationSec?: Seconds;
  limits?: SeasicknessLimits;
  /** §6.6's remedy, overridable so a test can pin one rung. Defaults to the ladder. */
  ladder?: readonly ComfortRung[];
}

export interface CursorFollowAttempt {
  rung: ComfortRung;
  restBox: [number, number];
  spring: SpringParams;
  leadSec: Seconds;
  budget: SeasicknessReport;
  keyCount: number;
}

export interface CursorFollowResult {
  track: Track;
  /** The §6.6 report for `track`. */
  budget: SeasicknessReport;
  /** Every attempt the retry loop made, in order. The first is the nominal box. */
  attempts: CursorFollowAttempt[];
  /**
   * §6.6's *"return the best attempt with a warning in the UI"*.
   *
   * `null` when the budget was met. A sentence, not a code, because it is shown to a
   * person and because the numbers that failed belong in it.
   */
  warning: string | null;
  /** What §6.1 did to the log. Reported; nothing asserts on it. */
  cursor: ConditionedCursor;
  /** Source-time extent of the generated track. */
  spanSec: [Seconds, Seconds];
  keyCount: number;
}

/**
 * §6.4's phase lead: **read the future, do not predict it**.
 *
 * > We have an advantage Cap's live path does not: we generate offline, so "the
 * > future" is just `cursor[t + 0.2s]`. No prediction, no extrapolation, no filter
 * > delay. Read it.
 *
 * Which is a *shift*: the target that the spring should be chasing at time `t` is the
 * one the dead zone produces at `t + lead`, so every key moves `lead` earlier. Keys
 * that land before zero are folded into one at zero holding the latest of them — the
 * camera is already where the first fifth of a second is going, which is the whole
 * point.
 */
export function leadSecondsFor(spring: SpringParams, explicit: Seconds | null): Seconds {
  if (explicit !== null) return Math.max(0, explicit);
  const { friction, tension } = spring;
  if (!(tension > 0) || !Number.isFinite(friction)) return 0;
  return Math.max(0, friction / tension);
}

/**
 * Generate a cursor-follow track, and check it against §6.6 before returning it.
 *
 * The §6.6 loop is here rather than in the caller because §6.6 puts it here: *"three
 * assertions the generator runs on its own output before returning it"*. A caller
 * that wants the unchecked track for a diagnosis reads `attempts[0]`.
 */
export function generateCursorFollow(input: CursorFollowInput): CursorFollowResult {
  const params: CursorFollowParams = { ...DEFAULT_CURSOR_FOLLOW_PARAMS, ...input.params };
  const trackId = input.trackId ?? 't-zoom-cursor-follow';
  const cursor = conditionCursor(input.cursor, params.conditioning);

  const firstT = cursor.count > 0 ? (cursor.t[0] ?? 0) : 0;
  const lastT = cursor.count > 0 ? (cursor.t[cursor.count - 1] ?? 0) : 0;
  const end = Math.max(0, input.durationSec ?? lastT);
  const geometry = input.geometry ?? constantFollowGeometry(params.zoomAmount);
  const ladder = input.ladder ?? COMFORT_LADDER;
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const attempts: CursorFollowAttempt[] = [];
  let best: { track: Track; attempt: CursorFollowAttempt } | null = null;

  for (const rung of ladder) {
    const restBox: [number, number] = [
      params.restBox[0] * rung.restBoxScale,
      params.restBox[1] * rung.restBoxScale,
    ];
    const spring = scaleSpring(params.spring, rung.springScale);
    const lead = leadSecondsFor(spring, params.leadSec);
    const start = Math.max(0, firstT - lead);
    const cap = params.maxTargetSpeedUvPerSec ?? rung.maxTargetSpeedUvPerSec;
    const keys = followKeys(
      cursor,
      { restBox, geometry, maxTargetSpeedUvPerSec: cap },
      lead,
      params.keyEpsilonUv,
    );
    const track = buildTrack({
      trackId,
      keys,
      params: { ...params, restBox, spring, maxTargetSpeedUvPerSec: cap },
      lead,
      activeRange: [start, Math.max(start, end)],
      inputs: input.inputs ?? {},
      generatedAt,
    });
    const budget = measureTrack(
      track,
      Math.max(start, end),
      cursor,
      params.zoomAmount,
      input.limits ?? SEASICKNESS_BUDGET,
    );
    const attempt: CursorFollowAttempt = {
      rung,
      restBox,
      spring,
      leadSec: lead,
      budget,
      keyCount: keys.length,
    };
    attempts.push(attempt);
    if (
      best === null ||
      seasicknessPenalty(budget, input.limits) <
        seasicknessPenalty(best.attempt.budget, input.limits)
    ) {
      best = { track, attempt };
    }
    if (budget.pass) break;
  }

  if (best === null) {
    // An empty ladder. Not reachable through `COMFORT_LADDER`, and refused rather than
    // answered with a track nothing checked.
    throw new Error('the cursor-follow comfort ladder is empty; §6.6 needs at least one attempt');
  }
  const chosen = best;
  const range = chosen.track.activeRanges[0] ?? [0, end];
  return {
    track: chosen.track,
    budget: chosen.attempt.budget,
    attempts,
    warning: chosen.attempt.budget.pass
      ? null
      : `Cursor-follow could not meet the comfort budget after ${attempts.length} attempts ` +
        `(rest box widened to ${chosen.attempt.restBox[0].toFixed(3)} × ` +
        `${chosen.attempt.restBox[1].toFixed(3)} of the viewport, spring at ` +
        `${chosen.attempt.rung.springScale}× its stiffness): ` +
        describeSeasickness(chosen.attempt.budget),
    cursor,
    spanSec: [range[0], range[1]],
    keyCount: chosen.attempt.keyCount,
  };
}

/**
 * The dead-zone target, phase-led and thinned, as keyframes.
 *
 * Thinning is on the *stored* value rather than on time: a target that has not moved
 * needs no key, because a spring's step target is a zero-order hold and holding is
 * exactly what an absent key means.
 */
function followKeys(
  cursor: ConditionedCursor,
  options: {
    restBox: [number, number];
    geometry: FollowGeometry;
    maxTargetSpeedUvPerSec: number | null;
  },
  leadSec: Seconds,
  epsilonUv: number,
): Keyframe<Vec2>[] {
  const target = followTarget(cursor, options);
  const keys: Keyframe<Vec2>[] = [];
  if (target.count === 0) return keys;

  let lastX = Number.NaN;
  let lastY = Number.NaN;
  for (let i = 0; i < target.count; i++) {
    const x = target.x[i] ?? 0.5;
    const y = target.y[i] ?? 0.5;
    const hasKey = keys.length > 0;
    const moved = !hasKey || Math.hypot(x - lastX, y - lastY) >= epsilonUv;
    // The final sample always gets a key: it is where the camera comes to rest, and
    // the ≥ ε test would otherwise leave it up to ε short of it forever.
    if (!moved && i !== target.count - 1) continue;

    const t = Math.max(0, (target.t[i] ?? 0) - leadSec);
    const previous = keys[keys.length - 1];
    if (previous !== undefined && !(t > previous.t)) {
      // Keys folded onto zero by the lead: the latest one wins, because it is the
      // one the camera should already be heading for at the first frame. `t` must
      // stay strictly increasing — `validateChannel` refuses a repeat, and
      // `precomputeSpring` would apply both at the same grid point anyway.
      previous.v = [x, y];
    } else {
      keys.push({ t, v: [x, y], ease: { kind: 'spring' } });
    }
    lastX = x;
    lastY = y;
  }
  return keys;
}

function buildTrack(init: {
  trackId: string;
  keys: Keyframe<Vec2>[];
  params: CursorFollowParams;
  lead: Seconds;
  activeRange: [Seconds, Seconds];
  inputs: Record<string, string>;
  generatedAt: IsoTimestamp;
}): Track {
  const { params } = init;
  return {
    id: init.trackId,
    kind: 'transform',
    target: 'zoom',
    // §3.2, written out rather than defaulted: a zoom that follows the cursor is
    // anchored to the content, so trimming must not re-time it.
    domain: 'source',
    origin: 'generated',
    generator: {
      type: 'cursor-follow',
      params: {
        restBox: [params.restBox[0], params.restBox[1]],
        zoomAmount: params.zoomAmount,
        tension: params.spring.tension,
        mass: params.spring.mass,
        friction: params.spring.friction,
        leadSec: init.lead,
        keyEpsilonUv: params.keyEpsilonUv,
        // `-1` rather than `null`: `GeneratorSpec.params` is
        // `Record<string, number | number[]>`, and the fingerprint has to be able to
        // say "no cap" without carrying a type the schema does not have.
        maxTargetSpeedUvPerSec: params.maxTargetSpeedUvPerSec ?? -1,
        shakeThresholdUv: params.conditioning.shakeThresholdUv,
        shakeWindowSec: params.conditioning.shakeWindowSec,
        decimateHz: params.conditioning.decimateHz,
        minDistanceUv: params.conditioning.minDistanceUv,
        shapeStabilizeSec: params.conditioning.shapeStabilizeSec,
      },
      inputs: { ...init.inputs },
      generatedAt: init.generatedAt,
    },
    blend: 'replace',
    blendMs: params.blendMs,
    activeRanges: init.keys.length > 0 ? [init.activeRange] : [],
    enabled: true,
    channels: {
      center: {
        keys: init.keys,
        spring: { ...params.spring },
      },
    },
  };
}
