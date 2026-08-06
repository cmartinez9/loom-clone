/**
 * Real AAC, from something that is not us.
 *
 * The audio tests need encoded AAC frames shaped exactly like the ones
 * `AudioEncoder` hands the capture page — raw frames plus an AudioSpecificConfig —
 * and they need them on a machine with no ffmpeg, no display and no microphone.
 * `/usr/bin/afconvert` is AVFoundation's own converter, ships with macOS, and is
 * the same encoder Chromium reaches through AudioToolbox, so it produces the same
 * bitstream the app will produce and — crucially for the sync gate — the same
 * 2112-sample encoder priming.
 *
 * It is also the *decoder* on the way back out. A file our writer produced, read
 * by our own scanner, would only prove the two agree; read by AVFoundation it
 * proves the file is an MP4. This is the same argument `apps/main/test/
 * capture-crash.test.ts` makes for checking playability with `avconvert`.
 *
 * Nothing here is production code: it stands in for the encoder that lives in the
 * capture renderer, so that everything below the IPC boundary can be driven from
 * plain Node.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';

export const AFCONVERT = '/usr/bin/afconvert';
/** AudioToolbox's own reader. Ships with macOS, like `afconvert` and `avconvert`. */
export const AFINFO = '/usr/bin/afinfo';

/** One encoded AAC frame, as `EncodedAudioChunk` would carry it. */
export interface AacFrame {
  data: Uint8Array;
  durationUs: number;
}

export interface EncodedAac {
  frames: AacFrame[];
  /** `AudioDecoderConfig.description` — two bytes for AAC-LC. */
  audioSpecificConfig: Uint8Array;
  sampleRate: number;
  channels: number;
}

/** Sampling frequencies an ADTS header can name by index (ISO/IEC 14496-3). */
const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Samples per AAC-LC frame. */
export const AAC_FRAME_SAMPLES = 1024;

export function haveAfconvert(): boolean {
  return spawnSync(AFCONVERT, ['-h'], { encoding: 'utf8' }).error === undefined;
}

/**
 * Write a 16-bit PCM WAV, one block at a time.
 *
 * Streamed because the sync gate writes twenty minutes of stereo audio — 230 MB,
 * which is not a thing to hold in a JavaScript array.
 */
