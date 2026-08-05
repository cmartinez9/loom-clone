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
 * recorded, at what scale factor, with which permissions granted, or what
 * constraints the system-audio track was held to. Those facts are only knowable
 * while the capture is running, and a process that has been `SIGKILL`ed is not
 * running.
 *
 * So the document is written **before the first frame**, carrying everything only
 * the live session knows, with the durations and counts at zero. A clean stop
 * replaces it with the real numbers; a crash leaves recovery with a document it
 * only has to correct, rather than one it has to invent.
 *
 * ## Why it is built in three steps
 *
 * The display and the permissions are known when the user presses record. The
 * screen's codec and coded size are known when its encoder emits its first chunk.
 * The microphone's device name, sample rate and — the one that matters — the voice
 * processing macOS actually applied are known when *its* encoder does, which may
 * be before or after the screen's. Rather than guess an order, each track is added
 * to the document as it announces itself, and the document is rewritten. Three
 * small atomic writes at the start of a recording is not a cost worth optimising
 * against a fact that would otherwise have to be invented later.
 */

import { currentSchemaId, isoTimestamp } from '@loom/format';
import type {
  AudioPartTiming,
  AudioTrackDoc,
  AudioTrackKey,
  CaptureInfo,
  DisplayInfo,
  PartEndReason,
  PartRate,
  RecordingDoc,
  VideoPart,
} from '@loom/format';
import type { AudioTrackFacts } from '@loom/ipc';

export interface ProvisionalRecordingInput {
  display: DisplayInfo;
  requestedFps: number;
  capture: Omit<CaptureInfo, 'requestedFps' | 'droppedFrames'>;
}

/**
 * The document a recording announces itself with, before any track exists.
 *
 * `clock.t0Us: 0` — the recording clock's origin **is** the first screen frame.
 * The alternative, storing the encoder's raw first timestamp, buys nothing and
 * costs a rewrite of this document after the first frame arrives. Every part's
 * `startTimeSec` is an offset from that origin, which is exactly what the
 * microphone and system tracks need (§5.4 mechanism 2).
 */
export function provisionalRecordingDoc(input: ProvisionalRecordingInput): RecordingDoc {
  return {
    schema: currentSchemaId('loom.recording'),
    clock: { kind: 'videoframe-timestamp-us', t0Us: 0 },
    display: input.display,
    tracks: {},
    events: {},
    capture: {
      ...input.capture,
      requestedFps: input.requestedFps,
      droppedFrames: {},
    },
    integrity: { finalizedAt: null, recoveredFromCrash: false, truncatedToSec: null },
  };
}

export interface ProvisionalVideoInput {
  /** Bundle-relative paths from `ProjectStore.beginMediaPart`. */
  file: string;
  index: string;
  codec: string;
  size: [number, number];
  requestedFps: number;
}

