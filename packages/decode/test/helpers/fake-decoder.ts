/**
 * A `VideoDecoderLike` and a `ClosableFrame` for tests that run in Node.
 *
 * These exist so the seek rule, the discard rule and — above all — the frame
 * lifetimes can be checked deterministically, including the paths that are hard to
 * provoke against a real decoder: an error mid-decode, a reset that races an
 * output, a cancellation between the byte read and the submit.
 *
 * They are not a second decode path. `SourceReader` is the only decode path and
 * these substitute for the twenty lines that bind it to WebCodecs — see
 * `packages/decode/src/decoder.ts`. The fixture gate runs the same `SourceReader`
 * against the real `VideoDecoder`.
 *
 * The fake is deliberately *stricter* than WebCodecs in one way: it refuses a delta
 * chunk that does not follow a keyframe. A real decoder would emit garbage or
 * nothing; a test wants to be told.
 */

import type { ChunkInit, DecoderCallbacks, VideoDecoderLike } from '../../src/decoder.ts';
import type { ClosableFrame } from '../../src/frames.ts';

/** Every frame the fakes have ever produced, so a test can assert none leaked. */
export class FrameCensus {
  readonly frames: FakeFrame[] = [];

  make(timestamp: number, payload: number): FakeFrame {
    const frame = new FakeFrame(timestamp, payload, this);
    this.frames.push(frame);
    return frame;
  }

  get open(): FakeFrame[] {
    return this.frames.filter((frame) => !frame.closed);
  }

  get closedCount(): number {
    return this.frames.filter((frame) => frame.closed).length;
  }

  /** Frames closed more than once — a double-free, which WebCodecs would throw on. */
  get doubleClosed(): FakeFrame[] {
    return this.frames.filter((frame) => frame.closeCount > 1);
  }
}

export class FakeFrame implements ClosableFrame {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    /** The frame number this frame was decoded from, so tests can identify it. */
    readonly payload: number,
    private readonly census: FrameCensus,
  ) {
    void this.census;
  }

  get closed(): boolean {
    return this.closeCount > 0;
  }

  close(): void {
    this.closeCount += 1;
  }
}

export interface FakeDecoderOptions {
  census: FrameCensus;
  /** Turns a chunk into the frame number it decodes to. Defaults to the timestamp. */
  payloadOf?: (chunk: ChunkInit) => number;
  /** Called before each decode; return an Error to make the decoder fail. */
  failOn?: (chunk: ChunkInit, ordinal: number) => Error | null;
  /** Emit outputs synchronously instead of on a microtask. */
  synchronous?: boolean;
}

export interface FakeDecoder extends VideoDecoderLike {
  readonly configureCount: number;
  readonly resetCount: number;
  readonly submitted: ChunkInit[];
}

export function fakeDecoderFactory(
  options: FakeDecoderOptions,
): (callbacks: DecoderCallbacks<FakeFrame>) => FakeDecoder {
  const payloadOf = options.payloadOf ?? ((chunk: ChunkInit) => chunk.timestamp);

  return (callbacks) => {
    let state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    let pending: ChunkInit[] = [];
    let draining: Promise<void> | null = null;
    let configureCount = 0;
    let resetCount = 0;
    let sawKeyframe = false;
    let ordinal = 0;
    const submitted: ChunkInit[] = [];

    function emit(chunk: ChunkInit): void {
      if (state !== 'configured') return;
      const failure = options.failOn?.(chunk, ordinal) ?? null;
      ordinal += 1;
      if (failure !== null) {
        state = 'closed';
        pending = [];
        callbacks.error(failure);
        return;
      }
      if (chunk.type === 'key') sawKeyframe = true;
      else if (!sawKeyframe) {
        state = 'closed';
        callbacks.error(new Error(`delta chunk at ${String(chunk.timestamp)} before any keyframe`));
        return;
      }
      callbacks.output(options.census.make(chunk.timestamp, payloadOf(chunk)));
    }

    function drain(): void {
      if (options.synchronous === true) {
        while (pending.length > 0) {
          const chunk = pending.shift();
          if (chunk !== undefined) emit(chunk);
        }
        return;
      }
      draining ??= Promise.resolve().then(() => {
        draining = null;
        const batch = pending;
        pending = [];
        for (const chunk of batch) emit(chunk);
      });
    }

    return {
      get state() {
        return state;
      },
      get decodeQueueSize() {
        return pending.length;
      },
      get configureCount() {
        return configureCount;
      },
      get resetCount() {
        return resetCount;
      },
      get submitted() {
        return submitted;
      },
      configure() {
        if (state === 'closed') throw new Error('configure on a closed decoder');
        state = 'configured';
        configureCount += 1;
        sawKeyframe = false;
      },
      decode(chunk) {
        if (state !== 'configured') throw new Error('decode before configure');
        submitted.push(chunk);
        pending.push(chunk);
        drain();
      },
      reset() {
        resetCount += 1;
        pending = [];
        sawKeyframe = false;
        if (state !== 'closed') state = 'unconfigured';
      },
      close() {
        state = 'closed';
        pending = [];
      },
    };
  };
}
