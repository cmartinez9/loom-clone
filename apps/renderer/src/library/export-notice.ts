/**
 * What the library says about a finished export, and what became of the sources.
 *
 * §7.5 obligation 2 is *"the user is told"*, and the standard for after the fact is the
 * one `decision-journal-damage-recovery` already set for a damaged recording that still
 * opens: say what happened, name what survived and what did not, and never imply an
 * outcome the disk does not support.
 *
 * There are **three** outcomes, not two. `ExportResult.sourcesDeleted` is deliberately
 * not the negation of `sourcesKept` — the escape hatch is one of several reasons a
 * verified export leaves the sources alone, and a deletion that was authorised and
 * then failed part-way is a third state again. A two-way branch on `sourcesDeleted`
 * therefore told a user whose `media/` was half-removed that *"the original recording
 * was kept"*: a false assurance about data that is partly gone, which they would
 * discover only when they tried to edit it.
 *
 * It is a pure function in its own module rather than a branch inside the row
 * renderer so it can be read — and tested — without a DOM. The sentences themselves
 * are `RETENTION_COPY`, so the warning shown *before* the export and the note shown
 * after it cannot drift apart.
 */

import { RETENTION_COPY } from '@loom/format';
import type { ExportResult } from '@loom/ipc';

/**
 * The sentence under the buttons when an export reports `done`.
 *
 * `retentionError` is what separates the second outcome from the third, and it is
 * read before `sourcesDeleted`'s `false` is interpreted: both the escape hatch and a
 * half-finished deletion arrive as `sourcesDeleted: false` with reasons attached, and
 * only this field says which one happened.
 */
export function exportNotice(result: ExportResult | undefined): string {
  if (result === undefined) return 'Exported.';
  const where = `Exported to ${result.path}.`;
  if (result.sourcesDeleted) return `${where} ${RETENTION_COPY.exported}`;
  if (result.retentionError !== undefined) {
    return `${where} ${RETENTION_COPY.deletionFailed} The reason given was: ${result.retentionError}`;
  }
  return `${where} ${RETENTION_COPY.kept}`;
}
