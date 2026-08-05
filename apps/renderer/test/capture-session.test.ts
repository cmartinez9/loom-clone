/**
 * The capture page's session lifecycle, against fake capture APIs.
 *
 * The one property this file exists for is a privacy property rather than a
 * bookkeeping one: **no device outlives the session that opened it.** A recording
 * can end while `getUserMedia` is still blocked on the macOS microphone prompt —
 * the user pressing stop, the screen source ending, an encoder failing — and a
 * microphone that starts after that has nothing left to belong to. Left running it
 * keeps the macOS recording indicator lit, and it keeps posting chunks under the
 * same `{track, part}` key that the *next* recording opens, which main would
 * accept as that recording's own audio.
 *
 * WebCodecs, `MediaStreamTrackProcessor` and `getDisplayMedia` are faked, because
 * none of them exists in Node and the ordering under test is the page's rather
 * than the platform's. What is real is `ReadableStream`, which is what a cancelled
 * reader and a stopped pump actually run through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPTURE_OPTIONS, type CaptureCommand, type CaptureEndReport } from '@loom/ipc';

interface FakeTrack {
  kind: 'video' | 'audio';
  label: string;
  stopped: boolean;
  stop(): void;
  getSettings(): Record<string, unknown>;
  addEventListener(type: string, listener: () => void): void;
}

interface FakeStream {
  tracks: FakeTrack[];
  getTracks(): FakeTrack[];
  getVideoTracks(): FakeTrack[];
  getAudioTracks(): FakeTrack[];
}

class FakeEncoder {
  static isConfigSupported(config: unknown): Promise<unknown> {
    return Promise.resolve({ supported: true, config });
  }
  state = 'unconfigured';
  encodeQueueSize = 0;
  encoded = 0;
  configure(): void {
    this.state = 'configured';
  }
  encode(): void {
    this.encoded += 1;
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.state = 'closed';
  }
}

/** Every `AudioEncoder` the page has constructed, so a leaked one is visible. */
const audioEncoders: FakeAudioEncoder[] = [];

class FakeAudioEncoder extends FakeEncoder {
  constructor() {
    super();
    audioEncoders.push(this);
  }
}

/** A processor whose readable never yields, so a session ends only when told to. */
class FakeProcessor {
  readonly readable = new ReadableStream({ start: () => undefined });
}

function fakeTrack(kind: 'video' | 'audio', label: string): FakeTrack {
  return {
    kind,
    label,
    stopped: false,
    stop(): void {
      this.stopped = true;
    },
    getSettings: () => ({
      deviceId: label,
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }),
    addEventListener: () => undefined,
  };
}

function fakeStream(tracks: FakeTrack[]): FakeStream {
  return {
    tracks,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      settle(value);
    },
  };
}

/** Let every pending microtask and timer turn run. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const FAKE_GLOBALS = [
  'window',
  'navigator',
  'MediaStreamTrackProcessor',
  'VideoEncoder',
  'AudioEncoder',
] as const;

let command: ((command: CaptureCommand) => void) | null = null;
let ended: CaptureEndReport[] = [];
let failed: string[] = [];
let micStream: FakeStream;
let micCall: Deferred<FakeStream>;
let displayStream: FakeStream;

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** Drive the page with the microphone only, so exactly one device is in play. */
function startCommand(): CaptureCommand {
  return { kind: 'start', options: { ...DEFAULT_CAPTURE_OPTIONS, systemAudio: false } };
}

function micTrack(): FakeTrack {
  const track = micStream.tracks[0];
  if (track === undefined) throw new Error('the microphone stream carried no track');
  return track;
}

function send(message: CaptureCommand): void {
  if (command === null) throw new Error('the capture page did not subscribe to commands');
  command(message);
}

beforeEach(async () => {
  vi.resetModules();
  audioEncoders.length = 0;
  command = null;
  ended = [];
  failed = [];
  displayStream = fakeStream([fakeTrack('video', 'screen')]);
  micStream = fakeStream([fakeTrack('audio', 'mic-1')]);
  micCall = deferred<FakeStream>();

  define('window', {
    loom: {
      capture: {
        onCommand: (callback: (message: CaptureCommand) => void) => {
          command = callback;
          return () => undefined;
        },
        meta: () => undefined,
        chunk: () => undefined,
        ended: (report: CaptureEndReport) => ended.push(report),
        failed: (reason: string) => failed.push(reason),
      },
    },
  });
  define('navigator', {
    mediaDevices: {
      getDisplayMedia: () => Promise.resolve(displayStream),
      getUserMedia: () => micCall.promise,
    },
  });
  define('MediaStreamTrackProcessor', FakeProcessor);
  define('VideoEncoder', FakeEncoder);
  define('AudioEncoder', FakeAudioEncoder);

  await import('../src/capture/main.ts');
});

afterEach(() => {
  for (const name of FAKE_GLOBALS) Reflect.deleteProperty(globalThis, name);
});

describe('a microphone that opens after the session it belongs to', () => {
  it('is stopped rather than left running into the next recording', async () => {
    send(startCommand());
    // `getUserMedia` has not answered yet — on a first run that is the macOS
    // microphone prompt, which stays open for as long as the user takes.
    await settled();
    expect(micTrack().stopped).toBe(false);
    expect(audioEncoders).toHaveLength(0);

    send({ kind: 'stop' });
    await settled();
    expect(ended, 'the stop must be reported before the microphone arrives').toHaveLength(1);

    micCall.resolve(micStream);
    await settled();

    expect(micTrack().stopped, 'the microphone was left running after the recording ended').toBe(
      true,
    );
    expect(
      audioEncoders.map((encoder) => encoder.state),
      'an encoder outlived its session and will keep posting chunks to main',
    ).toEqual(audioEncoders.map(() => 'closed'));
    // The recording ended cleanly. It must not also report a failure afterwards.
    expect(failed).toEqual([]);
  });

  it('is carried by the session and reported when it opens in time', async () => {
    micCall.resolve(micStream);
    send(startCommand());
    await settled();
    expect(audioEncoders).toHaveLength(1);

    send({ kind: 'stop' });
    await settled();

    expect(micTrack().stopped).toBe(true);
    expect(audioEncoders[0]?.state).toBe('closed');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.audio?.map((entry) => entry.track)).toEqual(['mic']);
    expect(failed).toEqual([]);
  });
});
