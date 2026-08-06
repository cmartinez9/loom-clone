/**
 * The audio half of an export: decode both source tracks, apply the resolved gains,
 * mix, and hand 1024-sample blocks to an `AudioEncoder`.
 *
 * §5.3: *"Decode both source tracks to `AudioData`, apply `resolve().audio` gains
 * sample-accurate, mix, resample to the video timebase (§5.5), encode with
 * `AudioEncoder` at `mp4a.40.2`."* Three of those four are in
 * {@link AudioSourceTrack} — the resample *is* reading at `measuredSampleRate`, and
 * the gaps fall out of `audioRuns` — so what is left here is the timeline: turning
 * an output instant into the source instant the clip list puts under it, and asking
 * each track for that.
 *
 * ## Two grids, stated rather than assumed
 *
 * **Samples are read at the output rate**, one at a time, from a position that
 * advances by the clip's speed. That is sample-accurate in the sense §5.3 asks for:
 * nothing is block-quantised on the way in.
 *
 * **Gain and clip speed are resolved once per encoded frame** — 1024 samples, 21 ms
 * at 48 kHz — because an AAC frame is the smallest thing an encoder will take and
 * splitting one at a clip boundary is not a thing the format allows. A cut that
 * lands mid-frame therefore interpolates across itself rather than being a hard
 * edge, and a gain automation curve is sampled at 47 Hz. Both are stated here
 * because §4.5 puts *"audio gain"* on the list preview and export may not disagree
 * about: when the editor grows an audio playback path it must read gains through
 * {@link blockState}, not re-derive them.
 */

import { resolve, type CompiledTimeline } from '@loom/edl';
import type { Seconds } from '@loom/format';
import { AAC_FRAME_SAMPLES } from '@loom/mux';
import type { AudioSourceTrack } from './audio-source.ts';
import { ExportCancelledError } from './render-loop.ts';

export { AAC_FRAME_SAMPLES };

/** One encoded frame's worth of mixed audio, planar f32. */
export interface MixedAudioBlock {
  /** 0-based encoded frame number. */
  index: number;
  /** One array per output channel, `AAC_FRAME_SAMPLES` long. */
  channels: Float32Array[];
  /** Microseconds on the output timeline. */
  timestampUs: number;
}

/** What the timeline says about one block. Shared so a future preview reads the same. */
export interface BlockState {
  /** Source-clock instant of the block's first sample. */
  sourceStartSec: Seconds;
  /**
   * Source seconds per timeline second across this block — the clip's speed, taken
   * as a difference rather than read off a clip, so a block that straddles a cut
   * gets the average rather than one side's.
   */
  speed: number;
  micGain: number;
  systemGain: number;
}

export function blockState(
  timeline: CompiledTimeline,
  fromSec: Seconds,
  toSec: Seconds,
): BlockState {
  const start = resolve(timeline, fromSec);
  const sourceStartSec = start.sourceTime;
  const micGain = start.audio.micGain;
  const systemGain = start.audio.systemGain;
  const end = resolve(timeline, toSec);
  const span = toSec - fromSec;
  const speed = span > 0 ? (end.sourceTime - sourceStartSec) / span : 1;
  // A backwards or zero span means the block sits past the end of the timeline, or
  // straddles a cut that jumps backwards. Reading at 1× from the start is the only
  // answer that does not run the source backwards through the interpolator.
  return { sourceStartSec, speed: speed > 0 ? speed : 1, micGain, systemGain };
}

export interface AudioPassOptions {
  timeline: CompiledTimeline;
  mic: AudioSourceTrack | null;
  system: AudioSourceTrack | null;
  /** Output rate. 48 kHz unless a source says otherwise. */
  sampleRate: number;
  channels: number;
  /** Called per encoded frame's worth of samples, in order. Awaited for backpressure. */
  onBlock: (block: MixedAudioBlock) => Promise<void> | void;
  onProgress?: (renderedSec: Seconds, totalSec: Seconds) => void;
  signal?: AbortSignal;
}

export interface AudioPassReport {
  blocks: number;
  sampleRate: number;
  channels: number;
  durationSec: Seconds;
}

/**
 * Produce the whole mixed track, block by block.
 *
 * The block count covers the timeline's full duration rounded **up**, so the last
 * fraction of a second is not silently dropped; AAC pads its final frame anyway, and
 * a track one frame short of the video is 21 ms of missing audio at the end of every
 * export.
 */
export async function runAudioPass(options: AudioPassOptions): Promise<AudioPassReport> {
  const { timeline, sampleRate, channels } = options;
  const totalSec = timeline.durationSec;
  const blocks = Math.max(1, Math.ceil((totalSec * sampleRate) / AAC_FRAME_SAMPLES));

  // Allocated once and cleared per block: an export of an hour is 170,000 blocks and
  // a fresh pair of Float32Arrays for each is 170,000 allocations of 4 KB.
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel++) {
    planes.push(new Float32Array(AAC_FRAME_SAMPLES));
  }

  for (let index = 0; index < blocks; index++) {
    if (options.signal?.aborted === true) throw new ExportCancelledError();
    const fromSec = (index * AAC_FRAME_SAMPLES) / sampleRate;
    const toSec = ((index + 1) * AAC_FRAME_SAMPLES) / sampleRate;
    const state = blockState(timeline, fromSec, toSec);

    for (const plane of planes) plane.fill(0);
    // The source advances `speed` seconds per output second, so one output sample is
    // `speed / sampleRate` of source — which is the same as reading at a rate of
    // `sampleRate / speed`.
    const readRate = sampleRate / state.speed;
    if (options.mic !== null) {
      await options.mic.mixInto(
        planes,
        state.sourceStartSec,
        AAC_FRAME_SAMPLES,
        readRate,
        state.micGain,
      );
    }
    if (options.system !== null) {
      await options.system.mixInto(
        planes,
        state.sourceStartSec,
        AAC_FRAME_SAMPLES,
        readRate,
        state.systemGain,
      );
    }
    // Two tracks summed can exceed unity even at unity gain, and a float sample past
    // ±1 is a hard clip in the encoder rather than a warning. Limiting here keeps the
    // damage to the sample that caused it.
    for (const plane of planes) {
      for (let i = 0; i < plane.length; i++) {
        const value = plane[i] ?? 0;
        if (value > 1) plane[i] = 1;
        else if (value < -1) plane[i] = -1;
      }
    }

    await options.onBlock({
      index,
      channels: planes,
      timestampUs: Math.round((index * AAC_FRAME_SAMPLES * 1e6) / sampleRate),
    });
    options.onProgress?.(Math.min(totalSec, toSec), totalSec);
  }

  return { blocks, sampleRate, channels, durationSec: (blocks * AAC_FRAME_SAMPLES) / sampleRate };
}
