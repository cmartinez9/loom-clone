/**
 * The editor's undo/redo stack.
 *
 * §2.7: *"Undo/redo is the inverse-op stack in the editor; crash-safety is the
 * journal in main."* This is that stack, and it deliberately does **not** talk to
 * main: it holds the in-memory `EditDocument` the editor is showing, applies ops to
 * it optimistically, and hands the caller the exact ops to send. Main is still the
 * only writer (§0, rule 2); this is the "renderers propose" half.
 *
 * ## Why undo produces ops rather than a document
 *
 * Sending a document would need main to trust a renderer's whole edit state, and
 * would give a crash-recovery journal nothing to replay. Sending the inverse ops
 * means an undo is journalled, revisioned, validated and crash-safe on exactly the
 * same path as the edit it reverses — no second code path, and therefore no second
 * set of bugs.
 *
 * ## Revisions and conflicts
 *
 * Every `apply` advances the local revision by one per op, matching `applyOps` in
 * `@loom/format` and the revision main will report back. When main answers with a
 * `{ conflict }` — two windows on one project (§2.7) — the editor reloads, and
 * {@link EditHistory.reset} is how: the document is replaced and the stacks are
 * cleared, because an inverse computed against a document that no longer exists
 * would undo to a state that never did.
 */

import { applyOps, type EditDocument, type EditOp } from '@loom/format';
import { inverseOps } from './inverse.ts';

/** One undoable step: what was sent, and what would take it back. */
export interface HistoryEntry {
  ops: readonly EditOp[];
  inverse: readonly EditOp[];
  /** Revision *before* the step. Undoing returns the document to it. */
  baseRevision: number;
  /** A short label for the UI, if the caller gave one. */
  label?: string;
}

/** What the caller must send to main, and the document to show meanwhile. */
export interface HistoryResult {
  document: EditDocument;
  ops: readonly EditOp[];
  /** The revision the ops were computed against — `applyOps`'s `baseRevision`. */
  baseRevision: number;
}

export interface EditHistoryOptions {
  /** How many steps to keep. Older ones fall off the bottom. */
  limit?: number;
}

/** Deep enough that no session hits it; small enough that no session grows without bound. */
export const DEFAULT_HISTORY_LIMIT = 500;

export class EditHistory {
  #document: EditDocument;
  readonly #undo: HistoryEntry[] = [];
  readonly #redo: HistoryEntry[] = [];
  readonly #limit: number;

  constructor(document: EditDocument, options: EditHistoryOptions = {}) {
    this.#document = document;
    this.#limit = Math.max(1, options.limit ?? DEFAULT_HISTORY_LIMIT);
  }

  get document(): EditDocument {
    return this.#document;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get depth(): { undo: number; redo: number } {
    return { undo: this.#undo.length, redo: this.#redo.length };
  }

  /**
   * Apply a batch and record how to take it back.
   *
   * The inverse is computed against the document *before* the batch, which is the
   * only moment the old values still exist. A batch that cannot apply throws from
   * `applyOps` and leaves both the document and the stacks untouched — a rejected
   * batch must never half-land, on either side.
   */
  apply(ops: readonly EditOp[], label?: string): HistoryResult {
    const baseRevision = this.#document.revision;
    if (ops.length === 0) {
      return { document: this.#document, ops, baseRevision };
    }
    const inverse = inverseOps(this.#document, ops);
    const next = applyOps(this.#document, ops);
    this.#document = next;
    this.#push(this.#undo, {
      ops: [...ops],
      inverse,
      baseRevision,
      ...(label === undefined ? {} : { label }),
    });
    // A new edit invalidates the redo branch. Anything else is a tree, and a tree
    // is not what a person means by "redo".
    this.#redo.length = 0;
    return { document: next, ops, baseRevision };
  }

  /** Undo one step, or `null` when there is nothing to undo. */
  undo(): HistoryResult | null {
    const entry = this.#undo.pop();
    if (entry === undefined) return null;
    const baseRevision = this.#document.revision;
    // Re-derive the redo op from the document as it stands, so a redo restores what
    // the undo actually removed rather than what the original batch happened to say.
    const redoOps = inverseOps(this.#document, entry.inverse);
    this.#document = applyOps(this.#document, entry.inverse);
    this.#push(this.#redo, {
      ops: entry.inverse,
      inverse: redoOps,
      baseRevision,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    });
    return { document: this.#document, ops: entry.inverse, baseRevision };
  }

  /** Redo one step, or `null` when there is nothing to redo. */
  redo(): HistoryResult | null {
    const entry = this.#redo.pop();
    if (entry === undefined) return null;
    const baseRevision = this.#document.revision;
    const undoOps = inverseOps(this.#document, entry.inverse);
    this.#document = applyOps(this.#document, entry.inverse);
    this.#push(this.#undo, {
      ops: entry.inverse,
      inverse: undoOps,
      baseRevision,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    });
    return { document: this.#document, ops: entry.inverse, baseRevision };
  }

  /**
   * Replace the document and drop both stacks.
   *
   * For the `{ conflict }` reload in §2.7, and for opening a different recording.
   * Keeping the stacks across either would let an undo apply an op computed against
   * a document that is gone.
   */
  reset(document: EditDocument): void {
    this.#document = document;
    this.#undo.length = 0;
    this.#redo.length = 0;
  }

  #push(stack: HistoryEntry[], entry: HistoryEntry): void {
    stack.push(entry);
    if (stack.length > this.#limit) stack.splice(0, stack.length - this.#limit);
  }
}
