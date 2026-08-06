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
 * recorded, at what scale factor, with which permissions granted, which camera was
 * plugged in, or what constraints the system-audio track was held to. Those facts
 * are only knowable while the capture is running, and a process that has been
 * `SIGKILL`ed is not running.
 *
 * So the document is written **before the first frame**, carrying everything only
 * the live session knows, with the durations and counts at zero. A clean stop
 * replaces it with the real numbers; a crash leaves recovery with a document it
 * only has to correct, rather than one it has to invent.
 *
 * ## Why it is built a track and a part at a time
 *
 * The display and the permissions are known when the user presses record. The
 * screen's codec and coded size are known when its encoder emits its first chunk.
 * The microphone's device name, sample rate and — the one that matters — the voice
 * processing macOS actually applied are known when *its* encoder does, which may
 * be before or after the screen's. And the camera may announce itself twice: §7.4's
 * unplug closes `webcam.000.mp4` and opens `webcam.001.mp4` in the middle of a
 * recording, with no warning and nothing to predict it from.
 *
 * Rather than guess an order, each part is added to the document as it announces
 * itself, and the document is rewritten. A handful of small atomic writes over a
 * recording is not a cost worth optimising against a fact that would otherwise have
 * to be invented later.
 */

import { currentSchemaId, isoTimestamp, mediaPartPath } from '@loom/format';
import type {
  AudioPartTiming,
  AudioTrackDoc,
  AudioTrackKey,
  CaptureInfo,
  DisplayInfo,
  PartEndReason,
  RecordingDoc,
  RecordingEvents,
  VideoPart,
  VideoTrackDoc,
  VideoTrackKey,
} from '@loom/format';
import type { AudioTrackFacts, VideoTrackFacts } from '@loom/ipc';

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
 * `startTimeSec` is an offset from that origin, which is exactly what the camera,
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
  track: VideoTrackKey;
  /** Bundle-relative paths from `ProjectStore.beginMediaPart`. */
  file: string;
  index: string;
  codec: string;
  size: [number, number];
  /** Nominal rate for this track — the screen's and the camera's differ. */
  requestedFps: number;
  /**
   * ScreenCaptureKit emits frames only when the screen changes — 1.4 fps on an
   * idle desktop, 29.4 under load (research report §5.1) — so the screen track is
   * variable-rate from the first byte and every downstream component has to know
   * it (§2.3). A camera is a clock: it delivers at its nominal rate whether or not
   * anything in front of it moves.
   */
  rateMode: 'variable' | 'constant';
  /**
   * Where this part starts on the recording clock, as well as it can be known
   * before the part has been recorded.
   *
   * Zero for a first part, which is what the §5.4 mechanism 3 snap produces for an
   * ordinary recording anyway. For `webcam.001.mp4` it is emphatically **not**
   * zero, and writing zero here would leave a crash-recovered second part sitting
   * on top of the first for the length of the recording. A clean stop overwrites it
   * with the measured value.
   */
  startTimeSec: number;
  /** The camera's identity. Absent for the screen, whose identity is the display. */
  facts?: VideoTrackFacts;
}

/**
 * Declare a video part, with the codec and size its encoder chose.
 *
 * Appends when the track already exists, which is the §7.4 case: the camera came
 * back and this is `webcam.001.mp4`. Parts are kept in the order they were opened,
 * which is also the order they occupy on the recording clock.
 */
export function withVideoPart(doc: RecordingDoc, input: ProvisionalVideoInput): RecordingDoc {
  const existing = doc.tracks[input.track];
  const part: VideoPart = {
    file: input.file,
    index: input.index,
    codec: input.codec,
    size: input.size,
    startTimeSec: input.startTimeSec,
    durationSec: 0,
    frameCount: 0,
    rate: { mode: input.rateMode, nominalFps: input.requestedFps, observedFps: 0 },
    colr: {
      primaries: 'bt709',
      transfer: 'iec61966-2-1',
      matrix: 'bt709',
      fullRange: false,
    },
    endedEarly: false,
  };
  const track: VideoTrackDoc = {
    kind: 'video',
    ...(input.facts?.deviceId == null ? {} : { deviceId: input.facts.deviceId }),
    ...(input.facts?.deviceName == null ? {} : { deviceName: input.facts.deviceName }),
    parts: [...(existing?.parts ?? []), part],
  };
  return { ...doc, tracks: { ...doc.tracks, [input.track]: track } };
}

export interface ClosedVideoPartInput {
  track: VideoTrackKey;
  /** Which part of its track closed — the index in `webcam.000.mp4`. */
  part: number;
  durationSec: number;
  frameCount: number;
  observedFps: number;
  endedEarly: boolean;
  endReason?: PartEndReason;
}

/**
 * Record that one part has closed, while the rest of the recording carries on.
 *
 * §7.4's unplug closes `webcam.000.mp4` in the middle of a recording. Until that is
 * written down, `recording.json` still describes the part as open and empty — and a
 * crash before the next stop leaves recovery with no way to tell a camera that
 * ended when the cable moved from a track whose tail the crash took, which is the
 * difference between reporting six seconds recovered and truncating the recording
 * to two.
 *
 * `startTimeSec` is deliberately not touched: it is a difference between two
 * clocks, and the reference track's half is not known until the capture page stops
 * (see `session.ts`'s `closeVideoPart`). The provisional value the part was
 * announced with is still the best answer until then.
 *
 * Matched on the part's file, which carries its index — never on position, for the
 * reason {@link finalizedVideoTrack} gives.
 */
