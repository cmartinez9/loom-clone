/**
 * Creating, scanning and reading `.loomrec` bundles.
 *
 * The layout itself is `bundle/layout.ts`, which is pure. This module is the part
 * that touches a disk, and it is imported only by the main process.
 */

import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { BUNDLE, BUNDLE_DIRECTORIES, bundleDirName, isBundleDirName } from '../bundle/layout.ts';
import { newCursorIndexDoc, newEditDocument, newProjectDoc } from '../defaults.ts';
import type { RecordingId, Seconds } from '../types/common.ts';
import type { ProjectDoc } from '../types/project.ts';
import type { AudioTrackDoc, RecordingDoc, VideoTrackDoc } from '../types/recording.ts';
import type { EditDocument } from '../types/edit.ts';
import type { RecordingSummary } from '../types/summary.ts';
import {
  validateEditDocument,
  validateProjectDoc,
  validateRecordingDoc,
} from '../validate/documents.ts';
import { type MigrationRegistry, defaultRegistry } from '../migrate/registry.ts';
import { replayJournal, type ReplayResult } from '../journal/replay.ts';
import { loadAndUpgradeDocument, loadDocument } from './documents.ts';
import { readJournal } from './journal-file.ts';
import { isTempArtifact, writeJsonAtomic } from './write-atomic.ts';

/** Absolute paths to everything in one bundle. */
export interface BundlePaths {
  dir: string;
  project: string;
  recording: string;
  edit: string;
  journal: string;
  media: string;
  events: string;
  cursors: string;
  thumbs: string;
}

export function bundlePaths(dir: string): BundlePaths {
  return {
    dir,
    project: join(dir, BUNDLE.project),
    recording: join(dir, BUNDLE.recording),
    edit: join(dir, BUNDLE.edit),
    journal: join(dir, BUNDLE.journal),
    media: join(dir, BUNDLE.mediaDir),
    events: join(dir, BUNDLE.eventsDir),
    cursors: join(dir, BUNDLE.cursorsDir),
    thumbs: join(dir, BUNDLE.thumbsDir),
  };
}

export interface CreateBundleInput {
  id: RecordingId;
  name: string;
  appVersion: string;
  createdAt?: Date;
}

export interface CreatedBundle {
  paths: BundlePaths;
  project: ProjectDoc;
  edit: EditDocument;
}

/**
 * Create a bundle directory with the full §2.1 layout and its two mandatory
 * documents.
 *
 * The directory is created with `mkdir` (not `mkdir -p`) so a name collision is an
 * `EEXIST` we can react to rather than a silent merge into someone else's bundle.
 */
export async function createBundle(root: string, input: CreateBundleInput): Promise<CreatedBundle> {
  await mkdir(root, { recursive: true });

  const createdAt = input.createdAt ?? new Date();
  const base = bundleDirName(createdAt, input.name);
  let dir = join(root, base);
  for (let attempt = 2; ; attempt++) {
    try {
      await mkdir(dir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt > 99) throw new Error(`could not find a free bundle name for ${base}`);
      dir = join(root, base.replace(/\.loomrec$/, ` (${String(attempt)}).loomrec`));
    }
  }

  for (const sub of BUNDLE_DIRECTORIES) {
    await mkdir(join(dir, sub), { recursive: true });
  }

  const paths = bundlePaths(dir);
  const project = newProjectDoc({
    id: input.id,
    name: input.name,
    appVersion: input.appVersion,
    createdAt,
  });
  const edit = newEditDocument();

  await writeJsonAtomic(paths.project, project);
  await writeJsonAtomic(paths.edit, edit);
  await writeJsonAtomic(join(dir, BUNDLE.cursorIndex), newCursorIndexDoc());

  return { paths, project, edit };
}

export interface OpenedBundle {
  paths: BundlePaths;
  project: ProjectDoc;
  /** Absent until the capture finalizes; a bundle mid-recording has none. */
  recording: RecordingDoc | null;
  edit: EditDocument;
  /** What replaying `edit.journal.ndjson` on top of `edit.json` did. */
  replay: ReplayResult;
  /** True when the journal ended mid-line — a crash during an append. */
  journalTorn: boolean;
  /** Complete-but-unparseable journal lines. Empty in the healthy case. */
  journalProblems: readonly string[];
  /**
   * Set when the journal's schema header is not one this build understands.
   *
   * The bundle still opens, but **from `edit.json` alone**: every journal entry is
   * withheld, because §2.7 forbids guessing at a schema and reading a newer build's
   * ops under v1 assumptions is exactly that. Refusing the whole bundle would be
   * worse — a crash inside the ~30-byte header write would make a recording
   * permanently unopenable — so the damage and the revision the user was recovered
   * to are reported here instead, for the app to say out loud.
   */
  journalRejected: { reason: string; recoveredRevision: number } | null;
}

