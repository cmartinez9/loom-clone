/**
 * Building `recording.json`. Architecture report §2.3.
 *
 * Pure: it takes facts and returns a document, so what the recorder writes at the
 * start of a capture, what it writes at the end, and what crash recovery repairs
 * are all the same shape produced by the same code.
 *
 * ## Why a provisional document exists at all
 *
 * §7.1 recovers a crashed recording by rebuilding `recording.json` "from the frame
 * indices". Frame indices describe frames; they do not know which display was
 * recorded, at what scale factor, with which permissions granted. Those facts are
 * only knowable while the capture is running, and a process that has been
 * `SIGKILL`ed is not running.
 *
 * So the document is written **before the first frame**, carrying everything only
 * the live session knows, with the part's duration and frame count at zero. A
 * clean stop replaces it with the real numbers; a crash leaves recovery with a
 * document it only has to correct, rather than one it has to invent.
 */

import { currentSchemaId } from '@loom/format';
import type { CaptureInfo, DisplayInfo, PartRate, RecordingDoc, VideoPart } from '@loom/format';

export interface ProvisionalRecordingInput {
  display: DisplayInfo;
  /** Bundle-relative paths from `ProjectStore.beginMediaPart`. */
  file: string;
  index: string;
  codec: string;
  size: [number, number];
  requestedFps: number;
  capture: Omit<CaptureInfo, 'requestedFps' | 'droppedFrames'>;
}

/**
 * `clock.t0Us: 0` — the recording clock's origin **is** the first screen frame.
 *
 * The alternative, storing the encoder's raw first timestamp, buys nothing and
 * costs a rewrite of this document after the first frame arrives. Every part's
 * `startTimeSec` is an offset from that origin, which is exactly what phase 3
 * needs for the microphone and system tracks, and it is what architecture report
 * §2.3 shows.
 */
export function provisionalRecordingDoc(input: ProvisionalRecordingInput): RecordingDoc {
  return {
    schema: currentSchemaId('loom.recording'),
    clock: { kind: 'videoframe-timestamp-us', t0Us: 0 },
    display: input.display,
    tracks: {
      screen: {
        kind: 'video',
        parts: [
          {
            file: input.file,
            index: input.index,
            codec: input.codec,
            size: input.size,
            startTimeSec: 0,
            durationSec: 0,
            frameCount: 0,
            // ScreenCaptureKit emits frames only when the screen changes — 1.4 fps
            // on an idle desktop, 29.4 under load (research report §5.1). The
            // screen track is variable-rate from the first byte and every
            // downstream component has to know it (§2.3).
            rate: { mode: 'variable', nominalFps: input.requestedFps, observedFps: 0 },
            colr: {
              primaries: 'bt709',
              transfer: 'iec61966-2-1',
              matrix: 'bt709',
              fullRange: false,
            },
            endedEarly: false,
          },
        ],
      },
    },
    events: {},
    capture: {
      ...input.capture,
      requestedFps: input.requestedFps,
      droppedFrames: {},
    },
    integrity: { finalizedAt: null, recoveredFromCrash: false, truncatedToSec: null },
  };
}

export interface FinalizedTrackFacts {
  durationSec: number;
  frameCount: number;
  observedFps: number;
  /** Set when the track stopped before the user asked it to (§7.3, §7.4). */
  endedEarly: boolean;
  endReason?: VideoPart['endReason'];
}

/** The document a clean stop writes: the provisional one, with the real numbers. */
export function finalizedRecordingDoc(
  provisional: RecordingDoc,
  facts: FinalizedTrackFacts,
  droppedFrames: number,
  finalizedAt: string,
): RecordingDoc {
  const screen = provisional.tracks.screen;
  if (screen === undefined) throw new Error('recording.json has no screen track to finalize');
  const part = screen.parts[0];
  if (part === undefined) throw new Error('the screen track has no part to finalize');

  const rate: PartRate = { ...part.rate, observedFps: facts.observedFps };
  return {
    ...provisional,
    tracks: {
      ...provisional.tracks,
      screen: {
        ...screen,
        parts: [
          {
            ...part,
            durationSec: facts.durationSec,
            frameCount: facts.frameCount,
            rate,
            endedEarly: facts.endedEarly,
            ...(facts.endReason === undefined ? {} : { endReason: facts.endReason }),
          },
        ],
      },
    },
    capture: { ...provisional.capture, droppedFrames: { screen: droppedFrames } },
    integrity: { ...provisional.integrity, finalizedAt },
  };
}
