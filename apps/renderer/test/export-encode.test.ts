/**
 * The encoders' backpressure, and the watchdog on it.
 *
 * §5.3's `while (encoder.encodeQueueSize > 8) await nextOutput()` waits on the
 * platform encoder's *output* callback rather than on a clock, which is right — and
 * is only safe while something is guaranteed to call it. A `VideoEncoder` whose
 * VideoToolbox backend goes away calls neither `output` nor `error`: the GPU process
 * takes the encoder, the queue and the `error` callback's pipe with it. An unbounded
 * wait there is §10.2's named symptom exactly — *"an export that hangs at 40% with no
 * error"* — and the phase-8 gate met it on CI, where a lost GPU process turned a
 * four-second run into a 480-second timeout with nothing to read.
 *
 * So both waits carry a deadline, and both of these tests have a control beside them:
 * an encoder that *is* producing output must not be given up on, or the watchdog is
 * just a shorter export.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AudioExportEncoder,
  ENCODE_STALL_TIMEOUT_MS,
  ExportEncodeStallError,
  VideoExportEncoder,
} from '../src/export/encode.ts';

/** More than §5.3's `MAX_QUEUE` of 8, so `drain` has to wait. */
const FULL_QUEUE = 9;

interface Callbacks {
  output: (chunk: unknown, metadata?: unknown) => void;
  error: (error: DOMException) => void;
}

/**
 * A stand-in for the platform encoder, which is a browser class and this suite runs
 * in node.
 *
 * It never emits anything on its own: each test drives `emit` itself, so "the encoder
 * stopped" and "the encoder is working" are the same object with and without a call.
 */
class FakeEncoder {
  static readonly instances: FakeEncoder[] = [];
  static supported = true;

  state = 'configured';
  encodeQueueSize = 0;
  flushes = 0;
  /** Resolves the pending `flush()`, or never — which is the case under test. */
  #settleFlush: (() => void) | null = null;
  readonly #callbacks: Callbacks;

  constructor(callbacks: Callbacks) {
    this.#callbacks = callbacks;
    FakeEncoder.instances.push(this);
  }

  static isConfigSupported(): Promise<{ supported: boolean }> {
    return Promise.resolve({ supported: FakeEncoder.supported });
  }

  configure(): void {
    this.state = 'configured';
  }

  encode(): void {
    this.encodeQueueSize += 1;
  }

  flush(): Promise<void> {
    this.flushes += 1;
    return new Promise<void>((done) => {
      this.#settleFlush = done;
    });
  }

  close(): void {
    this.state = 'closed';
  }

  /** One chunk out, exactly as the platform would deliver it. */
  emit(): void {
    this.encodeQueueSize = Math.max(0, this.encodeQueueSize - 1);
    this.#callbacks.output(
      { byteLength: 0, type: 'key', timestamp: 0, copyTo: () => undefined },
      undefined,
    );
  }

  finishFlush(): void {
    this.#settleFlush?.();
    this.#settleFlush = null;
  }
}

beforeEach(() => {
  FakeEncoder.instances.length = 0;
  FakeEncoder.supported = true;
  vi.stubGlobal('VideoEncoder', FakeEncoder);
  vi.stubGlobal('AudioEncoder', FakeEncoder);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openVideo(): Promise<{ encoder: VideoExportEncoder; fake: FakeEncoder }> {
  const encoder = await VideoExportEncoder.open({
    width: 1280,
    height: 720,
    bitrate: 8_000_000,
    fps: 30,
    onConfig: () => undefined,
    onChunk: () => undefined,
  });
  const fake = FakeEncoder.instances[FakeEncoder.instances.length - 1];
  if (fake === undefined) throw new Error('no encoder was constructed');
  return { encoder, fake };
}

async function openAudio(): Promise<{ encoder: AudioExportEncoder; fake: FakeEncoder }> {
  const encoder = await AudioExportEncoder.open({
    sampleRate: 48_000,
    channels: 2,
    bitrate: 192_000,
    onConfig: () => undefined,
    onChunk: () => undefined,
  });
  const fake = FakeEncoder.instances[FakeEncoder.instances.length - 1];
  if (fake === undefined) throw new Error('no encoder was constructed');
  return { encoder, fake };
}

describe('an encoder that stops without saying so', () => {
  it('fails the video drain loudly rather than hanging on it', async () => {
    const { encoder, fake } = await openVideo();
    fake.encodeQueueSize = FULL_QUEUE;

    const drained = encoder.drain();
    // Attached before the clock moves, so the rejection is never momentarily unhandled.
    const settled = expect(drained).rejects.toBeInstanceOf(ExportEncodeStallError);
    await vi.advanceTimersByTimeAsync(ENCODE_STALL_TIMEOUT_MS + 1);
    await settled;
  });

  it('fails the audio drain the same way', async () => {
    // The audio pass runs *first* (§5.7) precisely so a machine that cannot encode
    // AAC fails in the first second. A hang there defeats that entirely.
    const { encoder, fake } = await openAudio();
    fake.encodeQueueSize = FULL_QUEUE;

    const drained = encoder.drain();
    const settled = expect(drained).rejects.toBeInstanceOf(ExportEncodeStallError);
    await vi.advanceTimersByTimeAsync(ENCODE_STALL_TIMEOUT_MS + 1);
    await settled;
  });

  it('fails a flush that never settles, so even teardown is bounded', async () => {
    // `runVideo`'s `finally` awaits `close()` on the way out of a failed job. A flush
    // that never settles there hangs the export after the error, which is the same
    // spinner one layer down.
    const { encoder, fake } = await openVideo();
    const closed = encoder.close();
    const settled = expect(closed).rejects.toBeInstanceOf(ExportEncodeStallError);
    await vi.advanceTimersByTimeAsync(ENCODE_STALL_TIMEOUT_MS + 1);
    await settled;
    expect(fake.flushes).toBe(1);
  });
});

describe('CONTROL: an encoder that is working is left alone', () => {
  it('resolves the drain on the next output, long before the deadline', async () => {
    const { encoder, fake } = await openVideo();
    fake.encodeQueueSize = FULL_QUEUE;

    let done = false;
    const drained = encoder.drain().then(() => (done = true));
    // A whole deadline of *waiting* is not what the watchdog measures — progress is.
    await vi.advanceTimersByTimeAsync(ENCODE_STALL_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    fake.emit();
    await drained;
    expect(done).toBe(true);
    // And the timer it armed is gone, not left to fire into a settled promise.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves the close when the flush completes', async () => {
    const { encoder, fake } = await openVideo();
    const closed = encoder.close();
    await vi.advanceTimersByTimeAsync(ENCODE_STALL_TIMEOUT_MS - 1);
    fake.finishFlush();
    await closed;
    expect(fake.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
