/**
 * The append-only event logs — `events/cursor.ndjson`, `events/clicks.ndjson`,
 * `events/drawing.ndjson`. Architecture report §2.5.
 *
 * The same three properties `JournalWriter` has, for the same reasons: one
 * `write(2)` per flush on an `O_APPEND` handle, the newline written with the line it
 * terminates, and `fsync` on the caller's cadence. §2.5 specifies that cadence:
 * appended every 100 ms and `fsync`'d every second, so a crash costs at most one
 * second of cursor data.
 *
 * Where this differs from the journal, and why:
 *
 * - **No schema header.** §2.5 shows a cursor log whose first line is a cursor
 *   sample. These files are not documents; they are streams of one event shape,
 *   versioned by the `recording.json` that points at them. Inventing a header line
 *   here would put bytes in a file whose exact contents the report specifies.
 *
 * - **Creating the file is an explicit act.** `create()` exists, and nothing else
 *   creates the file except the first `append`. This is the mechanism behind the
 *   phase-5 gate: *no empty `clicks.ndjson`*. Three states, three meanings:
 *
 *   | on disk           | means                                          |
 *   | ----------------- | ---------------------------------------------- |
 *   | absent            | clicks were never captured — check `available`  |
 *   | present, empty    | clicks *were* captured; the user made none      |
 *   | present, lines    | clicks were captured, and here they are         |
 *
 *   Phase 10's auto-zoom has to tell the first from the second, and a writer that
 *   creates its file at open time collapses them. So opening a log costs nothing and
 *   the caller says, in one place, when a log has become a claim.
 */

import { open, type FileHandle } from 'node:fs/promises';

/**
 * An open append handle on one event log.
 *
 * Held for the lifetime of a recording by `ProjectStore`, which is the only thing
 * allowed to construct one.
 */
export class EventLogWriter {
  private readonly path: string;
  private handle: FileHandle | null = null;
  private dirty = false;
  private lines = 0;
  private closed = false;

  constructor(path: string) {
    this.path = path;
  }

  /** True once the file exists on disk. */
  get created(): boolean {
    return this.handle !== null || this.lines > 0;
  }

  /** Lines this writer has appended. The honest denominator for "how many events". */
  get lineCount(): number {
    return this.lines;
  }

  /**
   * Create the file, empty.
   *
   * Called when a log stops being a possibility and becomes a claim: the click tap
   * came up live, so "no clicks in this recording" is now a fact worth asserting
   * rather than an absence of evidence.
   */
  async create(): Promise<void> {
    if (this.closed) throw new Error(`event log is closed: ${this.path}`);
    this.handle ??= await open(this.path, 'a', 0o644);
  }

  /**
   * Append newline-terminated NDJSON.
   *
   * The caller batches; this writes what it is given in one call, so a crash can
   * truncate the tail of the file but cannot interleave a half-line into the middle
   * of it. A chunk that does not end in a newline is rejected rather than written,
   * because the next append would weld two events into one unparseable line.
   */
  async append(ndjson: string): Promise<void> {
    if (ndjson.length === 0) return;
    if (this.closed) throw new Error(`event log is closed: ${this.path}`);
    if (!ndjson.endsWith('\n')) {
      throw new Error(`refusing to append a chunk with no line terminator: ${this.path}`);
    }
    this.handle ??= await open(this.path, 'a', 0o644);
    await this.handle.write(Buffer.from(ndjson, 'utf8'));
    this.dirty = true;
    // Counted from the bytes actually accepted, so the count cannot drift from the
    // file. `ndjson` ends in a newline, so this is exactly the number of lines.
    for (let i = 0; i < ndjson.length; i += 1) if (ndjson.charCodeAt(i) === 0x0a) this.lines += 1;
  }

  /** Flush to the filesystem. §2.5's cadence is one second; the caller owns the timer. */
  async sync(): Promise<void> {
    if (this.handle === null || !this.dirty) return;
    await this.handle.sync();
    this.dirty = false;
  }

  async close(): Promise<void> {
    this.closed = true;
    const handle = this.handle;
    if (handle === null) return;
    this.handle = null;
    try {
      if (this.dirty) await handle.sync();
    } finally {
      await handle.close();
    }
    this.dirty = false;
  }
}
