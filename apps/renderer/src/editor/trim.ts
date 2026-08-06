/**
 * Trimming, as arithmetic over the clip list.
 *
 * Phase 14 adds **no primitive**: a trim is `clips.set` (§2.7's op vocabulary) with
 * one clip whose `sourceStart` and `sourceEnd` are the handles' positions, and
 * everything downstream — `compileClips`, `resolve`, the exporter — already reads
 * that. There is no "trim" concept anywhere in the model and there must not be one.
 *
 * Pure, and in its own module, because it is the half of trimming that is worth
 * testing without a window: what a document *means* by "trimmed", what a drag is
 * allowed to produce, and what the op to send is.
 *
 * ## `speed` is always 1 here, and that is a scope statement
 *
 * A clip carries a speed and this phase never sets one. That is not a placeholder:
 * `SourceReader.prime` covers `[t, t + aheadSec]` in **source** seconds, so a clip
 * whose speed is not 1 scales the lookahead the preview actually buys — a 2× clip
 * gets half of §4.2's 0.5 s target — and `retainBehindSec` scales with it. Under
 * every clip list this app can produce today the two are the same number, so
 * nothing is wrong; a speed control is what would make it bite, and compensating in
 * preview alone would manufacture exactly the preview/export divergence §4.5 and
 * phase 8's golden gate exist to prevent. So: no speed control here, and whoever
 * adds one owns that as one change across both paths rather than a local fix.
 */

import type { Clip, EditDocument, EditOp, Seconds } from '@loom/format';

/**
 * The shortest trimmed region a drag may leave.
 *
 * A clip with `sourceEnd <= sourceStart` is dropped by `compileClips` and refused by
 * `validateEditDocument`, so "as small as you like" ends at a document that will not
 * open. A tenth of a second is also about the smallest region a person can mean with
 * a pointer, and leaves the playhead somewhere to be.
 */
export const MIN_TRIM_SEC = 0.1;

/** The id every single-clip trim writes. One clip, one name, so a diff is readable. */
export const TRIM_CLIP_ID = 'trim';

/** Where the two handles are, in source seconds. */
export interface Trim {
  startSec: Seconds;
  endSec: Seconds;
}

/**
 * What the document currently says the trim is.
 *
 * An **empty** clip list means the recording as captured — `compileClips` reads it
 * that way and `newEditDocument` documents it — so it answers the whole source
 * extent rather than a zero-length trim. More than one clip is answered by its
 * outer bounds: this phase's UI can only produce one clip, but a document is not
 * obliged to have come from this phase's UI, and reporting the first clip alone
 * would draw handles that do not contain the material being played.
 */
export function readTrim(doc: EditDocument, sourceDurationSec: Seconds): Trim {
  const usable = doc.clips.filter((clip) => clip.sourceEnd > clip.sourceStart && clip.speed > 0);
  if (usable.length === 0) return { startSec: 0, endSec: Math.max(0, sourceDurationSec) };
  let startSec = Number.POSITIVE_INFINITY;
  let endSec = Number.NEGATIVE_INFINITY;
  for (const clip of usable) {
    startSec = Math.min(startSec, clip.sourceStart);
    endSec = Math.max(endSec, clip.sourceEnd);
  }
  return { startSec, endSec };
}

/**
 * Move one handle, and answer where both of them end up.
 *
 * The moving handle is clamped into the recording and then held {@link MIN_TRIM_SEC}
 * clear of the other one — the *other* handle never moves, so a drag that runs out
 * of room stops rather than pushing. Pushing is what makes a fast drag past the far
 * end silently discard the whole recording.
 */
export function moveHandle(
  trim: Trim,
  handle: 'start' | 'end',
  toSec: Seconds,
  sourceDurationSec: Seconds,
): Trim {
  const duration = Math.max(0, sourceDurationSec);
  const at = clamp(toSec, 0, duration);
  return handle === 'start'
    ? { startSec: Math.min(at, trim.endSec - MIN_TRIM_SEC), endSec: trim.endSec }
    : { startSec: trim.startSec, endSec: Math.max(at, trim.startSec + MIN_TRIM_SEC) };
}

/**
 * The op that writes a trim, or `null` when it would change nothing.
 *
 * `null` rather than an empty batch, and the caller must honour it: an op that
 * changes nothing still costs a revision, a journal line and — because the editor
 * records one undo step per drag — an undo step that appears to do nothing when it
 * is used. A drag that ends where it started is not an edit.
 *
 * A trim covering the whole recording writes the clip out in full rather than
 * clearing the list. "Empty means the whole source" is a *default*, and replacing an
 * explicit statement with a default loses the difference between a recording nobody
 * has trimmed and one somebody trimmed back to its full length — which is exactly
 * what an undo of the first trim has to restore.
 */
export function trimOp(doc: EditDocument, trim: Trim): EditOp | null {
  const clips: Clip[] = [
    {
      id: doc.clips[0]?.id ?? TRIM_CLIP_ID,
      sourceStart: trim.startSec,
      sourceEnd: trim.endSec,
      speed: 1,
    },
  ];
  if (sameClips(doc.clips, clips)) return null;
  return { op: 'clips.set', clips };
}

/**
 * Exact equality, on purpose.
 *
 * A tolerance here would mean a drag of less than the tolerance is silently not an
 * edit, which is a handle that does not move when you move it. The values being
 * compared came from the same arithmetic on both sides, so exactness is reachable.
 */
function sameClips(a: readonly Clip[], b: readonly Clip[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((clip, i) => {
    const other = b[i];
    return (
      clip.id === other?.id &&
      clip.sourceStart === other.sourceStart &&
      clip.sourceEnd === other.sourceEnd &&
      clip.speed === other.speed
    );
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
