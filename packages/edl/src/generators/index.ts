/**
 * The generators — architecture report §6, and §3.5's account of how their output
 * relates to a hand-authored track.
 *
 * Two of them ship here: **cursor-follow** (§6.1 conditioning → §6.2 dead zone → §6.3
 * spring → §6.4 phase lead) and **auto-zoom-on-click** (§6.5). Both produce an
 * ordinary `Track`; neither integrates anything, because §3.4's rule is that a spring
 * channel is integrated on a fixed 8 ms grid at compile time by `precomputeSpring` and
 * nowhere else.
 *
 * ## The three things a caller has to get right
 *
 * 1. **Clicks may be absent, and that is not zero clicks.** {@link generateAutoZoom}
 *    takes a {@link ClickSource}, not a stream, so "the tap was dead" and "nobody
 *    clicked" cannot arrive as the same value. `clicks.ts` says why at length.
 * 2. **Cursor-follow is `center`-only.** It follows at a *framing* — `zoomAmount`, or
 *    a `FollowGeometry` for a zoom that changes — and leaves `amount` to whatever
 *    stacks above it. §3.5's stack is per channel.
 * 3. **§6.6 is a check the generator runs on itself.** {@link generateCursorFollow}
 *    runs it, widens the rest box and retries per §6.6, and reports the attempt it
 *    returned along with a warning when the budget was not met.
 *
 * §6.7 — the *cursor sprite's* own, stiffer spring — is not here. It is what draws the
 * pointer, `Track` already carries `smoothing` and `clickSpring` for it, and the
 * consumer that composites the sprite owns it.
 */

export {
  conditionCursor,
  stabilizeCursorShapes,
  DECIMATE_HZ,
  DEFAULT_CONDITIONING,
  DEFAULT_MIN_DISTANCE_UV,
  EMPTY_CONDITIONED_CURSOR,
  SHAKE_THRESHOLD_UV,
  SHAKE_WINDOW_SEC,
  SHAPE_STABILIZE_SEC,
  type ConditionedCursor,
  type ConditioningParams,
  type CursorSample,
} from './conditioning.ts';

export {
  clampCentre,
  constantFollowGeometry,
  followTarget,
  halfViewport,
  DEFAULT_REST_BOX,
  type DeadZoneOptions,
  type FollowGeometry,
  type FollowTarget,
} from './dead-zone.ts';

export {
  generateCursorFollow,
  leadSecondsFor,
  scaleSpring,
  BUDGET_ATTEMPTS,
  COMFORT_LADDER,
  DEFAULT_CURSOR_FOLLOW_PARAMS,
  DEFAULT_FOLLOW_AMOUNT,
  DEFAULT_KEY_EPSILON_UV,
  REST_BOX_WIDEN,
  type ComfortRung,
  type CursorFollowAttempt,
  type CursorFollowInput,
  type CursorFollowParams,
  type CursorFollowResult,
} from './cursor-follow.ts';

export {
  capturedClicks,
  clickSourceFrom,
  describeClickUnavailable,
  unavailableClicks,
  type ClickSource,
  type ClickUnavailable,
} from './clicks.ts';

export {
  clusterClicks,
  edgeSnap,
  generateAutoZoom,
  mergeSegments,
  segmentOf,
  segmentSettleTailSec,
  DEFAULT_AUTO_ZOOM_PARAMS,
  DEFAULT_GENERATED_BLEND_MS,
  type AutoZoomInput,
  type AutoZoomParams,
  type AutoZoomResult,
  type Click,
  type ClickCluster,
  type ZoomSegment,
} from './auto-zoom.ts';

export {
  describeSeasickness,
  emptySeasicknessReport,
  framingTrack,
  measureSeasickness,
  measurementDocument,
  measureTrack,
  seasicknessPenalty,
  visibleCentre,
  SEASICKNESS_BUDGET,
  type MeasureOptions,
  type SeasicknessLimits,
  type SeasicknessMetric,
  type SeasicknessReport,
} from './budget.ts';

export {
  bakeOps,
  bakeTrack,
  generatedTracks,
  generatedTrackStaleness,
  isRegenerable,
  regenerateOps,
  type StaleReason,
  type StalenessReport,
} from './lifecycle.ts';
