/**
 * `@loom/edl` — the timeline model.
 *
 * Architecture report §3, in code. Four track kinds, one keyframe type, one channel
 * type; two time domains with the clip list as the only mapping between them; two
 * evaluators — pointwise curves and a spring precomputed on a fixed 8 ms grid — and
 * one hot-path function that preview and export both call.
 *
 * **Pure**, like `decode` and `compositor`: no `node:`, no `electron`, no I/O, no
 * DOM. §1.3: *"`edl` and `compositor` being framework-free is what lets a headless
 * test render frame 1,234 of a fixture project and compare it byte-for-byte against
 * the exporter's frame 1,234."* It reaches a recording through the two stream
 * interfaces in `streams.ts` and nothing else.
 *
 * The `EditDocument` types, their on-disk schema, their migrations and the journal
 * ops all live in `@loom/format` — see the boundary note at the top of
 * `packages/format/src/types/edit.ts`. This package owns the *semantics*.
 *
 * ## Where to start
 *
 * - {@link compile} once per edit, {@link resolve} once per frame.
 * - {@link manualZoomTrack} builds decision 3's first consumer.
 * - {@link EditHistory} is §2.7's inverse-op stack.
 * - {@link generateCursorFollow} and {@link generateAutoZoom} are §6, and
 *   `src/generators/index.ts` is the three things a caller of them has to get right.
 */

// ---- the model, compiled and resolved ---------------------------------------
export {
  compile,
  CompiledTimeline,
  EMPTY_COMPILE_CONTEXT,
  BLEND_ADD,
  BLEND_MULTIPLY,
  BLEND_REPLACE,
  DOMAIN_SOURCE,
  DOMAIN_TIMELINE,
  TARGET_ANNOTATION,
  TARGET_AUDIO_MIC,
  TARGET_AUDIO_SYSTEM,
  TARGET_BUBBLE,
  TARGET_CURSOR,
  TARGET_ZOOM,
  type CompileContext,
  type CompiledLayer,
  type CompiledMuteLayer,
  type CompiledSlot,
  type CompiledSpan,
  type CompiledSpanLayer,
  type CompiledStack,
} from './compile.ts';

export { resolve, windowWeight } from './resolve.ts';

export { identityTimeline } from './identity-timeline.ts';

// ---- the state the compositor consumes --------------------------------------
export {
  cloneResolvedState,
  identityState,
  IDENTITY_BUBBLE_ASPECT,
  IDENTITY_BUBBLE_CORNER01,
  IDENTITY_BUBBLE_CX,
  IDENTITY_BUBBLE_CY,
  IDENTITY_BUBBLE_OPACITY,
  IDENTITY_BUBBLE_SIZE_Y,
  IDENTITY_CURSOR_OPACITY,
  IDENTITY_CURSOR_SCALE,
  IDENTITY_GAIN_DB,
  IDENTITY_ZOOM_AMOUNT,
  IDENTITY_ZOOM_CX,
  IDENTITY_ZOOM_CY,
  type ResolvedAnnotation,
  type ResolvedAudio,
  type ResolvedBubble,
  type ResolvedCursor,
  type ResolvedState,
  type ResolvedZoom,
} from './state.ts';

// ---- the two evaluators ------------------------------------------------------
export {
  channelWidth,
  ChannelCompileError,
  classifyChannel,
  compileChannel,
  CurveChannel,
  SpringChannel,
  type ChannelKind,
  type CompiledChannel,
} from './channel.ts';

export { cubicBezierEase } from './bezier.ts';

export {
  precomputeSpring,
  springConstants,
  springDecayRate,
  springSettleSec,
  springStep,
  springTableEndSec,
  MAX_SPRING_TABLE_SEC,
  SPRING_GRID_SEC,
  type SpringConstants,
  type SpringTable,
} from './spring.ts';

// ---- the clip list, the one mapping between the domains ----------------------
export {
  clipIndexAt,
  compileClips,
  sourceDurationSec,
  sourceTimeAt,
  type CompiledClips,
} from './clips.ts';

// ---- the event-log seams -----------------------------------------------------
export {
  arrayClickStream,
  arrayCursorStream,
  type ClickEventInput,
  type ClickEventStream,
  type CursorEventStream,
  type CursorSampleInput,
} from './streams.ts';

// ---- ops, undo and redo ------------------------------------------------------
export { inverseOp, inverseOps, InverseOpError } from './inverse.ts';
export {
  EditHistory,
  DEFAULT_HISTORY_LIMIT,
  type EditHistoryOptions,
  type HistoryEntry,
  type HistoryResult,
} from './history.ts';

// ---- the generators (§6) -----------------------------------------------------
export * from './generators/index.ts';

// ---- track factories ---------------------------------------------------------
export {
  ALWAYS,
  annotationSpan,
  annotationTrack,
  bubbleTrack,
  DEFAULT_MANUAL_BLEND_MS,
  DEFAULT_SPRING,
  manualZoomTrack,
  type AnnotationSpanInput,
  type AnnotationTrackInput,
  type BubbleInput,
  type ManualZoomInput,
} from './tracks.ts';

// ---- what an annotation span means (phase 11) --------------------------------
export {
  AnnotationError,
  ANNOTATION_KINDS,
  isAnnotationKind,
  isPrivacyKind,
  newAnnotationGeometry,
  parseColor,
  readAnnotationGeometry,
  readAnnotationStyle,
  type AnnotationGeometry,
  type AnnotationKind,
  type AnnotationStyle,
  type Rgba,
  type TextAlign,
} from './annotations.ts';