/**
 * Read every document in a bundle.
 *
 * `upgrade: true` persists any migration it performs (and is therefore only for
 * `ProjectStore`). `upgrade: false` migrates in memory and touches nothing, which
 * is what the library scan and the `loom://` handler use.
 */
export async function readBundle(
  dir: string,
  options: { upgrade: boolean; registry?: MigrationRegistry },
): Promise<OpenedBundle> {
  const registry = options.registry ?? defaultRegistry();
  const paths = bundlePaths(dir);
  const load = options.upgrade ? loadAndUpgradeDocument : loadDocument;

  const project = (await load(paths.project, 'loom.project', validateProjectDoc, registry)).doc;

  let recording: RecordingDoc | null = null;
  try {
    recording = (await load(paths.recording, 'loom.recording', validateRecordingDoc, registry)).doc;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const snapshot = (await load(paths.edit, 'loom.edit', validateEditDocument, registry)).doc;
  const journal = await readJournal(paths.journal, registry);
  // A header this build cannot read withholds every entry rather than refusing the
  // bundle: neither replaying them under v1 assumptions nor bricking the recording
  // is acceptable, so the snapshot is the recovery point and the caller is told.
  const replay = replayJournal(snapshot, journal.headerRejected ? [] : journal.entries);

  return {
    paths,
    project,
    recording,
    edit: replay.doc,
    replay,
    journalTorn: journal.torn,
    journalProblems: journal.problems.map((p) => `line ${String(p.line)}: ${p.reason}`),
    journalRejected: journal.headerRejected
      ? {
          reason:
            journal.problems[0]?.reason ?? `${BUNDLE.journal} has an unreadable schema header`,
          recoveredRevision: snapshot.revision,
        }
      : null,
  };
}

function isMissingFile(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  if (code === 'ENOENT') return true;
  const cause = (error as { cause?: unknown }).cause;
  return (
    cause !== null && typeof cause === 'object' && (cause as { code?: string }).code === 'ENOENT'
  );
}

/** Longest track end on the recording clock — the recording's real duration. */
export function recordingDuration(recording: RecordingDoc): Seconds | null {
  let end: number | null = null;
  const tracks: (VideoTrackDoc | AudioTrackDoc | undefined)[] = [
    recording.tracks.screen,
    recording.tracks.webcam,
    recording.tracks.mic,
    recording.tracks.system,
  ];
  for (const track of tracks) {
    if (track === undefined) continue;
    for (const part of track.parts) {
      const partEnd = part.startTimeSec + part.durationSec;
      if (end === null || partEnd > end) end = partEnd;
    }
  }
  return end;
}

/**
 * Summarize one bundle for the library list.
 *
 * A bundle that cannot be read is reported as unreadable rather than thrown away.
 * The user can see the directory in Finder; hiding it from the app would be the
 * app lying about what is on their disk.
 */
export async function summarizeBundle(
  dir: string,
  registry: MigrationRegistry = defaultRegistry(),
): Promise<RecordingSummary> {
  const paths = bundlePaths(dir);
  try {
    const { doc: project } = await loadDocument(
      paths.project,
      'loom.project',
      validateProjectDoc,
      registry,
    );

    let durationSec: Seconds | null = null;
    try {
      const { doc: recording } = await loadDocument(
        paths.recording,
        'loom.recording',
        validateRecordingDoc,
        registry,
      );
      durationSec = recordingDuration(recording);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const lastExport = project.exports.at(-1);
    return {
      id: project.id,
      path: dir,
      name: project.name,
      createdAt: project.createdAt,
      modifiedAt: project.modifiedAt,
      state: project.state,
      sizeBytes: project.sizeBytes,
      durationSec,
      exportPath: lastExport?.path ?? null,
      sourcesDeleted: project.retention !== undefined,
    };
  } catch (error) {
    const stats = await stat(dir).catch(() => null);
    const at = (stats?.mtime ?? new Date()).toISOString();
    return {
      id: dir,
      path: dir,
      name: basenameWithoutExtension(dir),
      createdAt: at,
      modifiedAt: at,
      state: 'failed',
      sizeBytes: 0,
      durationSec: null,
      exportPath: null,
      sourcesDeleted: false,
      unreadable: error instanceof Error ? error.message : String(error),
    };
  }
}

function basenameWithoutExtension(dir: string): string {
  const base = dir.split('/').pop() ?? dir;
  return base.replace(/\.loomrec$/, '');
}

/**
 * Every bundle under a recordings root, newest first.
 *
 * A missing root is an empty library, not an error: the app has simply never
 * recorded anything.
 */
export async function listBundles(
  root: string,
  registry: MigrationRegistry = defaultRegistry(),
): Promise<RecordingSummary[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && isBundleDirName(e.name))
    .map((e) => join(root, e.name));

  const summaries = await Promise.all(dirs.map((dir) => summarizeBundle(dir, registry)));
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Total bytes on disk under a directory. Follows no symlinks. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
    } else if (entry.isFile()) {
      const stats = await stat(path).catch(() => null);
      if (stats !== null) total += stats.size;
    }
  }
  return total;
}

