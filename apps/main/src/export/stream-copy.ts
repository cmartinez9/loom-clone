/**
 * §5.3's stream-copy fast path.
 *
 * > If the edit has **no visual edits at all** — exactly one video source
 * > contributing, no zoom, no bubble, no annotations, no crop, no speed change,
 * > output size == source size, and cut points snapped to keyframes — remux instead
 * > of re-encode. The scout measured **0.13 s for a 30.5 s recording (235×
 * > realtime)**. Show the user which path they are on ("Instant" vs "≈4 min")
 * > because the difference is enormous and they can often get it by turning the
 * > bubble off.
 *
 * Two halves, deliberately separate. {@link streamCopyEligibility} is a pure
 * predicate over the edit document — it is what the UI asks so it can say *why* an
 * export is not instant, which is the actionable half of the quote above.
 * {@link planStreamCopy} turns an eligible job into the exact byte ranges to copy.
 *
 * ## What "no visual edits" does not cover
 *
 * **Audio.** The report's condition list is entirely about pictures, and rightly:
 * mixing two audio tracks is seconds of work against minutes of compositing. So a
 * stream-copied export still runs the export window's audio pass when there is audio
 * to mix — the video is copied, the audio is produced, and the two meet in the same
 * `ExportMp4Writer` as always. A recording with no audio at all needs no renderer.
 *
 * ## Why the cut points have to be keyframes
 *
 * A copied sample is not re-encoded, so a P-frame carried across a cut references a
 * picture that is no longer in front of it. The result decodes into garbage for the
 * rest of the GOP. §5.3 says "snapped to keyframes" and this refuses anything else,
 * rather than producing a file that plays and is wrong.
 *
 * Both halves check it, and they are not redundant. {@link streamCopyEligibility} is
 * where it *decides*: a mid-GOP trim is reported ineligible, so the caller routes the
 * job to the recompose path — which can express that cut perfectly — and the button
 * says why. {@link planStreamCopy}'s refusal is the backstop for a caller that asked
 * for a copy anyway. Checking it only in the plan is how a perfectly ordinary trim
 * became a failed export: eligibility said "Instant", the job committed to a copy
 * with no video pass requested, and the plan then threw with nothing left to fall
 * back to.
 */

import { DemuxIndex } from '@loom/decode';
import type {
  Clip,
  EditDocument,
  FrameIndexDoc,
  RecordingDoc,
  Track,
  VideoPart,
} from '@loom/format';
import type { ExportSettings } from '@loom/ipc';

/** Targets whose presence means the picture is not the source's picture. */
const VISUAL_TARGETS = new Set(['zoom', 'bubble', 'annotation', 'cursor']);

export interface StreamCopyDecision {
  eligible: boolean;
  /** Empty when eligible; otherwise every reason, phrased for a person. */
  reasons: string[];
}

export interface EligibilityInput {
  edit: EditDocument;
  recording: RecordingDoc | null;
  settings: ExportSettings;
  /**
   * The screen part's frame index sidecar, when there is exactly one part and it
   * could be read.
   *
   * §5.3's second condition — "cut points snapped to keyframes" — cannot be answered
   * without it, so it is a required field rather than an optional one: a caller that
   * has not read the sidecar has to say so, and `null` with a trimmed edit is a
   * refusal (which routes to recompose) rather than a guess.
   */
  index: FrameIndexDoc | null;
}

/**
 * Whether this export can be a remux.
 *
 * Every reason is collected rather than the first one returned, because the UI's job
 * is to tell the user what to turn off — and *"the bubble is on and the output is
 * bigger than the recording"* is two things to fix, not one.
 */
export function streamCopyEligibility(input: EligibilityInput): StreamCopyDecision {
  const reasons: string[] = [];
  const screen = input.recording?.tracks.screen;

  if (screen === undefined) {
    reasons.push('the recording has no screen track to copy');
  } else if (screen.parts.length !== 1) {
    // §5.3's "exactly one video source contributing". Two parts may carry different
    // encoder parameters, and a copy cannot reconcile two `avcC` records into one
    // sample entry.
    reasons.push(`the screen track is in ${screen.parts.length} parts`);
  } else {
    const part = screen.parts[0];
    if (
      part !== undefined &&
      (part.size[0] !== input.settings.width || part.size[1] !== input.settings.height)
    ) {
      reasons.push(
        `the output is ${input.settings.width}x${input.settings.height} and the recording is ` +
          `${part.size[0]}x${part.size[1]}`,
      );
    }
    reasons.push(...cutPointReasons(input.edit.clips, input.index));
  }

  if (input.recording?.tracks.webcam !== undefined) {
    reasons.push('the recording has a camera track, which has to be composited in');
  }

  for (const track of input.edit.tracks) {
    if (!isVisualTrack(track)) continue;
    reasons.push(`the ${track.target} track is enabled`);
  }

  for (const clip of input.edit.clips) {
    if (clip.speed !== 1) {
      reasons.push(`a clip plays at ${clip.speed}x`);
      break;
    }
  }

  const background = input.edit.output.background;
  if (background.kind !== 'none') {
    reasons.push(`the output has a ${background.kind} background`);
  }

  return { eligible: reasons.length === 0, reasons };
}

/** True for a track that changes the picture. Exported for the reason string above. */
export function isVisualTrack(track: Track): boolean {
  return track.enabled && VISUAL_TARGETS.has(track.target);
}

