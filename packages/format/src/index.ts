/**
 * `@loom/format` — the on-disk project format.
 *
 * This entry point is **pure**: no `node:` imports, no DOM, no I/O. It is safe in
 * the main process, in a renderer, and in a test. Everything that touches a
 * filesystem lives behind `@loom/format/fs`, which only the main process imports.
 *
 * That split is not cosmetic. Architecture report §0, rule 2: *"Main is the only
 * writer. Renderers propose; main persists."* A renderer can hold, inspect and
 * reason about a document with these types; it has no way to write one.
 *
 * Authority: architecture report §2 (`data/loom-architecture/report.md`).
 */

// ---- schema and versioning -------------------------------------------------
export {
  CURRENT_VERSION,
  SCHEMA_FAMILIES,
  currentSchemaId,
  parseSchemaId,
  schemaId,
  type ParsedSchemaId,
  type SchemaFamily,
  type SchemaId,
  type SchemaTagged,
} from './schema.ts';

// ---- identifiers -----------------------------------------------------------
export { isUlid, ulid, ulidTime, ULID_PATTERN } from './ids.ts';

// ---- document types --------------------------------------------------------
export type {
  AudioTrackKey,
  IsoTimestamp,
  PartIndex,
  RecordingId,
  Seconds,
  TrackKey,
  Vec2,
  VideoTrackKey,
} from './types/common.ts';
export {
  AUDIO_TRACK_KEYS,
  TRACK_KEYS,
  VIDEO_TRACK_KEYS,
  isAudioTrack,
  isVideoTrack,
} from './types/common.ts';

export type {
  ExportRecord,
  ExportSettingsRecord,
  ExportVerification,
  ProjectDoc,
  ProjectState,
  RetentionRecord,
} from './types/project.ts';
export { PROJECT_STATES } from './types/project.ts';

export type {
  AudioGap,
  AudioPart,
  AudioTrackDoc,
  CaptureInfo,
  ColrInfo,
  DisplayInfo,
  IntegrityInfo,
  PartEndReason,
  PartRate,
  PermissionState,
  RecordingClock,
  RecordingDoc,
  RecordingEvents,
  RecordingTracks,
  VideoPart,
  VideoTrackDoc,
} from './types/recording.ts';

export type {
  BackgroundSpec,
  BlendMode,
  Channel,
  ChannelValue,
  Clip,
  Ease,
  EditDocument,
  GeneratorSpec,
  Keyframe,
  OutputSpec,
  Span,
  SpringParams,
  TimeDomain,
  Track,
  TrackKind,
} from './types/edit.ts';

export type { CursorImage, CursorIndexDoc, FrameIndexDoc } from './types/sidecar.ts';
export type { SettingsDoc } from './types/settings.ts';
export type { RecordingSummary } from './types/summary.ts';

export type {
  ClickEvent,
  CursorLogLine,
  CursorMetaEvent,
  CursorSample,
  DrawingEvent,
  ModifierMask,
} from './types/events.ts';
export { isCursorSample, MODIFIER } from './types/events.ts';

// ---- bundle layout ---------------------------------------------------------
export {
  BUNDLE,
  BUNDLE_DIRECTORIES,
  BUNDLE_EXTENSION,
  DEFAULT_RECORDING_NAME,
  EVENT_LOG_KINDS,
  EVENT_LOG_PATH,
  type EventLogKind,
  backupPath,
  bundleDirName,
  cursorImagePath,
  filmstripPath,
  isBundleDirName,
  isSafeBundleRelativePath,
  mediaIndexPath,
  mediaPartPath,
  partSuffix,
  sanitizeRecordingName,
} from './bundle/layout.ts';

// ---- A/V sync --------------------------------------------------------------
export {
  CROSS_TRACK_SNAP_SEC,
  audioRuns,
  audioSampleIndexAt,
  audioSampleTimeSec,
  driftSec,
  resampleRatio,
  snapNearby,
  totalGapSec,
  trackSourceTimeSec,
  videoPartStartSec,
  type AudioPartTiming,
  type AudioRun,
  type VideoPartStartOptions,
} from './sync/align.ts';
export {
  AudioCaptureMeter,
  TrackEpochEstimator,
  alignAudioPart,
  audioPartDoc,
  type AlignAudioPartOptions,
  type AudioBufferFacts,
  type AudioCaptureMeterOptions,
  type AudioCaptureSummary,
  type CapturedGap,
} from './sync/audio-meter.ts';

// ---- validation ------------------------------------------------------------
export { IssueSink, ValidationError, type ValidationIssue } from './validate/issues.ts';
export {
  VALIDATORS,
  assertValid,
  validateCursorIndexDoc,
  validateEditDocument,
  validateFrameIndexDoc,
  validateProjectDoc,
  validateRecordingDoc,
  validateSettingsDoc,
  type ValidationResult,
  type Validator,
} from './validate/documents.ts';

// ---- migration -------------------------------------------------------------
export {
  MigrationError,
  MigrationRegistry,
  defaultRegistry,
  migrateDocument,
  type JsonObject,
  type MigrationErrorCode,
  type MigrationOutcome,
  type MigrationStep,
} from './migrate/registry.ts';

// ---- the edit journal ------------------------------------------------------
export {
  EDIT_OP_KINDS,
  isEditOp,
  isEditOpKind,
  type EditOp,
  type EditOpKind,
  type JournalEntry,
  type JournalHeader,
  type TrackPatch,
} from './journal/ops.ts';
export { OpApplyError, applyOpInPlace, applyOps } from './journal/apply.ts';
export {
  parseJournal,
  replayJournal,
  type JournalLineProblem,
  type JournalParseResult,
  type ReplayResult,
} from './journal/replay.ts';

// ---- factories -------------------------------------------------------------
export {
  isoTimestamp,
  newCursorIndexDoc,
  newEditDocument,
  newProjectDoc,
  newSettingsDoc,
  type NewProjectInput,
} from './defaults.ts';