/**
 * Widens the deletion window so a `SIGKILL` can be aimed inside it.
 *
 * The same bargain — and the same justification — as {@link WriteAtomicPacing}: set
 * only by `apps/main/test/retention-crash.test.ts`, so that test can kill *this*
 * function part-way through rather than a copy of it. A harness that re-implemented
 * the loop would keep passing after a regression here, and the regression here costs
 * the user their footage. Production callers pass nothing.
 */
export interface DeleteSourcesPacing {
  /** Awaited after each entry is unlinked, with the path that went. */
  betweenEntries?: (path: string) => Promise<void>;
}

/**
 * `null` for the one error that means "already deleted"; everything else is raised.
 *
 * The distinction is the whole of §7.5's crash story. `ENOENT` is the state a
 * previous run left and the reason this function is idempotent. Any *other* failure
 * to read or sync a directory — `EACCES`, `EIO`, `ENOTDIR`, `EMFILE` — means the
 * sources may still be there, and swallowing it reports an emptied bundle to a caller
 * whose next act is `state: "exported"`. That is the one end state the ordering
 * exists to make impossible, and it is unrecoverable: `listInterruptedRetention`
 * skips an `exported` recording, so no later launch would ever look at it again.
 */
function missingIsFine(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw error;
}

/**
 * Unlink the raw sources of one bundle. Architecture report §7.5, step 2.
 *
 * The captain's retention decision deletes the user's **only** copy of their raw
 * footage, so three properties are structural rather than incidental:
 *
 * - **It takes the directory names it is given** — `RETENTION_SOURCE_DIRECTORIES`,
 *   which is §7.5's `media/` and `events/` — and resolves each one against
 *   {@link BundlePaths}. There is no path argument and no recursion out of the
 *   bundle: the worst a wrong caller can do is name a directory of this bundle.
 * - **The directories survive their contents.** The §2.1 layout stays valid at every
 *   instant, so a bundle interrupted here is a bundle with empty `media/` rather
 *   than one missing a directory the next read expects.
 * - **It is idempotent**, because the crash story is "the next launch finishes it":
 *   a second run over an already-emptied bundle removes nothing and reports nothing,
 *   rather than failing on the files the first run took.
 *
 * Each directory is `fsync`'d after its entries go. `rename(2)` is not durable
 * without a directory sync and neither is `unlink(2)`; without this, `state:
 * "exported"` could reach the disk while the media it claims to have deleted comes
 * back, which is the one end state §7.5's ordering exists to make impossible.
 *
 * Only a missing directory is tolerated — see {@link missingIsFine}. Anything else
 * is raised, so a deletion that could not happen reaches the caller as a failure
 * rather than as a success it will act on.
 */
export async function deleteBundleSources(
  paths: BundlePaths,
  directories: readonly ('media' | 'events' | 'cursors' | 'thumbs')[],
  pacing: DeleteSourcesPacing = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of directories) {
    const dir = paths[name];
    const entries = await readdir(dir, { withFileTypes: true }).catch(missingIsFine);
    // A directory that is not there is a deletion that already happened, not an
    // error: this runs again after a crash, on purpose.
    if (entries === null) continue;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      await rm(path, { recursive: true, force: true });
      removed.push(path);
      if (pacing.betweenEntries !== undefined) await pacing.betweenEntries(path);
    }
    const handle = await open(dir, 'r').catch(missingIsFine);
    if (handle !== null) {
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  return removed;
}

/**
 * Delete temp files left behind by a writer that was killed.
 *
 * Safe only while holding the bundle lock, which is why `ProjectStore` calls it
 * immediately after acquiring one: with the lock held, no other writer exists, so
 * every `.tmp-*` in the bundle is by definition abandoned.
 */
export async function sweepTempArtifacts(dir: string): Promise<string[]> {
  const swept: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      swept.push(...(await sweepTempArtifacts(path)));
    } else if (entry.isFile() && isTempArtifact(entry.name)) {
      await rm(path, { force: true });
      swept.push(path);
    }
  }
  return swept;
}
