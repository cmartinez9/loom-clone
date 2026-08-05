/**
 * `edit.journal.ndjson` on disk.
 *
 * The append side of architecture report §2.7. Three properties, all deliberate:
 *
 * 1. **One `write(2)` per flush.** Every entry in a batch is serialized into a
 *    single buffer, newline-terminated, and appended with one call on an `O_APPEND`
 *    handle. A crash can therefore truncate the tail of the file but cannot
 *    interleave a half-entry into the middle of it.
 * 2. **The newline is part of the buffer.** `parseJournal` treats a final chunk
 *    with no newline as a torn append and discards it; that rule is only sound
 *    because a line and its terminator are written together.
 * 3. **`fsync` is the caller's cadence.** The report specifies batched fsync at
 *    250 ms; the store owns the timer, this module owns the syscall.
 */

import { open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { currentSchemaId, parseSchemaId } from '../schema.ts';
import { backupPath } from '../bundle/layout.ts';
import { parseJournal, type JournalParseResult } from '../journal/replay.ts';
import type { EditOp, JournalEntry } from '../journal/ops.ts';
import { type MigrationRegistry, defaultRegistry } from '../migrate/registry.ts';
import { isoTimestamp } from '../defaults.ts';

const NEWLINE = 0x0a;

/** The header line written when a journal is created or truncated. */
export function journalHeaderLine(): string {
  return `${JSON.stringify({ schema: currentSchemaId('loom.journal') })}\n`;
}

function entryLine(entry: JournalEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * Where a journal this build refuses to read is kept when it is replaced.
 *
 * Same convention as a migration's `edit.json.v1.bak` (§2.7, and
 * `loadAndUpgradeDocument`): the original is renamed aside rather than overwritten,
 * so the build that wrote it can still read its own bytes. A header with no
 * parseable schema id has no version to name it by, so it gets the one name that
 * is honest about that.
 */
function preservedPathFor(path: string, text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return `${path}.unreadable.bak`;
  }
  const schema =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parseSchemaId((parsed as Record<string, unknown>)['schema'])
      : null;
  return schema === null ? `${path}.unreadable.bak` : backupPath(path, schema.version);
}

async function preserveRejectedJournal(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rename(path, preservedPathFor(path, text));
}

export interface JournalOpenOptions {
  /**
   * Set when `readBundle` reported `journalRejected` for this file.
   *
   * The reader withheld every entry in it, so the writer must not append to it
   * either: an op appended under a header this build rejects is an op the next read
   * withholds too, which would leave a degraded-open project with no write-ahead log
   * at all. The rejected bytes are preserved beside the bundle and a fresh journal
   * at this build's version takes their place, so crash-safety is live from the
   * first op rather than from the next snapshot.
   */
  headerRejected?: boolean;
}

/**
 * An open append handle on one bundle's journal.
 *
 * Held for the lifetime of an open project by `ProjectStore`, which is the only
 * thing allowed to construct one — reopening per append would make the ordering
 * guarantee depend on the filesystem rather than on the handle.
 */
export class JournalWriter {
  private readonly path: string;
  private handle: FileHandle | null = null;
  private dirty = false;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Open the journal for appending, writing the header if the file is new,
   * repairing a torn tail if the last append did not finish, and replacing the file
   * entirely — original preserved — if the reader rejected its schema header.
   *
   * The repair is what keeps property 2 above true across a crash. A killed writer
   * leaves a final line with no terminator; appending onto it would weld the next
   * entry to the torn one and produce a single unparseable line, so the *new*
   * entry — fully and durably written — would be discarded on the following read.
   * Truncating back to the last newline first means every append starts on a line
   * boundary, and "a final chunk with no newline is a torn append" stays a rule
   * about one line rather than about two.
   */
  async open(options: JournalOpenOptions = {}): Promise<void> {
    if (this.handle !== null) return;
    if (options.headerRejected === true) await preserveRejectedJournal(this.path);
    // 'a' creates if missing and every write goes to the end, regardless of any
    // other handle's position.
    const handle = await open(this.path, 'a', 0o644);
    const { size } = await handle.stat();
    if (size === 0) {
      await handle.write(Buffer.from(journalHeaderLine(), 'utf8'));
      this.dirty = true;
    } else {
      const existing = await readFile(this.path);
      if (existing.at(-1) !== NEWLINE) {
        // `lastIndexOf` of -1 means not one line survived — the header itself was
        // torn — so there is nothing to keep and the file starts again.
        const keep = existing.lastIndexOf(NEWLINE) + 1;
        await handle.truncate(keep);
        if (keep === 0) await handle.write(Buffer.from(journalHeaderLine(), 'utf8'));
        await handle.sync();
      }
    }
    this.handle = handle;
  }

  /**
   * Append one entry per op, numbering revisions from `baseRevision + 1`.
   *
   * Returns the revision after the last op — the value `applyOps` reports back to
   * the editor.
   */
  async append(ops: readonly EditOp[], baseRevision: number): Promise<number> {
    const handle = this.handle;
    if (handle === null) throw new Error('journal is not open');
    if (ops.length === 0) return baseRevision;

    const at = isoTimestamp();
    let revision = baseRevision;
    let buffer = '';
    for (const op of ops) {
      revision += 1;
      buffer += entryLine({ revision, at, op });
    }
    await handle.write(Buffer.from(buffer, 'utf8'));
    this.dirty = true;
    return revision;
  }

  /** Flush to the filesystem. The store calls this on its 250 ms cadence. */
  async sync(): Promise<void> {
    const handle = this.handle;
    if (handle === null || !this.dirty) return;
    await handle.sync();
    this.dirty = false;
  }

  /**
   * Drop every entry and start again from the header.
   *
   * Called immediately after an `edit.json` snapshot lands, because the snapshot
   * now contains everything the journal did. Truncation happens on the open
   * handle, so no other process can slip a write in between.
   */
  async truncate(): Promise<void> {
    // Capture the handle: `close()` may run while this is awaiting, and reading
    // `this.handle` again afterwards would be a null dereference rather than the
    // clear "journal is not open" a caller can act on.
    const handle = this.handle;
    if (handle === null) throw new Error('journal is not open');
    await handle.truncate(0);
    await handle.write(Buffer.from(journalHeaderLine(), 'utf8'), 0);
    await handle.sync();
    this.dirty = false;
  }

  async close(): Promise<void> {
    if (this.handle === null) return;
    const handle = this.handle;
    this.handle = null;
    try {
      if (this.dirty) await handle.sync();
    } finally {
      await handle.close();
    }
    this.dirty = false;
  }
}

/**
 * Read and parse a journal file.
 *
 * A missing journal is a normal state — it means the last snapshot was clean — and
 * is reported as an empty parse rather than an error.
 */
export async function readJournal(
  path: string,
  registry: MigrationRegistry = defaultRegistry(),
): Promise<JournalParseResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { header: null, entries: [], torn: false, problems: [], headerRejected: false };
    }
    throw error;
  }
  return parseJournal(text, registry);
}

/** Remove the journal entirely. Used when a bundle is closed cleanly. */
export async function removeJournal(path: string): Promise<void> {
  await rm(path, { force: true });
}
