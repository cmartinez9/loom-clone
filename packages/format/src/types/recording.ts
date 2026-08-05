/**
 * `recording.json` — what was captured. Architecture report §2.3.
 *
 * Immutable once `state` leaves `finalizing`. This file is the ground truth for
 * A/V sync. Five fields here are the ones the report says cost you a week if you
 * leave them out, and each is called out on its declaration below:
 * `startTimeSec`, `measuredSampleRate`, `gaps`, `rate.mode` and `endedEarly`.
 */

import type { IsoTimestamp, Seconds } from './common.ts';
import type { SchemaId } from '../schema.ts';

/**
 * The one timebase. All part `startTimeSec` values are offsets on this clock, and
 * the cursor/click logs share its origin (§2.5).
 */
export interface RecordingClock {
  kind: 'videoframe-timestamp-us';
  t0Us: number;
}

export interface DisplayInfo {
  id: number;
  name: string;
  /** Points. Cursor positions are normalized against this. */
  logicalSize: [number, number];
  /** Backing pixels — what the encoder actually sees. */
  pixelSize: [number, number];
  scaleFactor: number;
  colorSpace: string;
}

/**
 * `rate.mode: "variable"` is not a detail. ScreenCaptureKit only emits frames when
 * the screen changes — the research scout measured **1.4 fps on an idle desktop**
 * and 29.4 fps on heavy animation. The screen track is genuinely VFR and every
 * downstream component must know it.
 */
export interface PartRate {
  mode: 'variable' | 'constant';
  nominalFps: number;
  observedFps: number;
}

/** MP4 `colr` box contents, so the compositor can reproduce the source's colour. */
export interface ColrInfo {
  primaries: string;
  transfer: string;
  matrix: string;
  fullRange: boolean;
}

/** Why a part stopped before the recording did. */
export type PartEndReason = 'device-lost' | 'permission-revoked' | 'disk-full' | 'crash';

interface PartBase {
  /** Bundle-relative path, e.g. `media/screen.000.mp4`. */
  file: string;
  codec: string;
  /**
   * Offset of this part's first sample on the recording clock. Screen, camera and
   * mic genuinely start at different instants; this is the whole A/V sync
   * mechanism (§5.4). Omitting it is how you chase sync forever.
   */
  startTimeSec: Seconds;
  durationSec: Seconds;
  /**
   * A webcam unplug must not invalidate the recording — the part closes, is marked
   * here, and the next part opens with its own `startTimeSec` (§7.4).
   */
  endedEarly: boolean;
  endReason?: PartEndReason;
}

export interface VideoPart extends PartBase {
  /** Bundle-relative path to the frame index sidecar, e.g. `media/screen.000.index.json`. */
  index: string;
  size: [number, number];
  frameCount: number;
  rate: PartRate;
  colr?: ColrInfo;
}

/**
 * Where audio was actually missing. Reproduce a gap as silence of *exactly* that
 * length; concatenating around it is how drift is born (§2.3).
 */
export interface AudioGap {
  atSec: Seconds;
  durationSec: Seconds;
  cause: string;
}

export interface AudioPart extends PartBase {
  sampleRate: number;
  channels: number;
  /**
   * A "48 kHz" device is not 48000.000 Hz. At 48000.37 measured, a 30-minute
   * recording drifts 13.9 ms; at a plausible 50 ppm worst case, 90 ms (§5.5).
   */
  measuredSampleRate: number;
  gaps: AudioGap[];
}

export interface VideoTrackDoc {
  kind: 'video';
  deviceId?: string;
  deviceName?: string;
  parts: VideoPart[];
}

export interface AudioTrackDoc {
  kind: 'audio';
  deviceId?: string;
  deviceName?: string;
  /** `'getdisplaymedia-loopback'` for the system track (research report §5.2). */
  source?: string;
  /**
   * The system-audio track defaults to mono with AEC + NS + AGC enabled and will
   * wreck any recording containing music or video (research trap 3). The
   * constraints actually used are persisted so a bad recording is diagnosable.
   */
  constraints?: {
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
    channelCount: number;
  };
  parts: AudioPart[];
}

export interface RecordingTracks {
  screen?: VideoTrackDoc;
  webcam?: VideoTrackDoc;
  mic?: AudioTrackDoc;
  system?: AudioTrackDoc;
}

export interface RecordingEvents {
  cursor?: { file: string; hz: number; sampleCount: number };
  /**
   * `available: false` and a missing file mean different things, and the format
   * distinguishes them (§7.3). Clicks need the Accessibility permission; position
   * does not.
   */
  clicks?: { file: string; available: boolean; source: string };
  drawing?: { file: string; strokeCount: number };
  /** Bundle-relative path to `cursors/index.json`. */
  cursorImages?: string;
}

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted';

export interface CaptureInfo {
  /** App version that produced the capture. */
  app: string;
  /** macOS version string. */
  os: string;
  permissions: {
    screen: PermissionState;
    camera: PermissionState;
    microphone: PermissionState;
    accessibility: boolean;
  };
  requestedFps: number;
  /** Research trap 9 — unclamped 6K/8K capture overwhelms encoder and disk. */
  resolutionClamp: string;
  droppedFrames: Partial<Record<'screen' | 'webcam', number>>;
}

export interface IntegrityInfo {
  finalizedAt: IsoTimestamp | null;
  recoveredFromCrash: boolean;
  /** Set by crash recovery (§7.1) to the shortest common duration across tracks. */
  truncatedToSec: Seconds | null;
}

export interface RecordingDoc {
  schema: SchemaId;
  clock: RecordingClock;
  display: DisplayInfo;
  tracks: RecordingTracks;
  events: RecordingEvents;
  capture: CaptureInfo;
  integrity: IntegrityInfo;
}
