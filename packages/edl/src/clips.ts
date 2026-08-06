/**
 * The clip list — the **only** thing that maps between the two time domains.
 *
 * Architecture report §3.1:
 *
 * > - **source time** — seconds into the raw recording. All media, the cursor log,
 * >   everything captured.
 * > - **timeline time** — seconds into the edited output.
 * >
 * > The only thing that maps between them is the clip list … Every other object
 * > states which domain it lives in and never straddles.
 *
 * A clip's timeline extent is `(sourceEnd − sourceStart) / speed`, so a 2× clip
 * occupies half the timeline its source does. `clipStarts` is the running sum, and
 * §3.6 puts it on `CompiledTimeline` as a `Float64Array` because the lookup that
 * reads it runs once per rendered frame.
 */

import type { Clip, RecordingDoc, Seconds } from '@loom/format';

/** A clip list flattened into the arrays `resolve` reads. */
export interface CompiledClips {
  /** Timeline-time start of each clip. §3.6's field, by that name. */
  starts: Float64Array;
  sourceStarts: Float64Array;
  speeds: Float64Array;
  count: number;
  durationSec: Seconds;
}

/**
 * Flatten a clip list.
 *
 * An **empty** list is read as one clip spanning the whole source, which is what
 * `newEditDocument()` documents and what "the recording as captured" means. That
 * needs a source duration, and the only place one exists is `recording.json`; a
 * compile with neither clips nor a recording therefore yields a zero-length
 * timeline rather than guessing at a length.
 *
 * Clips with a non-positive extent or a non-positive speed are dropped: the
 * document validator already refuses them, and a zero-length clip in the running
 * sum would put two clips at the same timeline start and make the lookup ambiguous.
 */
export function compileClips(clips: readonly Clip[], sourceDurationSec: Seconds): CompiledClips {
  const usable = clips.filter((c) => c.sourceEnd > c.sourceStart && c.speed > 0);
  const effective: readonly Clip[] =
    usable.length > 0
      ? usable
      : sourceDurationSec > 0
        ? [{ id: 'whole-source', sourceStart: 0, sourceEnd: sourceDurationSec, speed: 1 }]
        : [];

  const count = effective.length;
  const starts = new Float64Array(count);
  const sourceStarts = new Float64Array(count);
  const speeds = new Float64Array(count);
  let cursor = 0;
  effective.forEach((clip, i) => {
    starts[i] = cursor;
    sourceStarts[i] = clip.sourceStart;
    speeds[i] = clip.speed;
    cursor += (clip.sourceEnd - clip.sourceStart) / clip.speed;
  });

  return { starts, sourceStarts, speeds, count, durationSec: cursor };
}

/**
 * Index of the clip covering `timelineTime`.
 *
 * Binary search over `starts`, clamped at both ends: a time past the last clip
 * resolves into the last clip rather than off the end, so a playhead parked on the
 * final frame still has a source time.
 */
export function clipIndexAt(clips: CompiledClips, timelineTime: Seconds): number {
  const count = clips.count;
  if (count === 0) return 0;
  let low = 0;
  let high = count - 1;
  if (timelineTime <= 0) return 0;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((clips.starts[mid] ?? 0) <= timelineTime) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Source time for a timeline time, through the clip at `index`. */
export function sourceTimeAt(clips: CompiledClips, index: number, timelineTime: Seconds): Seconds {
  if (clips.count === 0) return timelineTime;
  const start = clips.starts[index] ?? 0;
  const sourceStart = clips.sourceStarts[index] ?? 0;
  const speed = clips.speeds[index] ?? 1;
  return sourceStart + (timelineTime - start) * speed;
}

/**
 * The inverse of {@link sourceTimeAt}: where a *source* instant lands on the
 * timeline, or `null` when no clip covers it.
 *
 * It lives here rather than in whichever consumer needed it first because §3.1's
 * *"the only thing that maps between them is the clip list"* is a claim about this
 * module, and a second implementation of the mapping — however small — is a second
 * thing that can disagree with `resolve`. `packages/edl/test/clips.test.ts` pins the
 * two against each other rather than against arithmetic written out twice.
 *
 * **`null` is a real answer and the caller has to mean something by it.** A source
 * instant that has been trimmed away, or that falls in the hole between two clips,
 * is not on the output at all; there is no timeline time to return and the nearest
 * one is a decision (clamp to the cut, or refuse) that belongs to whoever is asking.
 * The editor's ruler draws the whole *source* extent, so the trimmed-away head and
 * tail are exactly the region this answers `null` for, and it clamps the playhead
 * rather than inventing a position for a frame the output does not contain.
 *
 * A source time covered by more than one clip — the same material used twice — is
 * answered with its **first** occurrence. That is the only choice that is stable
 * under editing: the alternatives (last, or nearest to some other time) move the
 * answer when an unrelated clip is added.
 */
export function timelineTimeAt(clips: CompiledClips, sourceTime: Seconds): Seconds | null {
  for (let i = 0; i < clips.count; i++) {
    const sourceStart = clips.sourceStarts[i] ?? 0;
    const speed = clips.speeds[i] ?? 1;
    const start = clips.starts[i] ?? 0;
    const next =
      i + 1 < clips.count ? (clips.starts[i + 1] ?? clips.durationSec) : clips.durationSec;
    const sourceEnd = sourceStart + (next - start) * speed;
    if (sourceTime < sourceStart || sourceTime > sourceEnd) continue;
    return start + (sourceTime - sourceStart) / speed;
  }
  return null;
}

/**
 * Where the captured material ends, on the recording clock.
 *
 * The video tracks, not the audio ones: §5.4 aligns tracks by `startTimeSec` on one
 * clock and a microphone that kept running after the screen stopped does not extend
 * the picture. `startTimeSec + durationSec` is when a part ended, uniformly across
 * part kinds (§2.3), so the maximum over the parts is the extent.
 */
export function sourceDurationSec(recording: RecordingDoc | null): Seconds {
  if (recording === null) return 0;
  let end = 0;
  for (const track of [recording.tracks.screen, recording.tracks.webcam]) {
    for (const part of track?.parts ?? []) {
      const partEnd = part.startTimeSec + part.durationSec;
      if (Number.isFinite(partEnd) && partEnd > end) end = partEnd;
    }
  }
  return end;
}
