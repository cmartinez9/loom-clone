/**
 * The editor's view of one project: the document, the compiled timeline, and the
 * one path an edit takes to disk.
 *
 * §2.7, and the shape it prescribes: *"The editor holds the `EditDocument` in
 * memory and sends **ops**, not documents."* So this holds an {@link EditHistory} —
 * phase 7's inverse-op stack — applies each batch to the in-memory document
 * optimistically, recompiles, and hands main the same ops. Undo sends the inverse
 * ops down the identical path, which is what makes an undo journalled, revisioned
 * and crash-safe without a second code path (§2.7 again).
 *
 * ## Everything is serialized, because `baseRevision` is not advisory
 *
 * `applyOps` refuses a batch whose `baseRevision` is not the document's, and answers
 * with the authoritative document instead. Two batches in flight at once would both
 * be computed against revision *n* and the second would come back as a conflict —
 * of the editor with itself, which is not what §2.7's conflict is for. So sends go
 * out one at a time on {@link EditorProject.#chain}. A real conflict then means what
 * it is supposed to mean: two windows on one project.
 *
 * ## Recompiling
 *
 * §3.6: *"`compile` is called on load and on any op that changes a spring channel
 * (debounced 100 ms)."* A trim changes no spring channel, but it does change the
 * clip list, and a compile still walks every track and rebuilds every spring table.
 * A pointer dragging a handle produces one of those per pointer event, so
 * {@link EditorProject.preview} debounces on §3.6's own 100 ms and every committed
 * edit recompiles immediately. The handle itself is drawn at pointer rate from the
 * provisional value — nothing about the *input* is debounced.
 */

import { compile, sourceDurationSec, EditHistory, type CompiledTimeline } from '@loom/edl';
import type { Seconds } from '@loom/format';
import { isConflict, type EditDocument, type EditOp, type RecordingDoc } from '@loom/ipc';

/** §3.6's debounce, and this module uses it for the reason §3.6 gives. */
export const COMPILE_DEBOUNCE_MS = 100;

export interface EditorProjectOptions {
  id: string;
  recording: RecordingDoc | null;
  edit: EditDocument;
  /** `window.loom.project`, injected so this module is testable without a preload. */
  api: {
    applyOps: (
      id: string,
      ops: EditOp[],
      baseRevision: number,
    ) => Promise<{ revision: number } | { conflict: EditDocument }>;
  };
  /** Called whenever the document or the compiled timeline changed. */
  onChange: () => void;
  /** Called when a write failed, or another window won a conflict. */
  onTrouble: (message: string) => void;
}

export type SaveState = 'saved' | 'saving' | 'failed';

export class EditorProject {
  readonly id: string;
  readonly recording: RecordingDoc | null;
  /** Where the captured material ends, on the recording clock. `clips.ts` owns it. */
  readonly sourceDurationSec: Seconds;

  readonly #history: EditHistory;
  readonly #options: EditorProjectOptions;

  #compiled: CompiledTimeline;
  /** Set while a provisional document — a drag in progress — is being shown. */
  #provisional: EditDocument | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #chain: Promise<void> = Promise.resolve();
  #saveState: SaveState = 'saved';
  #inFlight = 0;
  /** An edit this window applied and could not write. See {@link EditorProject.#send}. */
  #lostAnEdit = false;

  constructor(options: EditorProjectOptions) {
    this.#options = options;
    this.id = options.id;
    this.recording = options.recording;
    this.sourceDurationSec = sourceDurationSec(options.recording);
    this.#history = new EditHistory(options.edit);
    this.#compiled = this.#compileOf(options.edit);
  }

  /** The document as the editor is showing it — provisional while a drag is live. */
  get document(): EditDocument {
    return this.#provisional ?? this.#history.document;
  }

  /** The document as it will be sent, ignoring any drag in progress. */
  get committed(): EditDocument {
    return this.#history.document;
  }

