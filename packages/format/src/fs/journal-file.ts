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

import { open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { currentSchemaId } from '../schema.ts';
import { parseJournal, type JournalParseResult } from '../journal/replay.ts';
import type { EditOp, JournalEntry } from '../journal/ops.ts';
import { type MigrationRegistry, defaultRegistry } from '../migrate/registry.ts';
import { isoTimestamp } from '../defaults.ts';

/** The header line written when a journal is created or truncated. */
export function journalHeaderLine(): string {
  return `${JSON.stringify({ schema: currentSchemaId('loom.journal') })}\n`;
}

function entryLine(entry: JournalEntry): string {
  return `${JSON.stringify(entry)}\n`;
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

  /** Open the journal for appending, writing the header if the file is new. */
  async open(): Promise<void> {
    if (this.handle !== null) return;
    // 'a' creates if missing and every write goes to the end, regardless of any
    // other handle's position.
    const handle = await open(this.path, 'a', 0o644);
    const { size } = await handle.stat();
    if (size === 0) {
      await handle.write(Buffer.from(journalHeaderLine(), 'utf8'));
      this.dirty = true;
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
      return { header: null, entries: [], torn: false, problems: [] };
    }
    throw error;
  }
  return parseJournal(text, registry);
}

/** Remove the journal entirely. Used when a bundle is closed cleanly. */
export async function removeJournal(path: string): Promise<void> {
  await rm(path, { force: true });
}
