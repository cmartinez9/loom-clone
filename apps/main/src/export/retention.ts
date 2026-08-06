/**
 * Phase 9 — the delete-after-export path.
 *
 * `data/loom-scope/decision-loom-storage-retention.md`: *"Delete them after export
 * to save disk."* The captain was shown the contradiction with his earlier "save
 * everything", asked twice, and confirmed. This file is the act, and everything in
 * it is arranged around the fact that **it deletes the user's only copy of their raw
 * footage**.
 *
 * ## Where the decision is, and where it is not
 *
 * The decision is `mayDeleteSources` in `@loom/format` — a predicate over the
 * `ExportRecord` that §7.5 requires the export to have written, which returns *every*
 * reason it says no. It is not here, and it is not re-derived here, because the
 * signal it reads is phase 8's: `verify.ts` answers §7.5's five checks off the bytes
 * on disk, in the process that wrote them. A second opinion about "is this file good"
 * would be a second thing to keep correct, and the wrong one would be the one that
 * deletes.
 *
 * Phase 8 already closed one hole in that signal — an export whose GL context was
 * lost mid-run could go on emitting chunks and produce a file of black frames that
 * passed every structural check — and the shape of that bug is why nothing here
 * infers success from "the job did not throw". A refusal is a *failed* export and
 * leaves the sources alone like any other failure.
 *
 * ## The ordering, and what a crash costs
 *
 * §7.5, verbatim: *"write `retention.sourcesDeletedAt` **first**, then unlink
 * `media/` and `events/`, then set `state: "exported"`. If we crash mid-delete, the
 * next launch sees a recording that has begun deletion and finishes it, rather than
 * one that looks editable but has half its media."*
 *
 * So the three steps are separate and their order is the property:
 *
 * | crash point | what is on disk | what the library says | what the next launch does |
 * | --- | --- | --- | --- |
 * | before step 1 | every source | `editable` | nothing — and that is correct |
 * | between 1 and 2 | every source | `editable`, sources marked going | finishes 2 and 3 |
 * | inside step 2 | some sources | `editable`, sources marked going | finishes 2 and 3 |
 * | between 2 and 3 | no sources | `editable`, sources marked going | finishes 2 and 3 |
 * | after step 3 | no sources | `exported` | nothing |
 *
 * There is no row in which the library says `exported` and the media is still there,
 * and none in which it says `editable` with nothing marked and the media is gone.
 * The reverse order produces both. `apps/main/test/retention-crash.test.ts` kills a
 * real process at each of those points and asserts exactly this table, with a
 * wrong-order control that must produce the forbidden state.
 *
 * ## Why a failure here does not fail the export
 *
 * The file is already written, verified, renamed and on the clipboard. A recording
 * whose sources could not be deleted is a recording that still works and a disk that
 * is fuller than it should be; reporting the export as failed would be false, and
 * `#run`'s failure path discards the output — it would take the user's finished
 * video away because a cleanup could not run. So {@link applyRetention} returns its
 * outcome instead of throwing, and the export carries it on `ExportResult`.
 */

import {
  RETENTION_SOURCE_DIRECTORIES,
  isoTimestamp,
  mayDeleteSources,
  newRetentionRecord,
} from '@loom/format';
import type { ExportRecord, RecordingId, RecordingSummary, RetentionRecord } from '@loom/format';

/** What {@link applyRetention} needs of `ProjectStore`. Satisfied structurally. */
export interface RetentionStore {
  recordRetention: (id: RecordingId, retention: RetentionRecord) => Promise<void>;
  deleteSources: (
    id: RecordingId,
    directories: readonly ('media' | 'events' | 'cursors' | 'thumbs')[],
    pacing?: { betweenEntries?: (path: string) => Promise<void> },
  ) => Promise<string[]>;
  setState: (id: RecordingId, state: 'exported') => Promise<void>;
}

/** One of §7.5's three steps, as it completes. See {@link RetentionPacing}. */
export type RetentionStep = 'recorded' | 'entry' | 'deleted' | 'exported';

/**
 * Widens each of §7.5's three windows so a `SIGKILL` can be aimed inside them.
 *
 * The `WriteAtomicPacing` bargain again, at the level the ordering lives:
 * `apps/main/test/retention-crash.test.ts` kills **this** function between its steps
 * and inside its unlink loop, rather than a copy of the sequence written out in the
 * test — which would keep passing after the steps here were reordered, and reordering
 * them is precisely the regression that loses somebody's footage. Production callers
 * pass nothing and the sequence behaves exactly as it reads.
 */
