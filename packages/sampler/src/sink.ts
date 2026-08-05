/**
 * Where a sampled event actually lands.
 *
 * The sampler does not write to disk and cannot be made to. Architecture report §0,
 * rule 2 — *"Main is the only writer"* — is enforced structurally in this codebase
 * (`eslint.config.mjs` restricts `node:fs` and `@loom/format/fs` to
 * `ProjectStore`), and a package that spawns a child process and produces tens of
 * thousands of lines a minute is exactly the kind of thing that would quietly become
 * a second writer. So it is handed a sink instead, and `apps/main` implements that
 * sink on top of `ProjectStore`'s per-project write queue.
 *
 * The secondary benefit is that the phase-5 acceptance gate — *no empty
 * `clicks.ndjson`* — is checkable against a real bundle directory *and* against an
 * in-memory sink, and both check the same code path.
 */

import type { CursorIndexDoc, EventLogKind } from '@loom/format';

export interface EventLogSink {
  /**
   * Make a log exist, empty.
   *
   * Called exactly once per log, at the moment that log stops being a possibility
   * and becomes a claim — for clicks, when the tap is confirmed live. Never called
   * speculatively: an empty `clicks.ndjson` asserts "we were watching and nothing
   * happened", which on a machine without the Accessibility grant would be a lie.
   */
  create(log: EventLogKind): Promise<void>;

  /** Append newline-terminated NDJSON. Creates the log if it does not exist yet. */
  append(log: EventLogKind, ndjson: string): Promise<void>;

  /** `fsync`. §2.5's cadence is one second, so a crash costs at most that. */
  sync(log: EventLogKind): Promise<void>;

  /** Store a content-addressed cursor bitmap at `cursors/<sha256>.png`. */
  writeCursorImage(sha256: string, png: Uint8Array): Promise<void>;

  /** Replace `cursors/index.json`. Rewritten whenever a new shape appears. */
  writeCursorIndex(doc: CursorIndexDoc): Promise<void>;
}
