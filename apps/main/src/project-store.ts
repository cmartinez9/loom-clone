/**
 * `ProjectStore` — **the only thing in this application that writes to disk.**
 *
 * Architecture report §0, rule 2: *"Main is the only writer. Renderers propose;
 * main persists. This is what makes crash survival a property of the architecture
 * rather than a feature someone has to remember."*
 *
 * That rule is enforced by four mechanisms, not by asking people to remember it:
 *
 * 1. **Renderers cannot write.** Every window runs `sandbox: true`,
 *    `contextIsolation: true`, `nodeIntegration: false`. There is no `require` in a
 *    renderer to reach `node:fs` with, and the preload exposes no file API.
 * 2. **`@loom/format/fs` is import-restricted.** `eslint.config.mjs` allows it in
 *    this file and nowhere else in `apps/main`; `node:fs` is additionally allowed
 *    in `media-reader.ts`, which only ever reads.
 * 3. **The bundle lock.** A `.lock` file (§2.1) makes "two copies of the app
 *    pointed at the same recordings root" a readable refusal instead of a race.
 * 4. **The write primitive is atomic.** `writeAtomic` replaces a file only by
 *    `rename(2)`, so a killed writer leaves the old bytes or the new ones.
 *
 * This class deliberately imports nothing from `electron`: it is plain Node, and
 * therefore unit-testable without a browser. The one platform capability it needs —
 * moving a bundle to the Trash — is injected.
 */

import { createReadStream } from 'node:fs';
import { mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  BUNDLE,
  EVENT_LOG_PATH,
  applyOps as applyOpsToDocument,
  cursorImagePath,
  isAudioTrack,
  isSafeBundleRelativePath,
  mediaIndexPath,
  mediaPartPath,
  newSettingsDoc,
  totalGapSec,
  ulid,
  validateCursorIndexDoc,
  validateEditDocument,
  validateFrameIndexDoc,
  validateProjectDoc,
  validateSettingsDoc,
  type AudioPart,
  type AudioTrackDoc,
  type AudioTrackKey,
  type CursorIndexDoc,
  type EditDocument,
  type EditOp,
  type EventLogKind,
  type ExportRecord,
  type FrameIndexDoc,
  type PartEndReason,
  type PartIndex,
  type ProjectDoc,
  type ProjectState,
  type RecordingDoc,
  type RecordingId,
  type RecordingSummary,
  type SettingsDoc,
  type SetupState,
  type TrackKey,
  type ValidationIssue,
  type VideoPart,
  type VideoTrackDoc,
} from '@loom/format';
import {
  BundleLock,
  EventLogWriter,
  JournalWriter,
  createBundle,
  directorySize,
  listBundles,
  loadAndUpgradeDocument,
  loadDocument,
  readBundle,
  sweepTempArtifacts,
  writeAtomic,
  writeJsonAtomic,
  type BundlePaths,
  type OpenedBundle,
} from '@loom/format/fs';
import {
  parseInitSegment,
  type ColourDescription,
  type EncodedSample,
  type FastStartAudioSpec,
  type FastStartVideoSpec,
} from '@loom/mux';
import {
  AudioPartWriter,
  ExportMp4Writer,
  MediaPartWriter,
  recoverAudioPart,
  recoverMediaPart,
  type FinalizedAudioPart,
  type FinalizedExport,
  type FinalizedPart,
  type RecoveredPart,
} from '@loom/mux/fs';

// `@loom/mux/fs` has exactly one caller, so what a finalized part reports is
// re-exported from here rather than imported a second time by the recorder.
export type { FinalizedAudioPart, FinalizedExport, FinalizedPart };

export interface ProjectStoreOptions {
  /** Absolute path to the recordings root. */
  recordingsRoot: string;
  /** Absolute path to `settings.json` (in `userData`, outside every bundle). */
  settingsPath: string;
  appVersion: string;
  /** Move a path to the Trash. Injected so this class stays free of `electron`. */
  trash: (path: string) => Promise<void>;
  /** `fsync` cadence for the journal, ms. Report §2.7 specifies 250. */
  journalSyncMs?: number;
  /** `edit.json` snapshot debounce, ms. Report §2.7 specifies 2000. */
  snapshotDebounceMs?: number;
}

interface OpenProject {
  id: RecordingId;
  paths: BundlePaths;
  lock: BundleLock;
  journal: JournalWriter;
  project: ProjectDoc;
  recording: RecordingDoc | null;
  edit: EditDocument;
  /**
   * Open append handles on `events/*.ndjson`, created lazily.
   *
   * Held for the life of the open project rather than reopened per append: at 120 Hz
   * the cursor log is appended ten times a second, and an `open`/`close` per batch
   * would make the ordering guarantee a property of the filesystem instead of the
   * handle — the same argument as the journal's.
   */
  eventLogs: Map<EventLogKind, EventLogWriter>;
  /** Set while the in-memory `edit` is ahead of the `edit.json` on disk. */
  snapshotPending: boolean;
  syncTimer: NodeJS.Timeout | null;
  snapshotTimer: NodeJS.Timeout | null;
  /**
   * Serializes every write for this project.
   *
   * A debounced snapshot, an `applyOps` and a `close` can all be in flight at
   * once; without this, a snapshot that started before a close would finish after
   * it and write into a journal that had already been closed. One writer per
   * project, in order, is the whole point of this class.
   */
  chain: Promise<void>;
}

/** What a capture part needs before its first frame can be written. */
export interface MediaPartRequest {
  track: TrackKey;
  part: PartIndex;
  /** Coded size, in pixels. */
  width: number;
  height: number;
  /** The `avcC` record from `VideoDecoderConfig.description`. */
  avcC: Uint8Array;
  /** Requested capture rate, used only for the final sample's duration. */
  nominalFps: number;
  colour?: ColourDescription;
}

/** What an audio capture part needs before its first frame can be written. */
export interface AudioPartRequest {
  track: AudioTrackKey;
  part: PartIndex;
  /** The rate the device reported. Also the media timescale. */
  sampleRate: number;
  channels: number;
  /** `AudioDecoderConfig.description` — the AudioSpecificConfig. */
  audioSpecificConfig: Uint8Array;
  bitrate?: number;
}

/** Bundle-relative paths of a part that is now open for writing. */
export interface OpenedMediaPart {
  file: string;
  index: string;
}

/** What a crash-recovery pass over one bundle achieved. Architecture report §7.1. */
export interface BundleRecovery {
  recordingId: RecordingId;
  name: string;
  /** `true` when the bundle came back as an editable recording. */
  recovered: boolean;
  recoveredSec: number;
  frameCount: number;
  /** Bytes dropped from a fragment that was mid-write when the process died. */
  truncatedBytes: number;
  error: string | null;
}

/** How much of a part is read to find its initialisation segment. See `readPartAvcC`. */
const INIT_SEGMENT_PROBE_BYTES = 64 * 1024;

export class UnknownRecordingError extends Error {
  constructor(id: RecordingId) {
    super(`no recording with id ${JSON.stringify(id)} under the recordings root`);
    this.name = 'UnknownRecordingError';
  }
}

/**
 * A chunk arrived for a job that is not writing.
 *
 * Typed, and never swallowed: an export whose chunks are being dropped would
 * otherwise finish "successfully" with a shorter video in it, which is the one
 * outcome phase 9 must never delete sources on the strength of.
 */
export class UnknownExportError extends Error {
  constructor(jobId: string) {
    super(`no export job ${JSON.stringify(jobId)} is open for writing`);
    this.name = 'UnknownExportError';
  }
}

