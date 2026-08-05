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

import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  BUNDLE,
  applyOps as applyOpsToDocument,
  isSafeBundleRelativePath,
  mediaPartPath,
  newSettingsDoc,
  ulid,
  validateEditDocument,
  validateProjectDoc,
  validateSettingsDoc,
  type EditDocument,
  type EditOp,
  type PartIndex,
  type ProjectDoc,
  type ProjectState,
  type RecordingDoc,
  type RecordingId,
  type RecordingSummary,
  type SettingsDoc,
  type TrackKey,
  type ValidationIssue,
} from '@loom/format';
import {
  BundleLock,
  JournalWriter,
  createBundle,
  directorySize,
  listBundles,
  loadDocument,
  readBundle,
  sweepTempArtifacts,
  writeJsonAtomic,
  type BundlePaths,
  type OpenedBundle,
} from '@loom/format/fs';

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

export class UnknownRecordingError extends Error {
  constructor(id: RecordingId) {
    super(`no recording with id ${JSON.stringify(id)} under the recordings root`);
    this.name = 'UnknownRecordingError';
  }
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
  private settings: SettingsDoc | null = null;

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
      const { doc } = await loadDocument(
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

  /** Replace `recording.json`. Written once, by the capture pipeline, at finalize. */
  async writeRecordingDoc(id: RecordingId, recording: RecordingDoc): Promise<void> {
    const open = this.open.get(id);
    if (open === undefined) throw new UnknownRecordingError(id);
    await this.enqueue(open, async () => {
      await writeJsonAtomic(open.paths.recording, recording);
      open.recording = recording;
    });
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
