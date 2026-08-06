/**
 * `AudioSourceTrack` across a part boundary — §7.4's device-loss-and-reacquire.
 *
 * A track is a list of parts from day one, and one acquisition of a device is one
 * part: a microphone or a camera that vanishes closes its part, and the same device
 * coming back opens the next one with a `startTimeSec` of its own. The hole between
 * them lives in `recording.json` and is reproduced as silence of exactly its length
 * (§5.4 mechanism 5), never concatenated out.
 *
 * One output block is ~21 ms and a boundary falls wherever it falls, so at every seam
 * exactly one block spans two parts. Mixing only the first of them emitted everything
 * past that part's end as silence — small, silent, and permanent once it is in the
 * file, which is the class of error §5.4 mechanism 5 exists to prevent. So the
 * assertion here is about the *far side* of the seam, and the control is that the
 * hole between the parts is still silent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioPart } from '@loom/format';
import {
  AudioSourceTrack,
  type AudioDecoderCallbacks,
  type AudioDecoderFactory,
} from '../src/export/audio-source.ts';
import type { AudioPartMedia } from '../src/media/loom-media.ts';

const RATE = 48_000;
const FRAME = 1024;
const FRAMES = 24;
/** 0.512 s — twenty-four AAC frames. */
const PART_SEC = (FRAMES * FRAME) / RATE;
/** The hole a reacquire leaves. Deliberately shorter than one output block. */
const HOLE_SEC = 0.005;

/**
 * A stand-in for `EncodedAudioChunk`, which is a browser class and this suite runs
 * in node. It carries the bytes through untouched, which is all the fake decoder
 * below reads.
 */
class FakeEncodedAudioChunk {
  readonly type: string;
  readonly timestamp: number;
  readonly data: Uint8Array;
  constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}
beforeEach(() => {
  vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A decoder that decodes the byte it was handed.
 *
 * Every sample of a frame comes out as `data[0] / 255`, so a block of output says
 * which part produced it — which is the only thing these assertions need, and it says
 * it without an AAC encoder in the loop.
 */
const fakeDecoderFactory: AudioDecoderFactory = (callbacks: AudioDecoderCallbacks) => {
  let next = 0;
  const decoder = {
    state: 'unconfigured' as 'unconfigured' | 'configured' | 'closed',
    configure: (): void => {
      decoder.state = 'configured';
    },
    decode: (raw: EncodedAudioChunk): void => {
      const chunk = raw as unknown as FakeEncodedAudioChunk;
      const value = (chunk.data[0] ?? 0) / 255;
      callbacks.output({
        firstSample: next,
        length: FRAME,
        channels: [new Float32Array(FRAME).fill(value)],
      });
      next += FRAME;
    },
    reset: (): void => undefined,
    close: (): void => {
      decoder.state = 'closed';
    },
  };
  return decoder;
};

function part(startTimeSec: number): AudioPart {
  return {
    file: `media/mic.${startTimeSec}.m4a`,
    codec: 'mp4a.40.2',
    startTimeSec,
    durationSec: PART_SEC,
    endedEarly: false,
    sampleRate: RATE,
    channels: 1,
    measuredSampleRate: RATE,
    gaps: [],
  };
}

/** One part's encoded frames, every byte of them the same, so the value names the part. */
function media(byte: number): AudioPartMedia {
  return {
    config: { codec: 'mp4a.40.2', sampleRate: RATE, numberOfChannels: 1 },
    sampleRate: RATE,
    channels: 1,
    encoderDelaySamples: 0,
    samples: Array.from({ length: FRAMES }, (_unused, i) => ({
      data: new Uint8Array(64).fill(byte),
      firstSample: i * FRAME,
      sampleCount: FRAME,
    })),
  };
}

const FIRST_BYTE = 64;
const SECOND_BYTE = 192;
const FIRST_VALUE = FIRST_BYTE / 255;
const SECOND_VALUE = SECOND_BYTE / 255;

function track(parts: { part: AudioPart; media: AudioPartMedia }[]): AudioSourceTrack {
  return new AudioSourceTrack({ parts, decoderFactory: fakeDecoderFactory });
}

/** The block that straddles the seam: it starts inside the first part and ends inside the second. */
const BLOCK_START_SEC = PART_SEC - 0.01;
const BLOCK_SAMPLES = FRAME;

function at(seconds: number): number {
  return Math.round((seconds - BLOCK_START_SEC) * RATE);
}

describe('AudioSourceTrack across a part boundary', () => {
  it('mixes every part the block overlaps, not just the first', async () => {
    const source = track([
      { part: part(0), media: media(FIRST_BYTE) },
      { part: part(PART_SEC + HOLE_SEC), media: media(SECOND_BYTE) },
    ]);
    const out = [new Float32Array(BLOCK_SAMPLES)];
    await source.mixInto(out, BLOCK_START_SEC, BLOCK_SAMPLES, RATE, 1);
    source.close();

    const plane = out[0];
    expect(plane).toBeDefined();
    if (plane === undefined) return;

    // Before the seam: the first part.
    expect(plane[0]).toBeCloseTo(FIRST_VALUE, 5);
    expect(plane[at(PART_SEC - 0.001)]).toBeCloseTo(FIRST_VALUE, 5);

    // The hole between the two parts is silence of exactly its own length — the one
    // thing §5.4 mechanism 5 forbids closing.
    expect(plane[at(PART_SEC + HOLE_SEC / 2)]).toBe(0);

    // And after it, the second part. This is the assertion the bug failed: the tail
    // of the block came back as silence because only the first overlapping part was
    // ever mixed.
    expect(plane[at(PART_SEC + HOLE_SEC + 0.001)]).toBeCloseTo(SECOND_VALUE, 5);
    expect(plane[BLOCK_SAMPLES - 1]).toBeCloseTo(SECOND_VALUE, 5);

    // Every sample after the hole carries audio, not just the two that were probed.
    const tail = plane.slice(at(PART_SEC + HOLE_SEC) + 1);
    expect(tail.length).toBeGreaterThan(0);
    expect(Array.from(tail).filter((v) => v === 0)).toEqual([]);
  });

  it('control: with the second part absent, the same tail really is silence', async () => {
    // Without this, "it mixes the second part" and "it fills the tail with something"
    // read the same way round — and a track that invented audio where a device was
    // gone would pass the test above.
    const source = track([{ part: part(0), media: media(FIRST_BYTE) }]);
    const out = [new Float32Array(BLOCK_SAMPLES)];
    await source.mixInto(out, BLOCK_START_SEC, BLOCK_SAMPLES, RATE, 1);
    source.close();

    const plane = out[0];
    expect(plane).toBeDefined();
    if (plane === undefined) return;
    expect(plane[0]).toBeCloseTo(FIRST_VALUE, 5);
    const tail = plane.slice(at(PART_SEC + HOLE_SEC) + 1);
    expect(Array.from(tail).filter((v) => v !== 0)).toEqual([]);
  });

  it('adds, rather than overwrites, so two tracks mix into one buffer', async () => {
    const source = track([{ part: part(0), media: media(FIRST_BYTE) }]);
    const out = [new Float32Array(BLOCK_SAMPLES).fill(0.1)];
    await source.mixInto(out, 0, BLOCK_SAMPLES, RATE, 1);
    source.close();
    expect(out[0]?.[0]).toBeCloseTo(0.1 + FIRST_VALUE, 5);
  });
});