/**
 * §5.3's other condition: every clip has to begin on a keyframe.
 *
 * One reason rather than one per clip — a timeline trimmed in twenty places is one
 * thing for the user to know, not twenty — but it names an offending cut, because
 * "some cut is wrong" is not something anyone can act on.
 */
function cutPointReasons(clips: readonly Clip[], index: FrameIndexDoc | null): string[] {
  if (clips.length === 0) return [];
  if (index === null) {
    return ["the screen part's frame index could not be read, so the cuts cannot be checked"];
  }
  const demux = new DemuxIndex(index);
  if (demux.frameCount === 0) return ['the screen part has no frames'];

  const missed = clips.filter((clip) => {
    const frame = demux.frameAtTime(clip.sourceStart);
    return frame < 0 || !demux.isKeyframe(frame);
  });
  const first = missed[0];
  if (first === undefined) return [];
  const at = `${first.sourceStart.toFixed(3)}s`;
  return [
    missed.length === 1
      ? `the cut at ${at} is not on a keyframe`
      : `${missed.length} cuts are not on keyframes, the first at ${at}`,
  ];
}

export class StreamCopyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamCopyRefused';
  }
}

/** One sample to copy, in output order. */
export interface CopiedSample {
  /** Byte offset within the source media part. */
  offset: number;
  byteLength: number;
  /** Duration in `timescale` units. */
  durationUnits: number;
  isKey: boolean;
}

export interface StreamCopyPlan {
  /**
   * Microseconds. The output's timebase, not the source's.
   *
   * A copied stream keeps the source's *timing* but not its timescale: `DemuxIndex`
   * answers in microseconds (`ptsMicros`), which is the one unit every part's index
   * can be read in without the caller knowing what timescale it was written with.
   * The copied file therefore carries exact source timings on a µs grid rather than
   * a rescaled approximation of them.
   */
  timescale: number;
  width: number;
  height: number;
  samples: CopiedSample[];
  durationSec: number;
}

/** {@link StreamCopyPlan.timescale}. */
export const COPY_TIMESCALE = 1_000_000;

/**
 * Turn an eligible edit into the samples to copy.
 *
 * Durations come from the *next* frame's PTS, exactly as the capture writer measured
 * them — a variable-rate screen track's frame is as long as the gap to the frame
 * after it, and the last one stands for the rest of the part (§2.3, and the
 * one-sample lookahead in `fragment-writer.ts`).
 */
export function planStreamCopy(
  indexDoc: FrameIndexDoc,
  part: VideoPart,
  clips: readonly Clip[],
): StreamCopyPlan {
  const index = new DemuxIndex(indexDoc);
  if (index.frameCount === 0) throw new StreamCopyRefused('the source part has no frames');

  const ranges = clips.length === 0 ? [{ from: 0, to: part.durationSec, speed: 1 }] : null;
  const effective =
    ranges ??
    clips.map((clip) => ({ from: clip.sourceStart, to: clip.sourceEnd, speed: clip.speed }));

  const samples: CopiedSample[] = [];
  let durationUnits = 0;
  for (const range of effective) {
    if (range.speed !== 1) throw new StreamCopyRefused('a stream copy cannot change speed');
    const first = index.frameAtTime(range.from);
    if (first < 0) {
      throw new StreamCopyRefused(`no frame exists at ${range.from.toFixed(3)}s`);
    }
    if (!index.isKeyframe(first)) {
      throw new StreamCopyRefused(
        `the cut at ${range.from.toFixed(3)}s is not on a keyframe, so the frames after it ` +
          'would reference pictures the copy leaves behind',
      );
    }
    const last = index.frameAtTime(range.to);
    // `frameAtTime` is last-PTS-≤-t, so a `to` that lands exactly on a frame includes
    // it. A range ending mid-frame keeps that frame, which is what holding the last
    // picture through the end of a clip means.
    const end = last < first ? first : last;

    for (let frame = first; frame <= end; frame++) {
      const span = index.byteRange(frame);
      const units = frameDurationMicros(index, frame, part);
      samples.push({
        offset: span.start,
        byteLength: span.end - span.start,
        durationUnits: units,
        isKey: index.isKeyframe(frame),
      });
      durationUnits += units;
    }
  }
  if (samples.length === 0) throw new StreamCopyRefused('the edit selects no frames');

  return {
    timescale: COPY_TIMESCALE,
    width: part.size[0],
    height: part.size[1],
    samples,
    durationSec: durationUnits / COPY_TIMESCALE,
  };
}

/**
 * How long frame `n` is on screen, in microseconds.
 *
 * The gap to the next frame, or — for the last frame of the part — whatever is left
 * of the part's own duration. A screen track stops producing frames when the screen
 * stops changing, so the last frame of a recording that ends on a still screen has
 * to stand for everything after it; a nominal 1/30 s there would drop the tail of
 * the recording on the floor.
 */
function frameDurationMicros(index: DemuxIndex, frame: number, part: VideoPart): number {
  const pts = index.ptsMicros(frame);
  if (frame + 1 < index.frameCount) {
    return Math.max(1, Math.round(index.ptsMicros(frame + 1) - pts));
  }
  return Math.max(1, Math.round(part.durationSec * COPY_TIMESCALE - pts));
}