  get compiled(): CompiledTimeline {
    return this.#compiled;
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  get saveState(): SaveState {
    return this.#saveState;
  }

  /**
   * Show a document that has not been committed — the frame under a handle being
   * dragged.
   *
   * It is not in the history and it is never sent. `commit` replaces it with the
   * real edit, and {@link cancelPreview} throws it away; either way the authority is
   * the history's document, which is the only one that has a revision main agrees
   * with.
   */
  preview(document: EditDocument): void {
    this.#provisional = document;
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      this.#recompile();
    }, COMPILE_DEBOUNCE_MS);
    // The caller redraws now, at pointer rate; only the *compile* waits.
    this.#options.onChange();
  }

  /** Drop a provisional document and go back to what is committed. */
  cancelPreview(): void {
    if (this.#provisional === null) return;
    this.#provisional = null;
    this.#clearDebounce();
    this.#recompile();
  }

  /**
   * Apply a batch, recompile, and send it.
   *
   * Returns once the local state is updated; the send continues on the queue. That
   * is deliberate — the editor is responsive against its own document and reports
   * the write separately, which is what {@link SaveState} is for. An empty batch is
   * not an edit and is dropped before it can cost a revision.
   */
  commit(ops: readonly EditOp[], label: string): void {
    if (ops.length === 0) return;
    const result = this.#history.apply(ops, label);
    this.#provisional = null;
    this.#clearDebounce();
    this.#recompile();
    this.#send(result.ops, result.baseRevision);
  }

  undo(): boolean {
    const result = this.#history.undo();
    if (result === null) return false;
    this.#provisional = null;
    this.#clearDebounce();
    this.#recompile();
    this.#send(result.ops, result.baseRevision);
    return true;
  }

  redo(): boolean {
    const result = this.#history.redo();
    if (result === null) return false;
    this.#provisional = null;
    this.#clearDebounce();
    this.#recompile();
    this.#send(result.ops, result.baseRevision);
    return true;
  }

  /**
   * Send one batch, at the back of the queue.
   *
   * ## What a failed send leaves behind, and how it is repaired
   *
   * The editor applied the batch to its own document optimistically, so a send that
   * failed leaves the editor one revision **ahead** of disk with no way to get the
   * op there — a retry would be a second copy of the same edit, and there is no op
   * to send that reconciles a document with the one on disk. §2.7 already has the
   * answer for a document that has diverged and it is the conflict path: main
   * refuses the *next* batch (its revision no longer matches), hands back the
   * authoritative document, and the editor reloads onto it.
   *
   * So a failure is self-healing on the next edit rather than latched forever, and
   * {@link SaveState} is the last send's outcome rather than a memory. What is
   * remembered is only {@link EditorProject.#lostAnEdit}, so that when the reload
   * does arrive it says which of the two things happened — an edit of this window's
   * that could not be written, or another window (§2.7's actual case). Reporting
   * "another window changed this recording" for a disk error would send someone
   * looking for a second editor that does not exist.
   */
  #send(ops: readonly EditOp[], baseRevision: number): void {
    this.#inFlight += 1;
    if (this.#saveState !== 'failed') this.#setSaveState('saving');
    this.#chain = this.#chain.then(async () => {
      try {
        const result = await this.#options.api.applyOps(this.id, [...ops], baseRevision);
        if (isConflict(result)) {
          // The authoritative document comes back and the editor reloads rather
          // than merging. The stacks go with it — an inverse computed against a
          // document that no longer exists would undo to a state that never did,
          // which `EditHistory.reset` says in as many words.
          this.#history.reset(result.conflict);
          this.#provisional = null;
          const lost = this.#lostAnEdit;
          this.#lostAnEdit = false;
          this.#recompile();
          this.#options.onTrouble(
            lost
              ? 'An earlier change could not be saved, so the editor reloaded this ' +
                  'recording from disk. What you see now is what is saved.'
              : 'Another window changed this recording, so the editor reloaded it. ' +
                  'Your last change was not kept.',
          );
        }
        // A conflict counts as landed: the editor is now showing exactly what main
        // holds, which is the whole claim `saved` makes.
        this.#finishSend(true);
      } catch (error) {
        this.#lostAnEdit = true;
        this.#finishSend(false);
        this.#options.onTrouble(
          `This edit could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  /**
   * One send finished.
   *
   * `saved` only once nothing is outstanding, so a burst of edits does not flicker
   * between each pair of them.
   */
  #finishSend(landed: boolean): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (!landed) {
      this.#setSaveState('failed');
      return;
    }
    if (this.#inFlight === 0) this.#setSaveState('saved');
  }

  #setSaveState(state: SaveState): void {
    if (this.#saveState === state) return;
    this.#saveState = state;
    this.#options.onChange();
  }

  #clearDebounce(): void {
    if (this.#debounce === null) return;
    clearTimeout(this.#debounce);
    this.#debounce = null;
  }

  #recompile(): void {
    this.#compiled = this.#compileOf(this.document);
    this.#options.onChange();
  }

  /**
   * `compile` over the real recording, so the clip list has a source duration to
   * read an empty list against (`compileClips`: an empty list is the whole source,
   * and the only place a source length exists is `recording.json`).
   *
   * The cursor and click streams are `null`, and running a generator does not change
   * that: `generators.ts` reads `events/*.ndjson` itself and hands the streams
   * straight to `@loom/edl`, which answers with a track of ordinary keyframes that
   * lands in the document. What the context's streams feed is `ResolvedState.cursor`
   * — the cursor sprite, which no compositor pass draws yet (`Compositor.render`
   * refuses a `cursor` frame outright) — so a stream here would be read by nothing.
   */
  #compileOf(document: EditDocument): CompiledTimeline {
    return compile(document, { recording: this.recording, cursor: null, clicks: null });
  }
}
