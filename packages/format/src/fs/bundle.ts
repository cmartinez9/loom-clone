/**
 * Creating, scanning and reading `.loomrec` bundles.
 *
 * The layout itself is `bundle/layout.ts`, which is pure. This module is the part
 * that touches a disk, and it is imported only by the main process.
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
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
import { MigrationError, type MigrationRegistry, defaultRegistry } from '../migrate/registry.ts';
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
  // The journal is the one file whose schema check used to be advisory: its header
  // problem was recorded and its entries replayed anyway. It refuses like every
  // other document now — opening the bundle and *silently* dropping the tail of the
  // user's edits would be the worse of the two failures.
  if (journal.headerRejected) {
    throw new MigrationError(
      'unknown-schema',
      `refusing to open: ${BUNDLE.journal} could not be read — ` +
        (journal.problems[0]?.reason ?? 'its schema header is unreadable'),
      paths.journal,
    );
  }
  const replay = replayJournal(snapshot, journal.entries);

  return {
    paths,
    project,
    recording,
    edit: replay.doc,
    replay,
    journalTorn: journal.torn,
    journalProblems: journal.problems.map((p) => `line ${String(p.line)}: ${p.reason}`),
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
