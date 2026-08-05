/**
 * What the phase 4 gate actually checks, as one function.
 *
 * It lives apart from the test that calls it so the **controls** can call it too.
 * A gate that asserts inline proves the assertions ran; it does not prove they
 * would have failed. `packages/format/test/kill-mid-write.test.ts` established the
 * pattern for this project — the atomic writer's assertions are only worth
 * anything because the same harness, pointed at a naive writer, fails them — and
 * `test/phase4-gate.test.ts` does the same with a recorder that gets the part
 * boundaries and the start times wrong.
 *
 * Every check below is a property the architecture report states, cited where it
 * is not obvious. Nothing here is a tolerance dressed up as a property: the one
 * numeric slack is {@link START_TOLERANCE_SEC}, one microsecond, which is the
 * resolution of the clock the numbers are computed from.
 */

import type { RecordingDoc, VideoPart } from '@loom/format';

/**
 * How far a `startTimeSec` may be from its expected value.
 *
 * One microsecond — the resolution of `VideoFrame.timestamp` itself, so a part
 * that is out by a single tick of the clock it was measured on still fails. This
 * is not the sync budget; the sync budget is 20 ms and would let every bug this
 * gate exists to catch through.
 */
export const START_TOLERANCE_SEC = 1e-6;

export interface ExpectedPart {
  /** Bundle-relative file this part must be, e.g. `media/webcam.001.mp4`. */
  file: string;
  startTimeSec: number;
  endedEarly: boolean;
  /** `undefined` for a part that ended with the recording rather than early. */
  endReason: string | undefined;
}

export interface Expectation {
  screenParts: number;
  webcam: ExpectedPart[];
  /** Audio tracks that must have survived with real media in them. */
  audioTracks: ('mic' | 'system')[];
}

/**
 * Check a finished `recording.json` against what the recording actually did.
 *
 * Returns the list of things that are wrong, so a failure names all of them at
 * once rather than one per run.
 */
export function verifyParts(recording: RecordingDoc, expected: Expectation): string[] {
  const problems: string[] = [];

  // ---- the screen survived, which is the whole point of §7.4 -----------------
  const screen = recording.tracks.screen;
  if (screen === undefined) {
    problems.push('the screen track is missing: losing the camera took the recording with it');
  } else {
    if (screen.parts.length !== expected.screenParts) {
      problems.push(
        `the screen has ${String(screen.parts.length)} part(s), expected ` +
          `${String(expected.screenParts)}: a camera unplug must not split the screen track`,
      );
    }
    for (const [index, part] of screen.parts.entries()) {
      if (part.frameCount <= 0) {
        problems.push(`screen part ${String(index)} recorded no frames`);
      }
      if (part.durationSec <= 0) {
        problems.push(`screen part ${String(index)} has no duration`);
      }
    }
    // The recording clock's origin *is* the first screen frame (§5.4 mechanism 2),
    // so the reference track's first part starts at zero by construction.
    const first = screen.parts[0];
    if (first !== undefined && Math.abs(first.startTimeSec) > START_TOLERANCE_SEC) {
      problems.push(
        `the screen starts at ${first.startTimeSec.toFixed(6)}s; the recording clock's ` +
          'origin is its first frame, so it must start at 0',
      );
    }
  }

  // ---- the audio survived ----------------------------------------------------
  for (const key of expected.audioTracks) {
    const track = recording.tracks[key];
    const part = track?.parts[0];
    if (track === undefined || part === undefined) {
      problems.push(`the ${key} track is missing: losing the camera took the audio with it`);
      continue;
    }
    if (part.durationSec <= 0) problems.push(`the ${key} track recorded no audio`);
    if (part.measuredSampleRate <= 0) {
      problems.push(`the ${key} track has no measured sample rate`);
    }
  }

  // ---- and the camera came back as its own part ------------------------------
  problems.push(...verifyWebcam(recording, expected.webcam));
  return problems;
}

function verifyWebcam(recording: RecordingDoc, expected: ExpectedPart[]): string[] {
  const problems: string[] = [];
  const webcam = recording.tracks.webcam;
  if (webcam === undefined) {
    return expected.length === 0
      ? problems
      : [`the webcam track is missing entirely; expected ${String(expected.length)} part(s)`];
  }

  if (webcam.parts.length !== expected.length) {
    problems.push(
      `the webcam has ${String(webcam.parts.length)} part(s), expected ` +
        `${String(expected.length)}. A camera that is unplugged and reconnected produces one ` +
        'part per acquisition (§7.4 step 4); one part means the gap was written into the ' +
        'media instead of into recording.json',
    );
  }

  for (const [index, want] of expected.entries()) {
    const part = webcam.parts[index];
    if (part === undefined) continue;
    if (part.file !== want.file) {
      problems.push(`webcam part ${String(index)} is ${part.file}, expected ${want.file}`);
    }
    if (Math.abs(part.startTimeSec - want.startTimeSec) > START_TOLERANCE_SEC) {
      problems.push(
        `webcam part ${String(index)} starts at ${part.startTimeSec.toFixed(6)}s, expected ` +
          `${want.startTimeSec.toFixed(6)}s. This is the number the editor places the bubble ` +
          'with; wrong, the camera plays over the wrong part of the screen for the whole ' +
          'recording (§5.4 mechanism 2)',
      );
    }
    if (part.endedEarly !== want.endedEarly) {
      problems.push(
        `webcam part ${String(index)} says endedEarly: ${String(part.endedEarly)}, expected ` +
          `${String(want.endedEarly)} (§2.3: "a webcam unplug must not invalidate the recording")`,
      );
    }
    if (part.endReason !== want.endReason) {
      problems.push(
        `webcam part ${String(index)} says endReason: ${String(part.endReason)}, expected ` +
          String(want.endReason),
      );
    }
    if (part.frameCount <= 0) problems.push(`webcam part ${String(index)} recorded no frames`);
    if (part.durationSec <= 0) problems.push(`webcam part ${String(index)} has no duration`);
  }

  problems.push(...verifyPartsDoNotOverlap(webcam.parts));
  return problems;
}

/**
 * Parts of one track occupy disjoint, increasing stretches of the recording clock.
 *
 * The property that makes a multi-part track mean anything: two parts that overlap
 * are two pictures claiming the same instant, and a part that starts before the one
 * before it ended has had its `startTimeSec` computed against the wrong origin. The
 * gap between them is the unplug, and it is supposed to be there — §7.4 step 5 fades
 * the bubble across exactly this hole.
 */
function verifyPartsDoNotOverlap(parts: readonly VideoPart[]): string[] {
  const problems: string[] = [];
  for (let index = 1; index < parts.length; index++) {
    const previous = parts[index - 1];
    const part = parts[index];
    if (previous === undefined || part === undefined) continue;
    const previousEnd = previous.startTimeSec + previous.durationSec;
    if (part.startTimeSec < previousEnd) {
      problems.push(
        `webcam part ${String(index)} starts at ${part.startTimeSec.toFixed(6)}s, before part ` +
          `${String(index - 1)} ends at ${previousEnd.toFixed(6)}s. Two parts of one track ` +
          'cannot occupy the same instant',
      );
    }
  }
  return problems;
}