/** What an export needs before its first sample. Shapes come from `@loom/mux`. */
export interface ExportWriteRequest {
  /** Absolute path of the finished file. Its directory is created if it is missing. */
  outputPath: string;
  video: FastStartVideoSpec;
  audio?: FastStartAudioSpec;
}

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`refusing to serve ${JSON.stringify(requested)}: outside its bundle`);
    this.name = 'PathEscapeError';
  }
}

/**
 * A batch was rejected because the document it produces is not a valid
 * `EditDocument`.
 *
 * `isEditOp` is structural by design, so a shape-valid op can still compose an
 * invalid document. Catching that here — before the journal, with a caller to
 * return it to — is what stops it becoming a snapshot that throws forever from a
 * background timer with nobody listening.
 */
export class InvalidEditError extends Error {
  constructor(id: RecordingId, issues: readonly ValidationIssue[]) {
    super(
      `refusing to apply ops to ${id}: the resulting edit.json would be invalid: ` +
        issues.map((i) => `${i.path}: ${i.message}`).join('; '),
    );
    this.name = 'InvalidEditError';
  }
}

export class ProjectStore {
  private readonly options: Required<ProjectStoreOptions>;
  /** `id -> absolute bundle directory`, refreshed by every scan. */
  private readonly directoryById = new Map<RecordingId, string>();
  private readonly open = new Map<RecordingId, OpenProject>();
  /**
   * Opens that have started but not finished, so concurrent openers share one.
   *
   * Without it, two calls for a project that is not open yet both reach
   * `BundleLock.acquire` and the loser fails against *our own* pid — the bundle
   * lock is between processes, and this is one process. Both `project:open` and
   * `project:applyOps` are `invoke` handlers a renderer can call twice without
   * awaiting, so this window is reachable from outside main.
   */
  private readonly opening = new Map<RecordingId, Promise<OpenedBundle>>();
  /**
   * Capture parts open for writing, keyed `<recordingId>:<track>`.
   *
   * Deliberately **not** on the per-project queue that every other write uses. The
   * queue exists so a revision check and its append cannot interleave; a media part
   * has no revision, writes a different file, and shares nothing with `edit.json`.
   * What it does share is the crash budget: chunks arrive at 30 Hz and everything
   * queued in memory is exactly what a `SIGKILL` costs, so the append path must not
   * be able to end up behind a debounced snapshot's recursive bundle-size walk.
   * `MediaPartWriter` serializes its own appends, so ordering within a part still
   * holds.
   */
  private readonly openMedia = new Map<string, MediaPartWriter | AudioPartWriter>();
  /**
   * Exports open for writing, keyed by job id.
   *
   * Separate from `openMedia` because an export is not part of a bundle and outlives
   * no recording: main owns the export window (§1.2), so a job survives the editor
   * closing and has to be findable by its own id rather than by a recording's.
   *
   * **Promises, not writers.** The encoder announces its `decoderConfig` and emits
   * its first chunk in the *same* callback, so `meta` and the first `chunk` are one
   * IPC message apart — and opening the file is two `await`s long. Registering the
   * open synchronously, before the first `await`, is what makes an append queue
   * behind it instead of arriving at an empty map: the same shape, and the same
   * reason, as `videoTrack()` in the recorder's `session.ts`. Without it the first
   * chunk of every export is dropped, and the first chunk of a video is its
   * keyframe — a file that demuxes, reports the right duration, and cannot be
   * decoded from the front.
   */
  private readonly openExports = new Map<string, Promise<ExportMp4Writer>>();
  private settings: SettingsDoc | null = null;
  /**
   * Settings writes, serialized — the same reason the per-project queue exists.
   *
   * `updateSetup` merges a patch into the document it last read, and the read is
   * separated from the write by a `mkdir` and an atomic rename. Two unqueued patches
   * therefore both read the pre-first snapshot and the second silently drops the
   * first's field: "Open System Settings" followed quickly by "Continue" loses the
   * Accessibility timestamp, which is precisely the loss merging is supposed to
   * prevent.
   */
  private settingsWrites: Promise<unknown> = Promise.resolve();

  constructor(options: ProjectStoreOptions) {
    this.options = {
      journalSyncMs: 250,
      snapshotDebounceMs: 2000,
      ...options,
    };
  }

  get recordingsRoot(): string {
    return this.settings?.recordingsRoot ?? this.options.recordingsRoot;
  }

  // ------------------------------------------------------------------ settings

  /**
   * Load `settings.json`, creating it if this is a first run.
   *
   * A settings file we cannot read is replaced with defaults rather than treated
   * as fatal: losing the recordings-root preference is annoying, refusing to launch
   * is not proportionate.
   */
  async loadSettings(): Promise<SettingsDoc> {
    try {
      // `loadAndUpgrade`, not `load`: settings is written by this class and phase 2
      // moved the family to version 2, so a returning user's file is genuinely
      // stale. Upgrading it here writes the new document once and leaves
      // `settings.json.v1.bak` beside it (§2.7), rather than re-running the chain on
      // every launch and never actually fixing the file.
      const { doc } = await loadAndUpgradeDocument(
        this.options.settingsPath,
        'loom.settings',
        validateSettingsDoc,
      );
      this.settings = doc;
      return doc;
    } catch {
      const doc = newSettingsDoc(this.options.recordingsRoot);
      await mkdir(dirname(this.options.settingsPath), { recursive: true });
      await writeJsonAtomic(this.options.settingsPath, doc);
      this.settings = doc;
      return doc;
    }
  }

  /**
   * First-run state, or the fresh-install default if settings have not been loaded.
   *
   * Never `null`: "we have not read settings yet" and "the user has not finished
   * setup" are the same answer to every caller — show the setup window — and giving
   * them two representations only creates a branch that can be got wrong.
   */
  get setup(): SetupState {
    return this.settings?.setup ?? { completedAt: null, accessibilityOpenedAt: null };
  }

  /**
   * Record a change to first-run state.
   *
   * Goes through the store because main is the only writer (§0, rule 1) — the setup
   * window proposes "I am done" and this is what persists it. Merged rather than
   * replaced so a caller marking setup complete cannot silently drop the
   * Accessibility timestamp that survives the relaunch it is about.
   */
  async updateSetup(patch: Partial<SetupState>): Promise<SetupState> {
    const write = this.settingsWrites.then(async () => {
      const current = this.settings ?? newSettingsDoc(this.options.recordingsRoot);
      const next: SettingsDoc = { ...current, setup: { ...current.setup, ...patch } };
      await mkdir(dirname(this.options.settingsPath), { recursive: true });
      await writeJsonAtomic(this.options.settingsPath, next);
      this.settings = next;
      return next.setup;
    });
    // The queue survives a failed write: one patch that could not be persisted must
    // not take every later patch down with it.
    this.settingsWrites = write.catch(() => undefined);
    return write;
  }

  // ------------------------------------------------------------------- library

  /**
   * Every recording under the root, newest first.
   *
   * Sizes are measured on disk rather than read from `project.json`, because a
   * bundle that was being written when the app died has a stale `sizeBytes` and the
   * library is exactly where the user would notice.
   */
  async list(): Promise<RecordingSummary[]> {
    const summaries = await listBundles(this.recordingsRoot);
    this.directoryById.clear();
    for (const summary of summaries) {
      if (summary.unreadable === undefined) this.directoryById.set(summary.id, summary.path);
    }
    return Promise.all(
      summaries.map(async (summary) => ({
        ...summary,
        sizeBytes: await directorySize(summary.path).catch(() => summary.sizeBytes),
      })),
    );
  }