export function withClosedVideoPart(doc: RecordingDoc, input: ClosedVideoPartInput): RecordingDoc {
  const track = doc.tracks[input.track];
  if (track === undefined) return doc;
  const file = mediaPartPath(input.track, input.part);
  let found = false;
  const parts = track.parts.map((part): VideoPart => {
    if (part.file !== file) return part;
    found = true;
    return {
      ...part,
      durationSec: input.durationSec,
      frameCount: input.frameCount,
      rate: { ...part.rate, observedFps: input.observedFps },
      endedEarly: input.endedEarly,
      ...(input.endReason === undefined ? {} : { endReason: input.endReason }),
    };
  });
  if (!found) return doc;
  return { ...doc, tracks: { ...doc.tracks, [input.track]: { ...track, parts } } };
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

/** What one finished video part knows about itself. */
export interface FinalizedVideoPartFacts {
  /** Which part of its track this is — the index in `webcam.001.mp4`. */
  part: number;
  startTimeSec: number;
  durationSec: number;
  frameCount: number;
  observedFps: number;
  /** Set when the part stopped before the user asked it to (§7.3, §7.4). */
  endedEarly: boolean;
  endReason?: PartEndReason;
}

/** What a finished video track knows about itself: its parts, in order. */
export interface FinalizedVideoTrackFacts {
  parts: FinalizedVideoPartFacts[];
  /** Frames the encoder could not keep up with, across every part. */
  droppedFrames: number;
}

/** What a finished audio track knows about itself, from `alignAudioPart`. */
export interface FinalizedAudioFacts {
  timing: AudioPartTiming;
  endedEarly: boolean;
  endReason?: PartEndReason;
}

export interface FinalizedFacts {
  /** One entry per video track that produced frames. `screen` is required. */
  video: { screen: FinalizedVideoTrackFacts; webcam?: FinalizedVideoTrackFacts };
  /** One entry per audio track that produced samples. */
  audio?: Partial<Record<AudioTrackKey, FinalizedAudioFacts>>;
  /**
   * What the input sampler wrote (§2.5), from `InputSampler.recordingEvents()`.
   *
   * Absent when no sampler ran, which leaves whatever the provisional document said
   * — `{}` for a recording that never sampled, and the fragment the sampler declared
   * at its start for one whose stop could not read it back. Never synthesised here:
   * `clicks.available` is a claim about a whole session and only the sampler that
   * ran it can make it.
   */
  events?: RecordingEvents;
}

/** The document a clean stop writes: the provisional one, with the real numbers. */
export function finalizedRecordingDoc(
  provisional: RecordingDoc,
  facts: FinalizedFacts,
  finalizedAt: string = isoTimestamp(),
): RecordingDoc {
  const screen = finalizedVideoTrack('screen', provisional.tracks.screen, facts.video.screen);
  if (screen === null) throw new Error('recording.json has no screen track to finalize');
  const webcam = finalizedVideoTrack('webcam', provisional.tracks.webcam, facts.video.webcam);

  // The provisional tracks are replaced rather than merged over: a track that
  // captured nothing has to leave the document entirely, and spreading the
  // provisional ones first would leave it behind claiming zero samples.
  const { screen: _screen, webcam: _webcam, mic: _mic, system: _system } = provisional.tracks;
  return {
    ...provisional,
    tracks: {
      screen,
      ...(webcam === null ? {} : { webcam }),
      ...finalizedAudioTracks(provisional, facts.audio ?? {}),
    },
    ...(facts.events === undefined ? {} : { events: facts.events }),
    capture: {
      ...provisional.capture,
      droppedFrames: {
        screen: facts.video.screen.droppedFrames,
        ...(facts.video.webcam === undefined ? {} : { webcam: facts.video.webcam.droppedFrames }),
      },
    },
    integrity: { ...provisional.integrity, finalizedAt },
  };
}

/**
 * Fill in one video track's measurements, part by part, and drop a track that
 * captured nothing.
 *
 * Dropped rather than left at zero: the format says a track has at least one part,
 * and a part claiming zero frames of a file that may not even exist is a document
 * that misleads the editor about what it has to composite. A camera that was asked
 * for and never opened leaves `recording.json` with no `webcam` key at all, which
 * is the honest description of a recording that has no camera in it.
 *
 * A part the provisional document knows about but the facts do not is dropped the
 * same way — that is a part whose file was created and never written to.
 */
function finalizedVideoTrack(
  track: VideoTrackKey,
  provisional: VideoTrackDoc | undefined,
  facts: FinalizedVideoTrackFacts | undefined,
): VideoTrackDoc | null {
  if (provisional === undefined || facts === undefined) return null;
  const parts: VideoPart[] = [];
  for (const part of provisional.parts) {
    // Paired on the file, which carries the part's own index — never on position
    // in the list. A part that was announced and failed to open leaves a hole, and
    // pairing by position would then describe every later part with the previous
    // one's timing: `webcam.001.mp4` given `webcam.000.mp4`'s `startTimeSec` is
    // exactly the defect the phase 4 gate exists to catch.
    const measured = facts.parts.find(
      (candidate) => mediaPartPath(track, candidate.part) === part.file,
    );
    if (measured === undefined || measured.frameCount === 0) continue;
    parts.push({
      ...part,
      startTimeSec: measured.startTimeSec,
      durationSec: measured.durationSec,
      frameCount: measured.frameCount,
      rate: { ...part.rate, observedFps: measured.observedFps },
      endedEarly: measured.endedEarly,
      ...(measured.endReason === undefined ? {} : { endReason: measured.endReason }),
    });
  }
  return parts.length === 0 ? null : { ...provisional, parts };
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