export function writeWav(
  path: string,
  spec: {
    sampleRate: number;
    channels: number;
    sampleCount: number;
    /** Amplitude in [-1, 1] for sample `i`. Called once per sample per channel. */
    sampleAt: (index: number) => number;
  },
): void {
  const bytesPerSample = 2 * spec.channels;
  const dataBytes = spec.sampleCount * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(spec.channels, 22);
  header.writeUInt32LE(spec.sampleRate, 24);
  header.writeUInt32LE(spec.sampleRate * bytesPerSample, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const fd = openSync(path, 'w');
  try {
    writeSync(fd, header);
    const blockSamples = 48_000;
    const block = Buffer.alloc(blockSamples * bytesPerSample);
    for (let at = 0; at < spec.sampleCount; at += blockSamples) {
      const count = Math.min(blockSamples, spec.sampleCount - at);
      for (let i = 0; i < count; i++) {
        const value = Math.max(-1, Math.min(1, spec.sampleAt(at + i)));
        const pcm = Math.round(value * 32767);
        for (let c = 0; c < spec.channels; c++) {
          block.writeInt16LE(pcm, (i * spec.channels + c) * 2);
        }
      }
      writeSync(fd, block, 0, count * bytesPerSample);
    }
  } finally {
    closeSync(fd);
  }
}

/** Encode a WAV to raw AAC frames, the shape `AudioEncoder` emits. */
export function encodeAac(wavPath: string, adtsPath: string, bitrate = 128_000): EncodedAac {
  const result = spawnSync(
    AFCONVERT,
    ['-f', 'adts', '-d', 'aac', '-b', String(bitrate), wavPath, adtsPath],
    { encoding: 'utf8', timeout: 600_000 },
  );
  if (result.status !== 0) {
    throw new Error(`afconvert could not encode ${wavPath}: ${result.stderr ?? ''}`);
  }
  return readAdts(adtsPath);
}

/**
 * Split an ADTS stream into frames and rebuild the AudioSpecificConfig.
 *
 * ADTS repeats the codec configuration in every frame header; MP4 states it once
 * in `esds`. The two carry the same three fields, so the config an `AudioEncoder`
 * would hand over as `decoderConfig.description` is reconstructable exactly.
 */
export function readAdts(path: string): EncodedAac {
  const bytes = readFileSync(path);
  const frames: AacFrame[] = [];
  let objectType = 2;
  let frequencyIndex = 3;
  let channelConfig = 2;
  let at = 0;
  while (at + 7 <= bytes.byteLength) {
    if (bytes[at] !== 0xff || ((bytes[at + 1] ?? 0) & 0xf0) !== 0xf0) {
      throw new Error(`${path} is not an ADTS stream at byte ${at}`);
    }
    const protectionAbsent = ((bytes[at + 1] ?? 0) & 0x01) === 1;
    objectType = (((bytes[at + 2] ?? 0) & 0xc0) >>> 6) + 1;
    frequencyIndex = ((bytes[at + 2] ?? 0) & 0x3c) >>> 2;
    channelConfig = (((bytes[at + 2] ?? 0) & 0x01) << 2) | (((bytes[at + 3] ?? 0) & 0xc0) >>> 6);
    const frameLength =
      (((bytes[at + 3] ?? 0) & 0x03) << 11) |
      ((bytes[at + 4] ?? 0) << 3) |
      (((bytes[at + 5] ?? 0) & 0xe0) >>> 5);
    const blocks = ((bytes[at + 6] ?? 0) & 0x03) + 1;
    if (blocks !== 1) throw new Error('multi-block ADTS frames are not supported');
    const headerBytes = protectionAbsent ? 7 : 9;
    if (frameLength < headerBytes || at + frameLength > bytes.byteLength) break;
    const sampleRate = ADTS_RATES[frequencyIndex] ?? 48000;
    frames.push({
      data: Uint8Array.prototype.slice.call(bytes, at + headerBytes, at + frameLength),
      durationUs: Math.round((AAC_FRAME_SAMPLES / sampleRate) * 1_000_000),
    });
    at += frameLength;
  }

  const config = (objectType << 11) | (frequencyIndex << 7) | (channelConfig << 3);
  return {
    frames,
    audioSpecificConfig: Uint8Array.from([(config >>> 8) & 0xff, config & 0xff]),
    sampleRate: ADTS_RATES[frequencyIndex] ?? 48000,
    channels: channelConfig,
  };
}

/**
 * How long AudioToolbox thinks a file carrying audio is.
 *
 * A judge that is not us, on a question our own writer is the only other answer to.
 * `afinfo` reports the **presented** length — it applies the `elst` and the priming
 * the stream declares — so it is the one reading that can say whether a movie's
 * header describes the sound a player would actually get.
 *
 * `null` when it could not be read, so a caller can say "the judge declined" rather
 * than silently pass.
 */
export function afinfoDurationSec(path: string): { seconds: number | null; log: string } {
  const result = spawnSync(AFINFO, [path], { encoding: 'utf8', timeout: 120_000 });
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const match = /estimated duration:\s*([0-9]+(?:\.[0-9]+)?)\s*sec/.exec(log);
  const seconds = match === null ? null : Number.parseFloat(match[1] ?? '');
  return { seconds: seconds !== null && Number.isFinite(seconds) ? seconds : null, log };
}

/** Decode an MP4/M4A back to PCM with AVFoundation. */
export function decodeToWav(mediaPath: string, wavPath: string): void {
  const result = spawnSync(AFCONVERT, ['-f', 'WAVE', '-d', 'LEI16', mediaPath, wavPath], {
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (result.status !== 0) {
    throw new Error(`afconvert could not decode ${mediaPath}: ${result.stderr ?? ''}`);
  }
}

export interface WavFacts {
  sampleRate: number;
  channels: number;
  bits: number;
  sampleCount: number;
  dataOffset: number;
  dataBytes: number;
}

/** Read a WAV's header without reading its samples. */
export function readWavFacts(path: string): WavFacts {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4096);
    const bytesRead = readSync(fd, head, 0, head.byteLength, 0);
    let at = 12;
    let sampleRate = 0;
    let channels = 0;
    let bits = 16;
    while (at + 8 <= bytesRead) {
      const id = head.toString('latin1', at, at + 4);
      const size = head.readUInt32LE(at + 4);
      if (id === 'fmt ') {
        channels = head.readUInt16LE(at + 10);
        sampleRate = head.readUInt32LE(at + 12);
        bits = head.readUInt16LE(at + 22);
      }
      if (id === 'data') {
        const bytesPerSample = (bits / 8) * channels;
        return {
          sampleRate,
          channels,
          bits,
          dataOffset: at + 8,
          dataBytes: size,
          sampleCount: Math.floor(size / bytesPerSample),
        };
      }
      at += 8 + size + (size % 2);
    }
    throw new Error(`${path} has no data chunk`);
  } finally {
    closeSync(fd);
  }
}

/**
 * The short-term energy envelope of a WAV, one value per `windowSamples`.
 *
 * Streamed, because the gate's twenty-minute case is 230 MB of PCM. Channel 0
 * only: both channels carry the same signal in these fixtures, and a mono
 * envelope is what gets cross-correlated against the luma one.
 */
export function wavEnvelope(
  path: string,
  windowSamples: number,
): { envelope: Float64Array; facts: WavFacts } {
  const facts = readWavFacts(path);
  const bytesPerSample = 2 * facts.channels;
  const windows = Math.ceil(facts.sampleCount / windowSamples);
  const envelope = new Float64Array(windows);

  const fd = openSync(path, 'r');
  try {
    const blockSamples = 1 << 16;
    const buffer = Buffer.alloc(blockSamples * bytesPerSample);
    let sample = 0;
    let offset = facts.dataOffset;
    while (sample < facts.sampleCount) {
      const want = Math.min(blockSamples, facts.sampleCount - sample) * bytesPerSample;
      const read = readSync(fd, buffer, 0, want, offset);
      if (read <= 0) break;
      offset += read;
      const count = Math.floor(read / bytesPerSample);
      for (let i = 0; i < count; i++) {
        const value = buffer.readInt16LE(i * bytesPerSample) / 32768;
        const window = Math.floor((sample + i) / windowSamples);
        const slot = envelope[window];
        if (slot !== undefined) envelope[window] = slot + value * value;
      }
      sample += count;
    }
  } finally {
    closeSync(fd);
  }
  return { envelope, facts };
}
