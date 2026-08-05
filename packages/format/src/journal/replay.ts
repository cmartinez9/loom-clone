/**
 * Parsing and replaying `edit.journal.ndjson`. Pure — the caller supplies the text.
 *
 * The crash property this file exists to deliver: **a journal that was being
 * appended to when the process died still replays everything that was fully
 * written.** Two rules make that true and both are load-bearing.
 *
 * 1. *The writer always terminates a line with `\n`.* Therefore a final chunk with
 *    no newline is a torn append, and is discarded rather than parsed. This is why
 *    `appendJournalEntries` writes the newline as part of the same buffer.
 * 2. *Replay stops at the first gap or bad line and keeps everything before it.*
 *    A journal is a write-ahead log; a hole in it means the tail is not trustworthy,
 *    and applying past a hole would silently reorder a user's edits.
 *
 * §2.7's *"**Never** silently accept an unknown schema"* holds here too: a journal
 * whose header names a version this build does not understand yields no entries at
 * all, because replaying its lines under v1 assumptions is exactly the guessing the
 * rule forbids. Where the journal differs from every other file in a bundle is what
 * the caller does with that: `readBundle` reports it as `journalRejected` and opens
 * from `edit.json` alone rather than refusing, because a header this build cannot
 * read must not make a recording permanently unopenable.
 */

import { migrateDocument, type MigrationRegistry, defaultRegistry } from '../migrate/registry.ts';
import type { EditDocument } from '../types/edit.ts';
import { applyOpInPlace, OpApplyError } from './apply.ts';
import { isEditOp, type JournalEntry, type JournalHeader } from './ops.ts';

export interface JournalLineProblem {
  /** 1-based line number within the file. */
  line: number;
  reason: string;
}

export interface JournalParseResult {
  header: JournalHeader | null;
  entries: JournalEntry[];
  /**
   * True when the file ended mid-line — the expected shape of a crash during an
   * append. The partial line is discarded; everything before it is intact.
   */
  torn: boolean;
  /** Lines that were complete but unparseable. Real corruption, not a crash. */
  problems: JournalLineProblem[];
  /**
   * True when a complete first line was present but is not a header this build
   * understands — an unknown family, or a version from the future.
   *
   * `entries` is then empty by construction: the reason for the refusal is that we
   * do not know what the following lines mean. A journal torn mid-header does *not*
   * set this; it has no complete first line and therefore no entries either.
   */
  headerRejected: boolean;
}

/**
 * Parse journal text.
 *
 * An empty file (or one containing only a header) is a normal, healthy state: the
 * store truncates the journal every time it writes an `edit.json` snapshot.
 */
export function parseJournal(
  text: string,
  registry: MigrationRegistry = defaultRegistry(),
): JournalParseResult {
  const result: JournalParseResult = {
    header: null,
    entries: [],
    torn: false,
    problems: [],
    headerRejected: false,
  };
  if (text.length === 0) return result;

  const chunks = text.split('\n');
  // `split` leaves a trailing '' when the text ends with a newline. Anything else
  // in that slot is a partially written line.
  const trailing = chunks.pop() ?? '';
  if (trailing.length > 0) result.torn = true;

  // The header is the first line with anything on it, not line index 0. Keying it
  // on the index would let a journal that starts with a stray newline skip the
  // schema check entirely and replay its entries unverified.
  let headerSeen = false;

  for (const [i, raw] of chunks.entries()) {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.problems.push({ line: lineNo, reason: 'not valid JSON' });
      if (!headerSeen) {
        // Without a readable header there is no schema, and no schema means no
        // basis for reading anything after it.
        result.headerRejected = true;
        return result;
      }
      continue;
    }

    if (!headerSeen) {
      headerSeen = true;
      try {
        const outcome = migrateDocument(registry, 'loom.journal', parsed);
        result.header = outcome.doc as unknown as JournalHeader;
      } catch (error) {
        result.problems.push({
          line: lineNo,
          reason: error instanceof Error ? error.message : String(error),
        });
        // Stop here rather than replaying a newer build's entries under this
        // build's assumptions — §2.7's "refuse to open and say so".
        result.headerRejected = true;
        return result;
      }
      continue;
    }

    const problem = readEntry(parsed);
    if (typeof problem === 'string') result.problems.push({ line: lineNo, reason: problem });
    else result.entries.push(problem);
  }

  return result;
}

/** Returns the entry, or a string describing why the line is not one. */
function readEntry(value: unknown): JournalEntry | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'expected an object';
  }
  const o = value as Record<string, unknown>;
  const revision = o['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return 'revision must be a positive integer';
  }
  if (typeof o['at'] !== 'string') return 'at must be a timestamp string';
  if (!isEditOp(o['op'])) return 'op is not a recognised edit operation';
  return { revision, at: o['at'], op: o['op'] };
}

export interface ReplayResult {
  doc: EditDocument;
  /** Number of ops applied. */
  applied: number;
  /** Entries at or below the snapshot's revision — already in `edit.json`. */
  skipped: number;
  /**
   * Why replay stopped early, if it did. `null` means the whole journal replayed.
   * The document is still usable in either case; this is what the editor shows the
   * user as "restored unsaved changes, except…".
   */
  stoppedAt: { revision: number; reason: string } | null;
}

/**
 * Replay journal entries onto a snapshot.
 *
 * Architecture report §2.7: *"On load: read `edit.json`, replay any journal entries
 * with `revision > edit.json.revision`."* Entries must be contiguous from the
 * snapshot's revision; a gap means an op was lost and everything after it is
 * suspect, so replay stops there rather than reordering the user's edits.
 */
export function replayJournal(
  snapshot: EditDocument,
  entries: readonly JournalEntry[],
): ReplayResult {
  const doc = structuredClone(snapshot);
  let applied = 0;
  let skipped = 0;

  const ordered = [...entries].sort((a, b) => a.revision - b.revision);

  for (const entry of ordered) {
    if (entry.revision <= doc.revision) {
      skipped++;
      continue;
    }
    if (entry.revision !== doc.revision + 1) {
      return {
        doc,
        applied,
        skipped,
        stoppedAt: {
          revision: entry.revision,
          reason:
            `journal jumps from revision ${String(doc.revision)} to ` +
            `${String(entry.revision)}; entries in between were not written`,
        },
      };
    }
    try {
      applyOpInPlace(doc, entry.op);
    } catch (error) {
      const reason =
        error instanceof OpApplyError
          ? `${entry.op.op} could not be applied: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      return { doc, applied, skipped, stoppedAt: { revision: entry.revision, reason } };
    }
    doc.revision = entry.revision;
    applied++;
  }

  return { doc, applied, skipped, stoppedAt: null };
}