export interface RetentionPacing {
  /** Awaited after each step completes. */
  betweenSteps?: (step: RetentionStep, detail: string) => Promise<void>;
}

/** What {@link resumeInterruptedRetention} needs. */
export interface RetentionResumeStore extends RetentionStore {
  listInterruptedRetention: () => Promise<RecordingSummary[]>;
  openProject: (id: RecordingId) => Promise<unknown>;
  releaseProject: (id: RecordingId) => Promise<void>;
}

export interface RetentionOutcome {
  /** True only when every source named by §7.5 is gone and the state says so. */
  deleted: boolean;
  /** Why not, in the user's terms. Empty when `deleted`. */
  reasons: string[];
  /** Set when the deletion was authorised and then failed part-way. */
  error?: string;
}

/**
 * Delete one recording's sources, if the export that just finished earned it.
 *
 * Takes the `ExportRecord` rather than the live job, because the record is what is
 * durable: it is what `project.json` holds, what the next launch would read, and
 * what a human looking at a recording that lost its footage can be shown. A decision
 * made from in-memory state that the record does not support would be a deletion
 * nobody could later account for.
 */
export async function applyRetention(
  store: RetentionStore,
  id: RecordingId,
  record: ExportRecord,
  pacing: RetentionPacing = {},
): Promise<RetentionOutcome> {
  const verdict = mayDeleteSources(record);
  if (!verdict.mayDelete) return { deleted: false, reasons: verdict.reasons };
  const step = pacing.betweenSteps ?? ((): Promise<void> => Promise.resolve());

  try {
    // §7.5's three steps, in §7.5's order. See the table above: this order is what
    // makes a crash at any instant recoverable, and the reverse of it is what makes a
    // recording that looks editable with half its media.
    await store.recordRetention(id, newRetentionRecord(isoTimestamp()));
    await step('recorded', id);
    const removed = await store.deleteSources(id, RETENTION_SOURCE_DIRECTORIES, {
      betweenEntries: (path) => step('entry', path),
    });
    await step('deleted', String(removed.length));
    await store.setState(id, 'exported');
    await step('exported', id);
  } catch (error) {
    // Half-deleted and marked: the next launch finishes it. Reported, never
    // swallowed, and never turned into a failed export — the file the user asked for
    // is already written and verified.
    return {
      deleted: false,
      reasons: ['the sources could not be deleted'],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { deleted: true, reasons: [] };
}

/**
 * Finish deletions a crash interrupted. Called once, at launch.
 *
 * **This is not a sweep.** Obligation 3 — *"an unexported recording is never
 * auto-deleted; deletion is triggered by export, never by age, disk pressure, or app
 * launch"* — survives because the only thing this can act on is a `retention` record,
 * and the only thing that writes one is {@link applyRetention} after a verified-good
 * export. `ProjectStore.deleteSources` refuses without it, so the property is kept
 * twice: here by what is listed, and there by what is allowed.
 *
 * Each bundle is opened for the repair and released again, because an editor may
 * hold the same recording — `releaseProject` closes only at zero holders.
 */
export async function resumeInterruptedRetention(
  store: RetentionResumeStore,
): Promise<{ id: RecordingId; finished: boolean; error?: string }[]> {
  const outcomes: { id: RecordingId; finished: boolean; error?: string }[] = [];
  for (const summary of await store.listInterruptedRetention()) {
    const id = summary.id;
    try {
      await store.openProject(id);
    } catch (error) {
      // A bundle we cannot open is a bundle we must not half-delete. It stays
      // listed, and the next launch tries again.
      outcomes.push({
        id,
        finished: false,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      // Steps 2 and 3 again from the top. `deleteBundleSources` is idempotent by
      // construction — it removes what is there and reports what it removed — so
      // re-running it over a bundle the first attempt emptied costs a `readdir`.
      await store.deleteSources(id, RETENTION_SOURCE_DIRECTORIES);
      await store.setState(id, 'exported');
      outcomes.push({ id, finished: true });
    } catch (error) {
      outcomes.push({
        id,
        finished: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await store.releaseProject(id).catch(() => undefined);
    }
  }
  return outcomes;
}