  /** Absolute bundle directory for an id, scanning once if it is not yet known. */
  async directoryFor(id: RecordingId): Promise<string> {
    const known = this.directoryById.get(id);
    if (known !== undefined) return known;
    await this.list();
    const found = this.directoryById.get(id);
    if (found === undefined) throw new UnknownRecordingError(id);
    return found;
  }

  /**
   * Move a recording to the Trash.
   *
   * The Trash, not `unlink`: this is the user's footage and it is the one
   * irreversible thing the library can do. Any open handles are closed first so
   * the journal is not left writing into a deleted directory.
   */
  async trash(id: RecordingId): Promise<void> {
    const dir = await this.directoryFor(id);
    await this.close(id);
    await this.options.trash(dir);
    this.directoryById.delete(id);
  }

  // ----------------------------------------------------------------- lifecycle

  /**
   * Create a bundle with the full §2.1 layout, `state: 'recording'`.
   *
   * `state: 'recording'` is written **before the first frame** (§7.1), so a crash
   * during capture is detectable rather than inferred.
   */
  async create(name: string): Promise<{ id: RecordingId; paths: BundlePaths }> {
    const id = ulid();
    const created = await createBundle(this.recordingsRoot, {
      id,
      name,
      appVersion: this.options.appVersion,
    });
    this.directoryById.set(id, created.paths.dir);
    return { id, paths: created.paths };
  }

  /**
   * Open a project for writing.
   *
   * Takes the bundle lock, sweeps temp files a killed writer left behind, migrates
   * any stale documents in place, and replays `edit.journal.ndjson` on top of the
   * `edit.json` snapshot — which is what "Restored unsaved changes" means (§7.6).
   */
  async openProject(id: RecordingId): Promise<OpenedBundle> {
    const existing = this.open.get(id);
    if (existing !== undefined) {
      return {
        paths: existing.paths,
        project: existing.project,
        recording: existing.recording,
        edit: existing.edit,
        replay: { doc: existing.edit, applied: 0, skipped: 0, stoppedAt: null },
        journalTorn: false,
        journalProblems: [],
        journalRejected: null,
      };
    }

    const inFlight = this.opening.get(id);
    if (inFlight !== undefined) return inFlight;

    const attempt = this.acquireAndRead(id).finally(() => {
      this.opening.delete(id);
    });
    this.opening.set(id, attempt);
    return attempt;
  }