/** Declare the screen track, with the codec and size its encoder chose. */
export function withScreenTrack(doc: RecordingDoc, input: ProvisionalVideoInput): RecordingDoc {
  return {
    ...doc,
    tracks: {
      ...doc.tracks,
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
  };
}

export interface ProvisionalAudioInput {
  track: AudioTrackKey;
  /** Bundle-relative path from `ProjectStore.beginAudioPart`. */
  file: string;
  codec: string;
  sampleRate: number;
  channels: number;
  /** Device, source and the constraints the platform actually applied (trap 3). */
  facts: AudioTrackFacts;
}

/**
 * Declare an audio track, with the constraints its device actually honoured.
 *
 * `constraints` is written from `getSettings()`, not from what was asked for.
 * Research trap 3 is that macOS hands back a mono, echo-cancelled, noise-suppressed
 * loopback unless told otherwise; recording what was *requested* would hide exactly
 * the case the field exists to expose.
 *
 * `measuredSampleRate` starts at the nominal rate because nothing has been measured
 * yet — one buffer is not a rate (§5.5). A clean stop replaces it; a crash leaves
 * it, and a recording recovered from a crash says so in `integrity`.
 */
export function withAudioTrack(doc: RecordingDoc, input: ProvisionalAudioInput): RecordingDoc {
  const track: AudioTrackDoc = {
    kind: 'audio',
    ...(input.facts.deviceId === null ? {} : { deviceId: input.facts.deviceId }),
    ...(input.facts.deviceName === null ? {} : { deviceName: input.facts.deviceName }),
    ...(input.facts.source === null ? {} : { source: input.facts.source }),
    constraints: {
      echoCancellation: input.facts.settings.echoCancellation,
      noiseSuppression: input.facts.settings.noiseSuppression,
      autoGainControl: input.facts.settings.autoGainControl,
      channelCount: input.facts.settings.channelCount,
    },
    parts: [
      {
        file: input.file,
        codec: input.codec,
        sampleRate: input.sampleRate,
        channels: input.channels,
        startTimeSec: 0,
        durationSec: 0,
        measuredSampleRate: input.sampleRate,
        gaps: [],
        endedEarly: false,
      },
    ],
  };
  return { ...doc, tracks: { ...doc.tracks, [input.track]: track } };
}

export interface FinalizedTrackFacts {
  durationSec: number;
  frameCount: number;
  observedFps: number;
  /** Set when the track stopped before the user asked it to (§7.3, §7.4). */
  endedEarly: boolean;
  endReason?: PartEndReason;
}

/** What a finished audio track knows about itself, from `alignAudioPart`. */
export interface FinalizedAudioFacts {
  timing: AudioPartTiming;
  endedEarly: boolean;
  endReason?: PartEndReason;
}

export interface FinalizedFacts {
  screen: FinalizedTrackFacts;
  /** One entry per audio track that produced samples. */
  audio?: Partial<Record<AudioTrackKey, FinalizedAudioFacts>>;
}

/** The document a clean stop writes: the provisional one, with the real numbers. */
export function finalizedRecordingDoc(
  provisional: RecordingDoc,
  facts: FinalizedFacts,
  droppedFrames: number,
  finalizedAt: string = isoTimestamp(),
): RecordingDoc {
  const screen = provisional.tracks.screen;
  if (screen === undefined) throw new Error('recording.json has no screen track to finalize');
  const part = screen.parts[0];
  if (part === undefined) throw new Error('the screen track has no part to finalize');

  const rate: PartRate = { ...part.rate, observedFps: facts.screen.observedFps };
  const finalizedScreen: VideoPart = {
    ...part,
    durationSec: facts.screen.durationSec,
    frameCount: facts.screen.frameCount,
    rate,
    endedEarly: facts.screen.endedEarly,
    ...(facts.screen.endReason === undefined ? {} : { endReason: facts.screen.endReason }),
  };

  // The provisional audio tracks are replaced rather than merged over: a track
  // that captured nothing has to leave the document entirely, and spreading the
  // provisional tracks first would leave it behind claiming zero samples.
  const { mic: _mic, system: _system, ...others } = provisional.tracks;
  return {
    ...provisional,
    tracks: {
      ...others,
      screen: { ...screen, parts: [finalizedScreen] },
      ...finalizedAudioTracks(provisional, facts.audio ?? {}),
    },
    capture: { ...provisional.capture, droppedFrames: { screen: droppedFrames } },
    integrity: { ...provisional.integrity, finalizedAt },
  };
}

/**
 * Fill in each audio track's measurements, and drop a track that captured nothing.
 *
 * Dropped rather than left at zero: the format says a track has at least one part,
 * and a part claiming zero samples of a file that may not even exist is a document
 * that misleads the exporter about what it has to mix.
 */
function finalizedAudioTracks(
  provisional: RecordingDoc,
  audio: Partial<Record<AudioTrackKey, FinalizedAudioFacts>>,
): Partial<Record<AudioTrackKey, AudioTrackDoc>> {
  const out: Partial<Record<AudioTrackKey, AudioTrackDoc>> = {};
  for (const key of ['mic', 'system'] as const) {
    const track = provisional.tracks[key];
    const part = track?.parts[0];
    if (track === undefined || part === undefined) continue;
    const facts = audio[key];
    if (facts === undefined || facts.timing.durationSec <= 0) continue;
    out[key] = {
      ...track,
      parts: [
        {
          ...part,
          startTimeSec: facts.timing.startTimeSec,
          durationSec: facts.timing.durationSec,
          measuredSampleRate: facts.timing.measuredSampleRate,
          gaps: facts.timing.gaps,
          endedEarly: facts.endedEarly,
          ...(facts.endReason === undefined ? {} : { endReason: facts.endReason }),
        },
      ],
    };
  }
  return out;
}
