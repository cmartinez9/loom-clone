/**
 * Retention — whether an export has earned the right to delete the recording it
 * came from, and the words the user is told before it does.
 *
 * `data/loom-scope/decision-loom-storage-retention.md` is the captain's settled
 * decision: *"Delete them after export to save disk."* Asked twice, shown the
 * contradiction with his earlier "save everything", confirmed. It creates four
 * obligations, and two of them live here because they are **readings of §2.2
 * fields** rather than behaviour:
 *
 * - obligation 1, *"deletion happens only after a verified-good export"*, is
 *   {@link mayDeleteSources} — a predicate over the `ExportRecord` §7.5 requires the
 *   export to have written;
 * - obligation 2, *"the user is told before it happens"*, is {@link RETENTION_COPY} —
 *   the export sheet's own sentences, in one place so the sheet and any later
 *   surface cannot drift into telling the user different things.
 *
 * It lives beside `src/sync/` and for the same reason that does: every function in
 * it is a reading of a field `@loom/format` already owns, and it has to be readable
 * by main (which deletes) and by a renderer (which warns) without either importing
 * the other. Pure — no `node:`, no DOM.
 *
 * ## What this deliberately does not do
 *
 * It does not re-verify the export. §7.5's five checks are `apps/main/src/export/
 * verify.ts`, answered off the bytes on disk by the process that wrote them, and
 * phase 8 closed a real hole in that signal (an export that lost its GL context
 * mid-run could emit black frames that passed every structural check). Second-
 * guessing it here would put two opinions about "is this file good" in the codebase,
 * and the wrong one would be the one that deletes. What this does instead is refuse
 * to act on a record that does not *say* all five passed — which is a different
 * thing, and the reason the fields are enumerated one by one below rather than
 * collapsed into `error === undefined`.
 */

import type { IsoTimestamp } from './types/common.ts';
import type { ExportRecord, RetentionRecord } from './types/project.ts';

/**
 * The bundle directories a verified export takes with it.
 *
 * Architecture report §7.5, verbatim: *"then unlink `media/` and `events/`"*. It is
 * data rather than a literal in the deleting function so the list can be asserted
 * against, and it is exactly §7.5's two — `cursors/` (deduplicated cursor bitmaps,
 * kilobytes) and `thumbs/` (the poster the library card still shows for an exported
 * recording) are not named there and are not ours to add. Deleting more than the
 * authoritative document says is the one direction this file must never err in.
 */
export const RETENTION_SOURCE_DIRECTORIES: readonly ['media', 'events'] = ['media', 'events'];

/**
 * Obligation 2's words. Architecture report §7.5: *"The export sheet states plainly
 * … Not a footnote, not a toast afterwards."*
 *
 * `warning` is the report's own sentence. The rest is what a checkbox and its two
 * states need in order to say the same thing twice without contradicting itself.
 */
export const RETENTION_COPY = {
  /** Stated before the export starts, where the button is. §7.5's exact wording. */
  warning:
    'After this export, this recording can no longer be edited. The original screen, ' +
    'camera, audio and cursor data will be deleted.',
  /** Obligation 4's escape hatch, as a label. */
  keepLabel: 'Keep the original recording',
  /** What ticking it buys, so the choice is not a guess. */
  keepHint: 'The recording stays editable and keeps using disk. The export is written either way.',
  /** What leaving it unticked buys, said in the same breath. */
  deleteHint: 'The export is checked before anything is deleted. A failed export deletes nothing.',
  /** After the fact, on a recording whose sources are gone. */
  exported: 'The sources were deleted after the export was verified. This recording is final.',
  /** After the fact, when the escape hatch or a refusal left the sources alone. */
  kept: 'The original recording was kept.',
  /**
   * After the fact, on the third state: authorised, begun, and not finished.
   *
   * It exists because `sourcesDeleted` has three outcomes and {@link RETENTION_COPY}
   * had two sentences, so a half-deleted recording was being reported with
   * {@link RETENTION_COPY.kept} — a false assurance about data that is partly gone,
   * discovered only when the user tries to edit it. The standard is the one
   * `decision-journal-damage-recovery` set for a damaged recording that still opens:
   * say what happened, name what survived and what did not, and do not imply an
   * outcome the disk does not support.
   *
   * The last sentence is a statement of fact rather than a hope: step 1 wrote the
   * `retention` record before anything was unlinked, so `listInterruptedRetention`
   * finds this recording and `resumeInterruptedRetention` finishes it at the next
   * launch.
   */
  deletionFailed:
    'Removing the original recording was authorised and did not finish. Some of its ' +
    'screen, camera, audio and cursor data has been deleted, so it may no longer open ' +
    'for editing. The app will finish removing it the next time it starts.',
} as const;

/** Why the sources may not go. Every reason, so a caller can say all of them. */
export interface RetentionVerdict {
  mayDelete: boolean;
  /** Empty exactly when `mayDelete` is true. */
  reasons: string[];
}

/**
 * Obligation 1 — *"deletion happens only after a verified-good export"*.
 *
 * Every reason is returned rather than the first, the shape `streamCopyEligibility`
 * already uses: a caller that has to explain why a recording is still editable
 * should be able to say all of it.
 *
 * The escape hatch (obligation 4) is one of the reasons rather than a branch above
 * this, so that "the user asked to keep them" and "the export was not good enough"
 * arrive at the deletion site through the same door and are recorded the same way.
 */
export function mayDeleteSources(record: ExportRecord): RetentionVerdict {
  const reasons: string[] = [];

  if (record.sourcesKept) {
    reasons.push('the export asked to keep the sources this time');
  }
  if (record.error !== undefined) {
    reasons.push(`the export failed: ${record.error}`);
  }

  const verified = record.verified;
  if (verified === undefined) {
    reasons.push('the export carries no verification record');
    return { mayDelete: false, reasons };
  }
  // One by one, and not `error === undefined` alone. §7.5 names five checks and
  // requires all five in `project.json`; a record that says four passed is a record
  // this must refuse, whatever else it also says. `durationSec` is the one check
  // whose pass cannot be read off the record without the expectation that produced
  // it, and it is what `error` covers.
  if (!verified.exists) reasons.push('the verification did not find the exported file');
  if (verified.bytes <= 0) reasons.push('the exported file is empty');
  if (!(verified.durationSec > 0)) reasons.push('the exported file has no duration');
  if (!verified.lastFrameDecodable) reasons.push('the last frame of the export did not decode');
  // Written last by `verifyExport`, and only once every other check passed — so an
  // empty hash is the record saying the run did not reach the end, whatever the
  // fields above it happen to hold.
  if (verified.sha256 === '') reasons.push('the export was not hashed, so it was never verified');

  return { mayDelete: reasons.length === 0, reasons };
}

/** The §2.2 bookkeeping written **before** anything is unlinked. See §7.5's ordering. */
export function newRetentionRecord(at: IsoTimestamp): RetentionRecord {
  return { sourcesDeletedAt: at, reason: 'export-verified' };
}