  /** The body of {@link openProject}, run at most once per project at a time. */
  private async acquireAndRead(id: RecordingId): Promise<OpenedBundle> {
    const dir = await this.directoryFor(id);
    const lock = await BundleLock.acquire(dir);
    try {
      await sweepTempArtifacts(dir);
      const opened = await readBundle(dir, { upgrade: true });
      const journal = new JournalWriter(opened.paths.journal);
      await journal.open({ headerRejected: opened.journalRejected !== null });

      this.open.set(id, {
        id,
        paths: opened.paths,
        lock,
        journal,
        project: opened.project,
        recording: opened.recording,
        edit: opened.edit,
        eventLogs: new Map(),
        // Replayed ops are in memory but not yet in the snapshot on disk.
        snapshotPending: opened.replay.applied > 0,
        syncTimer: null,
        snapshotTimer: null,
        chain: Promise.resolve(),
      });
      reportJournalRecovery(id, opened);
      if (opened.replay.applied > 0) this.scheduleSnapshot(id);
      return opened;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /** Read a project without taking the lock or migrating anything on disk. */
  async readProject(id: RecordingId): Promise<OpenedBundle> {
    const open = this.open.get(id);
    if (open !== undefined) {
      return {
        paths: open.paths,
        project: open.project,
        recording: open.recording,
        edit: open.edit,
        replay: { doc: open.edit, applied: 0, skipped: 0, stoppedAt: null },
        journalTorn: false,
        journalProblems: [],
        journalRejected: null,
      };
    }
    return readBundle(await this.directoryFor(id), { upgrade: false });
  }

  /**
   * Apply ops from the editor.
   *
   * `baseRevision` is the editor's view of the document. A mismatch returns the
   * authoritative document as a conflict rather than merging — it only happens when
   * two windows have the same project open, and reloading is the honest fix (§2.7).
   *
   * Order matters and is not negotiable: **journal first, memory second.** The
   * journal is the write-ahead log; if the process dies between the two, replay
   * reproduces the op. The other order would lose it.
   */
  async applyOps(
    id: RecordingId,
    ops: readonly EditOp[],
    baseRevision: number,
  ): Promise<{ revision: number } | { conflict: EditDocument }> {
    if (!this.open.has(id)) await this.openProject(id);
    const open = this.open.get(id);
    if (open === undefined) throw new UnknownRecordingError(id);

    // The whole read-check-append-commit sequence runs on the project's queue.
    // Checking the revision outside it would let two batches both read revision
    // n, both pass the conflict check, and both append as n + 1 — a lost update
    // and a duplicated journal entry, which is precisely what `baseRevision`
    // exists to prevent.
    return this.enqueue(open, async () => {
      if (this.open.get(id) !== open) throw new UnknownRecordingError(id);
      if (open.edit.revision !== baseRevision) return { conflict: structuredClone(open.edit) };
      if (ops.length === 0) return { revision: open.edit.revision };

      // `applyOpsToDocument` throws before mutating anything if an op cannot
      // land, so a rejected batch never half-applies and never reaches the
      // journal.
      const next = applyOpsToDocument(open.edit, ops);

      // And the *document* is validated here, not at snapshot time. `isEditOp` is
      // structural, so ops that pass it can still compose an invalid document; if
      // that only surfaced in `writeSnapshot` it would surface on a background
      // timer, with no caller to reject, and `edit.json` would stay frozen while
      // the journal grew without bound on every launch.
      const validation = validateEditDocument(next);
      if (!validation.ok) throw new InvalidEditError(open.id, validation.issues);

      const revision = await open.journal.append(ops, baseRevision);
      open.edit = next;
      open.snapshotPending = true;
      this.scheduleJournalSync(id);
      this.scheduleSnapshot(id);
      return { revision };
    });
  }

  // -------------------------------------------------------------- capture parts

  /**
   * Create `media/<track>.<part>.mp4` and write its initialisation segment.
   *
   * Called once per part, before its first frame. The part file is created with
   * `wx`, so a part index that has already been used is an error rather than a
   * silent truncation of somebody's footage.
   */
  async beginMediaPart(id: RecordingId, request: MediaPartRequest): Promise<OpenedMediaPart> {
    const open = this.open.get(id);
    if (open === undefined) throw new UnknownRecordingError(id);
    const key = mediaKey(id, request.track);
    if (this.openMedia.has(key)) {
      throw new Error(`${request.track} already has an open part for ${id}`);
    }
    if (request.track !== 'screen' && request.track !== 'webcam') {
      throw new Error(`${request.track} is not a video track`);
    }

    const file = mediaPartPath(request.track, request.part);
    const index = mediaIndexPath(request.track, request.part);
    const writer = await MediaPartWriter.create({
      mediaPath: join(open.paths.dir, file),
      indexPath: join(open.paths.dir, index),
      width: request.width,
      height: request.height,
      avcC: request.avcC,
      nominalFps: request.nominalFps,
      ...(request.colour === undefined ? {} : { colour: request.colour }),
    });
    this.openMedia.set(key, writer);
    return { file, index };
  }

  /**
   * Create `media/<track>.<part>.m4a` and write its initialisation segment.
   *
   * The audio counterpart of {@link beginMediaPart}, and separate from it because
   * the two need different things: an audio part has a sample rate, a channel
   * count and an AudioSpecificConfig, and no frame index — an AAC frame is a fixed
   * 1024 samples, so "where is sample n" is arithmetic rather than a sidecar
   * (§2.4 exists because a VFR video track cannot answer that).
   */
  async beginAudioPart(id: RecordingId, request: AudioPartRequest): Promise<{ file: string }> {
    const open = this.open.get(id);
    if (open === undefined) throw new UnknownRecordingError(id);
    const key = mediaKey(id, request.track);
    if (this.openMedia.has(key)) {
      throw new Error(`${request.track} already has an open part for ${id}`);
    }
    // Typed as an audio track, and checked as one anyway: the value reaches here
    // from a renderer message, and a video key would write AAC into a `.mp4`.
    const track = request.track as TrackKey;
    if (!isAudioTrack(track)) throw new Error(`${track} is not an audio track`);

    const file = mediaPartPath(request.track, request.part);
    const writer = await AudioPartWriter.create({
      mediaPath: join(open.paths.dir, file),
      sampleRate: request.sampleRate,
      channels: request.channels,
      audioSpecificConfig: request.audioSpecificConfig,
      ...(request.bitrate === undefined ? {} : { bitrate: request.bitrate }),
    });
    this.openMedia.set(key, writer);
    return { file };
  }

  /**
   * Append one encoded sample to an open part.
   *
   * Resolves once the bytes are with the kernel, which is the only thing that
   * makes them survive a `SIGKILL` (§7.1). Callers may fire these without awaiting
   * — order is preserved inside the writer — but must not drop the rejection: a
   * failed write is the recording ending, not a log line.
   */
  async appendMediaChunk(id: RecordingId, track: TrackKey, sample: EncodedSample): Promise<void> {
    const writer = this.openMedia.get(mediaKey(id, track));
    if (writer === undefined) throw new Error(`${track} has no open part for ${id}`);
    await writer.append(sample);
  }

  /** Frames written to an open part so far, for the recorder's status. */
  mediaFrameCount(id: RecordingId, track: TrackKey): number {
    return this.openMedia.get(mediaKey(id, track))?.frameCount ?? 0;
  }

  /**
   * Flush the held sample, write the frame index sidecar, and close the part.
   *
   * `endTimestampUs` is when capture stopped, on the encoder's clock. A screen
   * track stops producing frames when the screen stops changing, so without it a
   * recording that ends on a still screen loses everything after its last frame.
   */
  async finalizeMediaPart(
    id: RecordingId,
    track: TrackKey,
    endTimestampUs?: number,
  ): Promise<FinalizedPart> {
    const key = mediaKey(id, track);
    const writer = this.openMedia.get(key);
    if (writer === undefined) throw new Error(`${track} has no open part for ${id}`);
    if (!(writer instanceof MediaPartWriter)) throw new Error(`${track} is not a video track`);
    this.openMedia.delete(key);
    return writer.finalize(endTimestampUs);
  }

  /**
   * Close an audio part.
   *
   * No end timestamp: a screen track needs one because it stops producing frames
   * when the screen stops changing, so its last frame has to stand for the still
   * screen that followed. Audio has no such silence — a device that is running
   * produces samples whether or not anything is making a sound — so the part ends
   * where its samples end.
   */
  async finalizeAudioPart(id: RecordingId, track: TrackKey): Promise<FinalizedAudioPart> {
    const key = mediaKey(id, track);
    const writer = this.openMedia.get(key);
    if (writer === undefined) throw new Error(`${track} has no open part for ${id}`);
    if (!(writer instanceof AudioPartWriter)) throw new Error(`${track} is not an audio track`);
    this.openMedia.delete(key);
    return writer.finalize();
  }

  /**
   * Close an open part without losing what it holds.
   *
   * Used when capture fails or the app quits mid-recording: the bytes already
   * written stay, and the sidecar describes whatever the part actually contains.
   */
  async abortMediaPart(
    id: RecordingId,
    track: TrackKey,
  ): Promise<FinalizedPart | FinalizedAudioPart | null> {
    const key = mediaKey(id, track);
    const writer = this.openMedia.get(key);
    if (writer === undefined) return null;
    this.openMedia.delete(key);
    return writer.abort();
  }

  private async abortAllMediaParts(id: RecordingId): Promise<void> {
    const prefix = `${id}:`;
    await Promise.all(
      [...this.openMedia.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(async ([key, writer]) => {
          this.openMedia.delete(key);
          await writer.abort();
        }),
    );
  }

  // ---------------------------------------------------------------- exports

  /**
   * Open an export for writing.
   *
   * The exported MP4 lives **outside** the bundle (§2.1): captain decision 9 is
   * "save to disk, reveal in Finder", and revealing a file buried inside a
   * `.loomrec` directory is hostile. It is still written here, because §0 rule 2 is
   * about *the process that owns a file descriptor*, not about a directory — a
   * second writer would be an architecture change whether or not it wrote inside a
   * bundle. The read-back helpers below are here for the same reason: the honest way
   * to verify an export is to re-read the bytes on disk, and this class is what put
   * them there.
   *
   * Not on the per-project queue, and for the same reason media appends are not: an
   * export writes a different file, shares no revision with `edit.json`, and must
   * not be able to queue behind a snapshot's recursive bundle-size walk.
   */
  async beginExport(jobId: string, request: ExportWriteRequest): Promise<void> {
    if (this.openExports.has(jobId)) throw new Error(`export ${jobId} is already open`);
    const opening = (async (): Promise<ExportMp4Writer> => {
      await mkdir(dirname(request.outputPath), { recursive: true });
      return ExportMp4Writer.create({
        outputPath: request.outputPath,
        video: request.video,
        ...(request.audio === undefined ? {} : { audio: request.audio }),
      });
    })();
    // Registered before the first `await`, so a chunk that arrives while the file is
    // being created queues rather than being refused.
    this.openExports.set(jobId, opening);
    try {
      await opening;
    } catch (error) {
      this.openExports.delete(jobId);
      throw error;
    }
  }

  /** Whether a job is still writing. */
  hasOpenExport(jobId: string): boolean {
    return this.openExports.has(jobId);
  }

  async appendExportSample(
    jobId: string,
    kind: 'video' | 'audio',
    sample: { data: Uint8Array; durationUnits: number; isKey: boolean; timestampUs?: number },
  ): Promise<void> {
    const writer = await this.requireExport(jobId);
    const record = {
      data: sample.data,
      byteLength: sample.data.byteLength,
      durationUnits: sample.durationUnits,
      isKey: sample.isKey,
      ...(sample.timestampUs === undefined ? {} : { timestampUs: sample.timestampUs }),
    };
    if (kind === 'video') await writer.appendVideo(record);
    else await writer.appendAudio(record);
  }

  /** Assemble the file and move it into place. The writer is closed either way. */
  async finalizeExport(jobId: string): Promise<FinalizedExport> {
    const writer = await this.requireExport(jobId);
    this.openExports.delete(jobId);
    try {
      return await writer.finalize();
    } catch (error) {
      await writer.cancel();
      throw error;
    }
  }

  /**
   * Abandon an export, leaving nothing behind. Idempotent, and safe after
   * {@link finalizeExport} — the finished file has been renamed by then.
   */
  async cancelExport(jobId: string): Promise<void> {
    const opening = this.openExports.get(jobId);
    if (opening === undefined) return;
    this.openExports.delete(jobId);
    // A cancel that lands while the file is still being created still has to remove
    // it, so the open is awaited rather than abandoned — and an open that failed is
    // already cleaned up by `ExportMp4Writer.create`.
    const writer = await opening.catch(() => null);
    await writer?.cancel();
  }

  /**
   * Remove an export this store wrote and could not verify.
   *
   * §7.5's sequence is *"atomic rename. Then verify"*, so a file that fails the
   * checks is already in place under its real name — a broken video sitting in the
   * user's Exports folder that the app knows is broken. That is worse than no file:
   * the user finds it, sends it, and it does not play. It is removed rather than
   * left, and the failure is recorded in `project.json` either way, so nothing goes
   * quiet.
   *
   * Only ever called with the path a job just renamed into place; a caller that has
   * not renamed must not call it, or it would remove an *earlier* good export that
   * happened to share the name.
   */
  async discardExport(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  /** Size of a file, or `null` if it is not there or is not one. */
  async fileSize(path: string): Promise<number | null> {
    try {
      const stats = await stat(path);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  }

  /** Read the first `byteLength` bytes of a file, for a header. */
  async readFileHead(path: string, byteLength: number): Promise<Uint8Array> {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(byteLength);
      const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  /** Read a list of byte ranges out of a file, in one open. */
  async readFileRanges(
    path: string,
    ranges: readonly { offset: number; byteLength: number }[],
  ): Promise<Uint8Array[]> {
    const handle = await open(path, 'r');
    try {
      const out: Uint8Array[] = [];
      for (const range of ranges) {
        const buffer = Buffer.allocUnsafe(range.byteLength);
        let read = 0;
        while (read < range.byteLength) {
          const { bytesRead } = await handle.read(
            buffer,
            read,
            range.byteLength - read,
            range.offset + read,
          );
          if (bytesRead <= 0) {
            throw new Error(
              `${path} ends inside the range at ${range.offset}; the sample table ` +
                'describes bytes that are not in the file',
            );
          }
          read += bytesRead;
        }
        out.push(new Uint8Array(buffer));
      }
      return out;
    } finally {
      await handle.close();
    }
  }

  /**
   * `sha256` of an export, streamed.
   *
   * §7.5, obligation 1's fifth recorded fact. Streamed rather than read whole: a
   * ten-minute 4K export is gigabytes, and hashing it must not be the thing that
   * decides how much memory the app needs.
   */
  async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  /**
   * Append an export to `project.json`.
   *
   * Queued like every other document write, so it cannot race a debounced snapshot
   * and lose. Phase 9 reads `exports[].verified` to decide whether the sources may
   * go; a failed export is recorded too, with the checks that *did* pass, because
   * "no record" and "a record saying it failed" are different things to wake up to.
   */
  async recordExport(id: RecordingId, record: ExportRecord): Promise<void> {
    const open = this.requireOpen(id);
    await this.enqueue(open, async () => {
      open.project = {
        ...open.project,
        exports: [...open.project.exports.filter((e) => e.id !== record.id), record],
      };
      await this.writeProjectDoc(open);
    });
  }

  /**
   * Where exports go.
   *
   * `settings.exportRoot` when the user has changed it, `<recordingsRoot>/Exports`
   * otherwise — the default `types/settings.ts` has always documented. Captain
   * decision 9: *"Pick a sensible default output location and let the captain change
   * it. Do not prompt for a path on every export."*
   */
  async exportRoot(): Promise<string> {
    const settings = this.settings ?? (await this.loadSettings());
    return settings.exportRoot ?? join(this.recordingsRoot, 'Exports');
  }

  /** Remember a new export destination. */
  async setExportRoot(path: string): Promise<void> {
    const settings = this.settings ?? (await this.loadSettings());
    const next: SettingsDoc = { ...settings, exportRoot: path };
    const result = validateSettingsDoc(next);
    if (!result.ok) {
      throw new Error(
        `refusing to write invalid settings: ` +
          result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      );
    }
    await writeJsonAtomic(this.options.settingsPath, next);
    this.settings = next;
  }

  /**
   * Read one part's frame index sidecar (§2.4), through parse → migrate → validate.
   *
   * The stream-copy fast path needs it: the sidecar already holds a byte offset and
   * a PTS per frame, so a remux is a list of byte ranges rather than a demux.
   */
  async readFrameIndex(id: RecordingId, relativePath: string): Promise<FrameIndexDoc> {
    const path = await this.resolveBundleFile(id, relativePath);
    const { doc } = await loadDocument(path, 'loom.index', validateFrameIndexDoc);
    return doc;
  }

  /**
   * The `avcC` out of a capture part's initialisation segment.
   *
   * The exported file has to carry the *source's* codec description on the
   * stream-copy path, because the samples it describes are the source's samples,
   * unaltered. Read from the file rather than from `recording.json`, which does not
   * carry it — the same answer `source-reader.ts` gives to "where does the
   * description come from after a restart".
   */
  async readPartAvcC(id: RecordingId, relativePath: string): Promise<Uint8Array> {
    const path = await this.resolveBundleFile(id, relativePath);
    return parseInitSegment(await this.readFileHead(path, INIT_SEGMENT_PROBE_BYTES)).avcC;
  }

  private requireExport(jobId: string): Promise<ExportMp4Writer> {
    const opening = this.openExports.get(jobId);
    if (opening === undefined) return Promise.reject(new UnknownExportError(jobId));
    return opening;
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Bundles that were mid-recording when the process last died.
   *
   * `state: "recording"` or `"finalizing"` found at launch means we crashed — the
   * state is written before the first frame precisely so this is *detected* rather
   * than inferred from what happens to be on disk (§7.1).
   *
   * `"needs-recovery"` is here too, and is the case people forget: {@link
   * recoverBundle} writes that state *before* it repairs anything, so a launch that
   * dies mid-recovery — or a repair that fails on I/O — leaves a bundle stuck in it.
   * Excluding it would mean no later launch ever tried again, which is a bundle the
   * library says will be repaired when opened and nothing repairs. Recovery is
   * idempotent by construction (it rebuilds from the bytes on disk rather than from
   * what it did last time), so retrying it costs a scan and nothing else.
   */
  async listCrashed(): Promise<RecordingSummary[]> {
    const summaries = await this.list();
    return summaries.filter(
      (s) => s.state === 'recording' || s.state === 'finalizing' || s.state === 'needs-recovery',
    );
  }

  /**
   * Bring one crashed bundle back. Architecture report §7.1, steps 1–5.
   *
   * The captain's rule from `decision-journal-damage-recovery` governs the shape of
   * this: withhold what cannot be verified, open what can, report what was lost. So
   * a torn trailing fragment is truncated away rather than left to poison the next
   * read, the frame index is rebuilt from the fragments that survived rather than
   * trusted from a sidecar written before the crash, and the outcome — including a
   * recording with nothing in it — is returned to be said out loud, never thrown
   * away and never dressed up as a clean stop.
   */
  async recoverBundle(id: RecordingId): Promise<BundleRecovery> {
    const opened = await this.openProject(id);
    const name = opened.project.name;
    const dir = opened.paths.dir;
    try {
      await this.setState(id, 'needs-recovery');

      const recording = opened.recording;
      if (recording === null) {
        // `recording.json` is written before the part file is created, so its
        // absence means the crash landed before any frame could exist.
        return await this.failRecovery(
          id,
          name,
          'the recording stopped before it captured a frame',
        );
      }

      const screen = await repairVideoTrack(dir, recording.tracks.screen);
      const webcam = await repairVideoTrack(dir, recording.tracks.webcam);
      // An audio part is the same file shape as a video one, so it is scanned the
      // same way — but what comes back is smaller. `measuredSampleRate` and `gaps`
      // were measured against the capture clock by the process that died (§5.5);
      // they are not in the file and are not invented here. What *is* corrected is
      // how much audio survived, because a recovered `recording.json` that still
      // claims the provisional zero would misplace every sample after it.
      const mic = await repairAudioTrack(dir, recording.tracks.mic);
      const system = await repairAudioTrack(dir, recording.tracks.system);
      const repaired = [screen, webcam].filter((t) => t !== null);

      const frameCount = repaired.reduce((n, t) => n + t.frameCount, 0);
      const truncatedBytes =
        repaired.reduce((n, t) => n + t.truncatedBytes, 0) +
        [mic, system].reduce((n, t) => n + (t?.truncatedBytes ?? 0), 0);
      // Every track that was still running is cut back to the shortest of them: a
      // half-written trailing fragment on one must not desynchronise the rest
      // (§7.1, step 1).
      //
      // "Still running" is the part this cannot do without. A camera unplugged at
      // two seconds of a six second recording (§7.4) ends its track *on purpose*,
      // and the live session wrote down that it did; taking the minimum over that
      // too would report a recording with six seconds of screen and audio on disk
      // as two seconds recovered, and mark the other four truncated. So a track
      // whose last part ended for a recorded reason is excluded — and when every
      // track ended that way, what the user still has is the longest of them.
      //
      // The reason is read from the **repaired** document, not the one on disk, so
      // that it and `endSec` always come from the same part. A part announced in
      // `recording.json` whose file the crash landed before creating is dropped by
      // the repair; taking the reason from it would let a part that contributed
      // nothing to `endSec` decide whether the track was running.
      const running: number[] = [];
      const everyEnd: number[] = [];
      for (const track of [screen, webcam, mic, system]) {
        if (track === null) continue;
        everyEnd.push(track.endSec);
        if (!endedForARecordedReason(track.track.parts.at(-1))) running.push(track.endSec);
      }
      const shortestEndSec =
        running.length > 0
          ? Math.min(...running)
          : everyEnd.length > 0
            ? Math.max(...everyEnd)
            : null;

      if (frameCount === 0) {
        return await this.failRecovery(id, name, 'no complete frame survived the crash');
      }

      await this.writeRecordingDoc(id, {
        ...recording,
        // A track that recovered no part at all is dropped rather than left
        // pointing at a file with nothing in it — the format says a track has at
        // least one part, and an empty one would be a document that fails its own
        // validator on the next read.
        tracks: {
          ...(mic === null ? {} : { mic: mic.track }),
          ...(system === null ? {} : { system: system.track }),
          ...(screen === null ? {} : { screen: screen.track }),
          ...(webcam === null ? {} : { webcam: webcam.track }),
        },
        integrity: {
          finalizedAt: new Date().toISOString(),
          recoveredFromCrash: true,
          truncatedToSec: shortestEndSec,
        },
      });
      await this.setState(id, 'editable');

      return {
        recordingId: id,
        name,
        recovered: true,
        recoveredSec: shortestEndSec ?? 0,
        frameCount,
        truncatedBytes,
        error: null,
      };
    } finally {
      await this.close(id);
    }
  }

  /**
   * Mark a bundle that could not be brought back, and say why.
   *
   * `failed` rather than deleted or hidden: the recording is still in the library,
   * still revealable in Finder, still the user's. An app that quietly removes a
   * recording it could not read is an app that has lost the user's footage twice.
   */
  private async failRecovery(
    id: RecordingId,
    name: string,
    reason: string,
  ): Promise<BundleRecovery> {
    await this.setState(id, 'failed', reason);
    return {
      recordingId: id,
      name,
      recovered: false,
      recoveredSec: 0,
      frameCount: 0,
      truncatedBytes: 0,
      error: reason,
    };
  }

  /**
   * Replace `recording.json`. Whole-document, by the capture pipeline: the
   * provisional write before the first frame, every amendment a live session makes to
   * it — track announcements, the event logs the sampler declares — and finalize.
   * `RecorderSession` serializes the amendments on its own chain, because they are
   * read-modify-writes of one document and this queue only orders the writes.
   */
  async writeRecordingDoc(id: RecordingId, recording: RecordingDoc): Promise<void> {
    const open = this.open.get(id);
    if (open === undefined) throw new UnknownRecordingError(id);
    await this.enqueue(open, async () => {
      await writeJsonAtomic(open.paths.recording, recording);
      open.recording = recording;
    });
  }

  // -------------------------------------------------------------- event logs

  /**
   * The three append-only NDJSON logs under `events/` (§2.5), routed through the same
   * per-project queue as every other write.
   *
   * They are here rather than in `@loom/sampler` for one reason: the sampler spawns a
   * child process and produces tens of thousands of lines a minute, and letting it
   * open its own file handle would make it a second writer. Report §0, rule 2 says
   * there is one, and this class is it.
   *
   * `createEventLog` and `appendEventLog` are separate calls because the difference
   * between an absent `clicks.ndjson` and an empty one is load-bearing: absent means
   * clicks were never captured, empty means they were captured and none happened.
   * Creating a log is therefore an assertion the caller makes deliberately, never a
   * side effect of wanting to maybe write to one.
   *
   * **Ordering contract: stop the sampler, then close the project.** Every method in
   * this section requires the project to be open and throws `UnknownRecordingError`
   * otherwise, exactly as `writeRecordingDoc` and `setState` do. They are driven from
   * the sampler's timers rather than from a user action, so a write can still be in
   * flight when a caller decides it is finished; re-opening the bundle on its behalf
   * would silently re-take the `.lock` of a recording the user closed and hold it for
   * the rest of the session. A late write is therefore a loud, typed refusal — never
   * a re-open, and never a silent drop of cursor data the user believes was captured.
   */
  async createEventLog(id: RecordingId, log: EventLogKind): Promise<void> {
    const open = this.requireOpen(id);
    await this.enqueue(open, () => this.eventLog(open, log).create());
  }

  /**
   * Append newline-terminated NDJSON. Creates the log if it does not exist yet.
   *
   * Throws `UnknownRecordingError` if the project is not open — see the ordering
   * contract on {@link createEventLog}.
   */
  async appendEventLog(id: RecordingId, log: EventLogKind, ndjson: string): Promise<void> {
    const open = this.requireOpen(id);
    await this.enqueue(open, () => this.eventLog(open, log).append(ndjson));
  }

  /**
   * `fsync` an event log. §2.5's cadence is one second; the caller owns the timer.
   *
   * Throws `UnknownRecordingError` if the project is not open — see the ordering
   * contract on {@link createEventLog}.
   */
  async syncEventLog(id: RecordingId, log: EventLogKind): Promise<void> {
    const open = this.requireOpen(id);
    await this.enqueue(open, () => this.eventLog(open, log).sync());
  }

  /** Lines appended to an event log this session, or `null` if it was never opened. */
  eventLogLineCount(id: RecordingId, log: EventLogKind): number | null {
    return this.open.get(id)?.eventLogs.get(log)?.lineCount ?? null;
  }

  /**
   * Store a cursor bitmap at `cursors/<sha256>.png` (§2.5).
   *
   * Content-addressed, so an identical cursor is stored once and a re-write is a
   * no-op worth skipping — but it is written anyway rather than stat'd first, because
   * `writeAtomic` is a rename and the cost is a few kilobytes per distinct shape.
   *
   * Throws `UnknownRecordingError` if the project is not open — see the ordering
   * contract on {@link createEventLog}.
   */
  async writeCursorImage(id: RecordingId, sha256: string, png: Uint8Array): Promise<void> {
    const open = this.requireOpen(id);
    // `cursorImagePath` rejects anything that is not a lowercase hex sha256, which is
    // what keeps an id from the child process out of a path.
    const relative = cursorImagePath(sha256);
    await this.enqueue(open, () => writeAtomic(join(open.paths.dir, relative), png));
  }

  /**
   * Replace `cursors/index.json`, validated first like every other document.
   *
   * Throws `UnknownRecordingError` if the project is not open — see the ordering
   * contract on {@link createEventLog}.
   */
  async writeCursorIndex(id: RecordingId, doc: CursorIndexDoc): Promise<void> {
    const open = this.requireOpen(id);
    const result = validateCursorIndexDoc(doc);
    if (!result.ok) {
      throw new Error(
        `refusing to write an invalid cursors/index.json for ${id}: ` +
          result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      );
    }
    await this.enqueue(open, () => writeJsonAtomic(join(open.paths.dir, BUNDLE.cursorIndex), doc));
  }

  private eventLog(open: OpenProject, log: EventLogKind): EventLogWriter {
    let writer = open.eventLogs.get(log);
    if (writer === undefined) {
      writer = new EventLogWriter(join(open.paths.dir, EVENT_LOG_PATH[log]));
      open.eventLogs.set(log, writer);
    }
    return writer;
  }

  /**
   * The open project, or a refusal.
   *
   * Synchronous on purpose as well as strict: the caller reaches `enqueue` in the same
   * turn, so a `close` cannot land between the check and the write landing on the
   * project's queue.
   */
  private requireOpen(id: RecordingId): OpenProject {
    const open = this.open.get(id);
    if (open === undefined) throw new UnknownRecordingError(id);
    return open;
  }

  /**
   * Move a project through the lifecycle enum of §2.2.
   *
   * Queued like every other write: a state change racing a debounced snapshot
   * would otherwise have two writers of `project.json` and a last-one-wins result.
   */
  async setState(id: RecordingId, state: ProjectState, error?: string): Promise<void> {
    const open = this.open.get(id);
    if (open === undefined) throw new UnknownRecordingError(id);
    await this.enqueue(open, async () => {
      open.project = {
        ...open.project,
        state,
        ...(error === undefined ? {} : { error }),
      };
      await this.writeProjectDoc(open);
    });
  }

  /**
   * Flush everything and release the lock.
   *
   * Snapshot, then truncate the journal, then release — in that order, because the
   * journal may only be dropped once the snapshot that supersedes it is durable.
   */
  async close(id: RecordingId): Promise<void> {
    // Media parts first, and before the lock goes: a part still holding a file
    // descriptor into this bundle is a writer we said we no longer had.
    await this.abortAllMediaParts(id);

    const open = this.open.get(id);
    if (open === undefined) return;
    this.open.delete(id);

    if (open.syncTimer !== null) clearTimeout(open.syncTimer);
    if (open.snapshotTimer !== null) clearTimeout(open.snapshotTimer);

    // Removing it from `open` above turns any queued snapshot into a no-op; the
    // queue below then runs after whatever was already in flight.
    await this.enqueue(open, async () => {
      try {
        await this.writeSnapshot(open);
        await open.journal.truncate();
      } finally {
        // Event logs close first and unconditionally: they hold un-`fsync`'d cursor
        // samples, and the lock must not be released while a handle on a file inside
        // the bundle is still open.
        for (const writer of open.eventLogs.values()) await writer.close();
        open.eventLogs.clear();
        await open.journal.close();
        await open.lock.release();
      }
    });
  }

  /** Close every open project. Called from `before-quit`. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.close(id)));
  }

  // ------------------------------------------------------------------ snapshots

  /**
   * Run `work` after everything already queued for this project, and hand the
   * caller its own result.
   *
   * The chain itself never stays rejected — one failed snapshot must not wedge
   * every later write — but each caller still sees its own error.
   */
  private enqueue<T>(open: OpenProject, work: () => Promise<T>): Promise<T> {
    const result = open.chain.then(work, work);
    open.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Batched `fsync` for the journal, on the cadence architecture report §2.7 sets. */
  private scheduleJournalSync(id: RecordingId): void {
    const open = this.open.get(id);
    if (open === undefined) return;
    // A pending timer already covers everything appended since it was set.
    if (open.syncTimer !== null) return;
    open.syncTimer = setTimeout(() => {
      open.syncTimer = null;
      void this.enqueue(open, () => open.journal.sync()).catch(
        reportBackgroundFailure('journal fsync'),
      );
    }, this.options.journalSyncMs);
    open.syncTimer.unref?.();
  }

  private scheduleSnapshot(id: RecordingId): void {
    const open = this.open.get(id);
    if (open === undefined) return;
    if (open.snapshotTimer !== null) clearTimeout(open.snapshotTimer);
    open.snapshotTimer = setTimeout(() => {
      open.snapshotTimer = null;
      void this.snapshotAndTruncate(open).catch(reportBackgroundFailure('edit.json snapshot'));
    }, this.options.snapshotDebounceMs);
    open.snapshotTimer.unref?.();
  }

  /** Write `edit.json`, then drop the journal entries it now contains. */
  private async snapshotAndTruncate(open: OpenProject): Promise<void> {
    await this.enqueue(open, async () => {
      // The project may have been closed while this was queued; `close` already
      // wrote the final snapshot, and the journal handle is gone.
      if (this.open.get(open.id) !== open) return;
      await this.writeSnapshot(open);
      await open.journal.truncate();
    });
  }

  private async writeSnapshot(open: OpenProject): Promise<void> {
    if (!open.snapshotPending) return;
    // Validate before writing: a document that fails here would otherwise be a
    // file that this build wrote and the next launch refuses to open.
    const result = validateEditDocument(open.edit);
    if (!result.ok) {
      throw new Error(
        `refusing to write an invalid edit.json for ${open.id}: ` +
          result.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
      );
    }
    await writeJsonAtomic(open.paths.edit, open.edit);
    open.snapshotPending = false;
    await this.writeProjectDoc(open);
  }

  private async writeProjectDoc(open: OpenProject): Promise<void> {
    const doc: ProjectDoc = {
      ...open.project,
      editRevision: open.edit.revision,
      modifiedAt: new Date().toISOString(),
      sizeBytes: await directorySize(open.paths.dir).catch(() => open.project.sizeBytes),
    };
    const result = validateProjectDoc(doc);
    if (!result.ok) {
      throw new Error(
        `refusing to write an invalid project.json for ${open.id}: ` +
          result.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
      );
    }
    await writeJsonAtomic(open.paths.project, doc);
    open.project = doc;
  }

  // ------------------------------------------------------- read-only path access

  /**
   * Resolve a bundle-relative path to a real absolute path, or refuse.
   *
   * This is the gate in front of the `loom://` protocol handler, and the only way
   * a renderer's URL turns into a filesystem path. Three checks, all of them
   * necessary:
   *
   * 1. the relative path is syntactically safe (no `..`, no absolute, no NUL);
   * 2. the resolved path is inside the bundle;
   * 3. the *realpath* is still inside the bundle — which is what stops a symlink
   *    planted in `media/` from serving `~/.ssh/id_rsa` over `loom://`.
   */
  async resolveBundleFile(id: RecordingId, relativePath: string): Promise<string> {
    if (!isSafeBundleRelativePath(relativePath)) throw new PathEscapeError(relativePath);

    const dir = await this.directoryFor(id);
    const candidate = resolve(dir, relativePath);
    if (!isInside(dir, candidate)) throw new PathEscapeError(relativePath);

    const real = await realpath(candidate);
    const realDir = await realpath(dir);
    if (!isInside(realDir, real)) throw new PathEscapeError(relativePath);

    const stats = await stat(real);
    if (!stats.isFile()) throw new PathEscapeError(relativePath);
    return real;
  }

  /** Bundle-relative path of a media part, for `project.mediaUrl`. */
  mediaRelativePath(track: TrackKey, part: PartIndex): string {
    return mediaPartPath(track, part);
  }

  /** Remove a bundle's `.lock` — used only by the crash-recovery path. */
  async clearStaleLock(id: RecordingId): Promise<void> {
    const dir = await this.directoryFor(id);
    await rm(join(dir, BUNDLE.lock), { force: true });
  }
}

function mediaKey(id: RecordingId, track: TrackKey): string {
  return `${id}:${track}`;
}

interface RepairedTrack {
  track: VideoTrackDoc;
  frameCount: number;
  truncatedBytes: number;
  /** Where this track ends on the recording clock, after repair. */
  endSec: number;
}

/**
 * Did this part stop for a reason the live session wrote down?
 *
 * §7.4's unplugged camera is the case that matters: `capture.partEnded` closes the
 * part and records `endedEarly` with `endReason: 'device-lost'` in
 * `recording.json` while the screen and the audio carry on. A track whose last part
 * says that is not short — it is finished — and must not shorten the tracks that
 * were still recording when the process died.
 *
 * `'crash'` is deliberately not one of these reasons. It is what recovery itself
 * stamps on a part it had to repair, so treating it as an explanation would make a
 * second pass over an already-repaired bundle believe no track was ever running.
 */
function endedForARecordedReason(
  part: { endedEarly: boolean; endReason?: PartEndReason } | undefined,
): boolean {
  if (part === undefined) return false;
  return part.endedEarly && part.endReason !== undefined && part.endReason !== 'crash';
}

/** Repair every part of one video track, or return `null` if none survived. */
async function repairVideoTrack(
  dir: string,
  track: VideoTrackDoc | undefined,
): Promise<RepairedTrack | null> {
  if (track === undefined) return null;
  const parts: VideoPart[] = [];
  let frameCount = 0;
  let truncatedBytes = 0;
  let endSec = 0;
  for (const part of track.parts) {
    const result = await recoverPart(dir, part);
    if (result === null) continue;
    frameCount += result.frameCount;
    truncatedBytes += result.truncatedBytes;
    parts.push(repairedPart(part, result));
    endSec = part.startTimeSec + result.durationSec;
  }
  if (parts.length === 0) return null;
  return { track: { ...track, parts }, frameCount, truncatedBytes, endSec };
}

/**
 * Recover one part, or `null` if there is nothing there to recover.
 *
 * A missing media file means the crash landed between `recording.json` and the
 * part being created. That is a part with no frames, not a bundle that refuses to
 * open — so it is dropped from the recovered document and the caller reports a
 * recording with less in it, rather than an error the user cannot act on.
 */
async function recoverPart(dir: string, part: VideoPart): Promise<RecoveredPart | null> {
  try {
    return await recoverMediaPart(join(dir, part.file), join(dir, part.index));
  } catch (error) {
    console.warn(`[ProjectStore] ${part.file} could not be recovered:`, error);
    return null;
  }
}

interface RepairedAudioTrack {
  track: AudioTrackDoc;
  truncatedBytes: number;
  /** Where this track ends on the recording clock, after repair. */
  endSec: number;
}

/**
 * Repair every part of one audio track, or return `null` if none survived.
 *
 * `durationSec` is rewritten from the samples that are actually in the file, plus
 * the gaps the live session recorded: a part's extent on the recording clock is
 * its media plus the time in which no samples existed (see `AudioPart`). The gaps
 * themselves are kept as they were — a scanner cannot see a hole that was never
 * written — and everything else the provisional document said is left alone.
 *
 * The encoder's priming comes off the sample count first. It is in the file and
 * the part's edit list says to skip it, while `startTimeSec` is defined on the
 * decoded stream — so leaving it in would make a recovered part 44 ms longer than
 * the same part after a clean stop, and that number goes on to set
 * `integrity.truncatedToSec` and the seconds the user is told were recovered.
 */
async function repairAudioTrack(
  dir: string,
  track: AudioTrackDoc | undefined,
): Promise<RepairedAudioTrack | null> {
  if (track === undefined) return null;
  const parts: AudioPart[] = [];
  let truncatedBytes = 0;
  let endSec = 0;
  for (const part of track.parts) {
    let recovered;
    try {
      recovered = await recoverAudioPart(join(dir, part.file));
    } catch (error) {
      console.warn(`[ProjectStore] ${part.file} could not be recovered:`, error);
      continue;
    }
    if (recovered.frameCount === 0) continue;
    truncatedBytes += recovered.truncatedBytes;
    const rate = part.measuredSampleRate > 0 ? part.measuredSampleRate : recovered.sampleRate;
    const decodedSamples = Math.max(0, recovered.sampleCount - recovered.encoderDelaySamples);
    const durationSec = decodedSamples / rate + totalGapSec(part.gaps);
    parts.push({
      ...part,
      codec: recovered.codec,
      sampleRate: recovered.sampleRate,
      channels: recovered.channels,
      durationSec,
      endedEarly: true,
      endReason: 'crash',
    });
    endSec = part.startTimeSec + durationSec;
  }
  if (parts.length === 0) return null;
  return { track: { ...track, parts }, truncatedBytes, endSec };
}

/**
 * The part as the bytes on disk actually describe it, after recovery.
 *
 * A part that already carries a recorded reason keeps it. It ended when the camera
 * was unplugged, not when the process died, and overwriting that with `'crash'`
 * would throw away the only thing that tells the two apart — including from the
 * next recovery pass over the same bundle.
 */
function repairedPart(part: VideoPart, recovered: RecoveredPart): VideoPart {
  const recorded = part.endReason;
  return {
    ...part,
    codec: recovered.codec,
    size: recovered.size,
    durationSec: recovered.durationSec,
    frameCount: recovered.frameCount,
    rate: { ...part.rate, observedFps: recovered.observedFps },
    endedEarly: true,
    endReason: recorded !== undefined && endedForARecordedReason(part) ? recorded : 'crash',
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsoluteish(rel);
}

function isAbsoluteish(path: string): boolean {
  return path.startsWith(sep);
}

/**
 * Background failures have no caller to return to. They are logged loudly rather
 * than swallowed; the next snapshot attempt will retry, and the journal on disk is
 * still ahead of the snapshot, so nothing has been lost yet.
 */
function reportBackgroundFailure(what: string): (error: unknown) => void {
  return (error) => {
    console.error(`[ProjectStore] ${what} failed:`, error);
  };
}

/**
 * Say what replaying the journal actually recovered, and what it could not.
 *
 * `readBundle` has always computed this; nothing read it, so a torn append, a
 * corrupt line, or a replay that stopped at a gap in the log — the cases where the
 * user silently loses the tail of their edits — left no trace anywhere.
 */
function reportJournalRecovery(id: RecordingId, opened: OpenedBundle): void {
  const rejected = opened.journalRejected;
  if (rejected !== null) {
    // The one recorded problem *is* this rejection, so reporting both would say
    // the same thing twice.
    console.warn(
      `[ProjectStore] ${id}: the edit journal could not be read, so every entry in it ` +
        `was withheld and the project was recovered to revision ` +
        `${String(rejected.recoveredRevision)}. ${rejected.reason}`,
    );
    return;
  }
  if (opened.journalTorn) {
    console.warn(`[ProjectStore] ${id}: journal ended mid-line; the partial append was discarded`);
  }
  for (const problem of opened.journalProblems) {
    console.warn(`[ProjectStore] ${id}: unreadable journal line — ${problem}`);
  }
  const stopped = opened.replay.stoppedAt;
  if (stopped !== null) {
    console.warn(
      `[ProjectStore] ${id}: replay stopped at revision ${String(stopped.revision)}: ` +
        `${stopped.reason}. Edits after that point were not restored.`,
    );
  }
}
