/**
 * `AudioPartWriter` and `recoverAudioPart` — the file half of audio capture.
 *
 * The one property worth stating up front, because every other assertion here
 * rests on it: **the bytes come from a real AAC encoder and are read back by a
 * real AAC decoder, neither of which is us.** `afconvert` is AVFoundation, ships
 * with macOS, and is the same AudioToolbox encoder Chromium reaches through
 * `AudioEncoder`. Our own writer agreeing with our own scanner would prove only
 * that they agree.
 *
 * That round trip is also how the 2112-sample encoder priming — the thing that
 * would otherwise put every audio track in this app 44 ms late — is measured
 * rather than believed.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AAC_ENCODER_DELAY_SAMPLES, parseAudioInitSegment } from '../src/index.ts';
import { AudioPartWriter, UnrecoverablePartError, recoverAudioPart } from '../src/fs/index.ts';
import {
  AAC_FRAME_SAMPLES,
  decodeToWav,
  encodeAac,
  haveAfconvert,
  readWavFacts,
  writeWav,
  type EncodedAac,
} from './helpers/aac.ts';
import { withTempDir } from './helpers/temp.ts';

const AVCONVERT = '/usr/bin/avconvert';
const RATE = 48000;
const CHANNELS = 2;
/** Where the burst sits in the source, in samples. Loud, short, unambiguous. */
const BURST_AT = 24_000;
const BURST_SAMPLES = 4800;

/** Two seconds of silence with one 1 kHz burst in it, encoded to real AAC. */
function tone(dir: string): EncodedAac {
  const wav = join(dir, 'tone.wav');
  writeWav(wav, {
    sampleRate: RATE,
    channels: CHANNELS,
    sampleCount: RATE * 2,
    sampleAt: (i) =>
      i >= BURST_AT && i < BURST_AT + BURST_SAMPLES
        ? 0.8 * Math.sin((2 * Math.PI * 1000 * i) / RATE)
        : 0,
  });
  return encodeAac(wav, join(dir, 'tone.aac'));
}

async function writePart(dir: string, source: EncodedAac, frameCount?: number): Promise<string> {
  const media = join(dir, 'mic.000.m4a');
  const writer = await AudioPartWriter.create({
    mediaPath: media,
    sampleRate: source.sampleRate,
    channels: source.channels,
    audioSpecificConfig: source.audioSpecificConfig,
    bitrate: 128_000,
  });
  const frames = source.frames.slice(0, frameCount ?? source.frames.length);
  for (const [i, frame] of frames.entries()) {
    await writer.append({
      data: frame.data,
      isKey: true,
      timestampUs: Math.round((i * AAC_FRAME_SAMPLES * 1_000_000) / source.sampleRate),
      durationUs: frame.durationUs,
    });
  }
  await writer.finalize();
  return media;
}

/** First sample above `threshold` in channel 0 of a WAV. */
async function firstLoudSample(path: string, threshold = 0.2): Promise<number> {
  const facts = readWavFacts(path);
  const bytes = await readFile(path);
  const stride = 2 * facts.channels;
  for (let i = 0; i < facts.sampleCount; i++) {
    const value = bytes.readInt16LE(facts.dataOffset + i * stride) / 32768;
    if (Math.abs(value) > threshold) return i;
  }
  return -1;
}

const enabled = haveAfconvert();
const test = enabled ? it : it.skip;

describe('an audio capture part', () => {
  test('is an MP4 AVFoundation opens, with the right rate and channel count', async () => {
    await withTempDir(async (dir) => {
      const source = tone(dir);
      expect(source.sampleRate).toBe(RATE);
      expect(source.channels).toBe(CHANNELS);
      const media = await writePart(dir, source);

      const facts = parseAudioInitSegment(await readFile(media));
      expect(facts.sampleRate).toBe(RATE);
      expect(facts.channels).toBe(CHANNELS);
      // The media timescale is the sample rate, which is what makes every
      // duration in the file an exact sample count.
      expect(facts.timescale).toBe(RATE);

      const out = join(dir, 'probe.mov');
      const played = spawnSync(
        AVCONVERT,
        ['--source', media, '--output', out, '--preset', 'PresetPassthrough'],
        { encoding: 'utf8', timeout: 60_000 },
      );
      expect(
        played.status,
        `AVFoundation could not read the part: ${played.stdout ?? ''}${played.stderr ?? ''}`,
      ).toBe(0);
      expect((await stat(out)).size).toBeGreaterThan(0);
    });
  });

  test('decodes back to the samples it was given, with the priming trimmed', async () => {
    await withTempDir(async (dir) => {
      const source = tone(dir);
      const media = await writePart(dir, source);
      const decoded = join(dir, 'back.wav');
      decodeToWav(media, decoded);

      const facts = readWavFacts(decoded);
      expect(facts.sampleRate).toBe(RATE);
      expect(facts.channels).toBe(CHANNELS);

      // The burst comes back where it went in. Without the edit list it lands
      // 2112 samples — 44 ms — later, which is more than twice the phase 3 sync
      // budget, and which AVFoundation and libavformat disagree about. The
      // threshold crossing is a sample or two into the sine's first period, hence
      // the tolerance rather than an equality.
      const loudAt = await firstLoudSample(decoded);
      expect(Math.abs(loudAt - BURST_AT)).toBeLessThan(48);

      // The trim is stated in the file, not inferred from it: a reader that
      // decodes raw chunks has to apply it itself.
      const written = parseAudioInitSegment(await readFile(media));
      expect(written.encoderDelaySamples).toBe(AAC_ENCODER_DELAY_SAMPLES);
      expect(facts.sampleCount).toBe(
        source.frames.length * AAC_FRAME_SAMPLES - AAC_ENCODER_DELAY_SAMPLES,
      );
    });
  });

  /**
   * The reason the edit list is written at all.
   *
   * AVFoundation applies AAC's standard priming trim to an MP4 whether or not the
   * file says to; libavformat does not, and Chromium's demuxer is libavformat. So a
   * file with no edit list decodes to two different things depending on who opens
   * it — 44 ms apart, which is twice this phase's whole sync budget — and the test
   * above cannot see it, because the decoder it uses is the forgiving one.
   *
   * Measured on this machine, on a file with no edit list:
   *
   * ```
   * afconvert (AVFoundation)  burst at 24002, 96192 samples   priming trimmed
   * ffmpeg    (libavformat)   burst at 26114, 98304 samples   priming delivered
   * ```
   *
   * Skipped where ffmpeg is absent, exactly like the `ffprobe` check in
   * `apps/main/test/capture-crash.test.ts`: the point is a second opinion, and a
   * machine that cannot offer one is not a machine that has failed.
   */
  test('decodes the same way in a demuxer that is not AVFoundation', async () => {
    if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).error !== undefined) return;
    await withTempDir(async (dir) => {
      const source = tone(dir);
      const media = await writePart(dir, source);
      const decoded = join(dir, 'ffmpeg.wav');
      const result = spawnSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          media,
          '-f',
          'wav',
          '-c:a',
          'pcm_s16le',
          decoded,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(result.status, `ffmpeg could not read the part: ${result.stderr ?? ''}`).toBe(0);

      const loudAt = await firstLoudSample(decoded);
      expect(
        Math.abs(loudAt - BURST_AT),
        'libavformat put the burst somewhere AVFoundation did not: the edit list that ' +
          'trims the encoder priming is missing or wrong',
      ).toBeLessThan(48);
    });
  });

  test('recovers its facts from the bytes after a crash', async () => {
    await withTempDir(async (dir) => {
      const source = tone(dir);
      const media = await writePart(dir, source);
      const written = source.frames.length;

      const recovered = await recoverAudioPart(media);
      expect(recovered.frameCount).toBe(written);
      expect(recovered.sampleCount).toBe(written * AAC_FRAME_SAMPLES);
      expect(recovered.sampleRate).toBe(RATE);
      expect(recovered.channels).toBe(CHANNELS);
      expect(recovered.codec).toBe('mp4a.40.2');
      expect(recovered.truncatedBytes).toBe(0);
      expect(recovered.mediaDurationSec).toBeCloseTo((written * AAC_FRAME_SAMPLES) / RATE, 6);
    });
  });

  test('discards a torn trailing fragment rather than welding to it', async () => {
    await withTempDir(async (dir) => {
      const source = tone(dir);
      const media = await writePart(dir, source);
      const bytes = await readFile(media);
      await writeFile(media, bytes.subarray(0, bytes.byteLength - 120));

      const recovered = await recoverAudioPart(media);
      expect(recovered.truncatedBytes).toBeGreaterThan(0);
      expect(recovered.frameCount).toBeLessThan(source.frames.length);
      expect((await stat(media)).size).toBe(bytes.byteLength - 120 - recovered.truncatedBytes);

      // And what is left still decodes.
      decodeToWav(media, join(dir, 'truncated.wav'));
      expect(readWavFacts(join(dir, 'truncated.wav')).sampleCount).toBeGreaterThan(0);
    });
  });

  test('refuses a file with no readable initialisation segment', async () => {
    await withTempDir(async (dir) => {
      const media = join(dir, 'mic.000.m4a');
      await writeFile(media, Buffer.alloc(4096));
      await expect(recoverAudioPart(media)).rejects.toBeInstanceOf(UnrecoverablePartError);
    });
  });

  test('refuses to reuse a part index rather than truncating what is there', async () => {
    await withTempDir(async (dir) => {
      const source = tone(dir);
      await writePart(dir, source, 4);
      await expect(
        AudioPartWriter.create({
          mediaPath: join(dir, 'mic.000.m4a'),
          sampleRate: source.sampleRate,
          channels: source.channels,
          audioSpecificConfig: source.audioSpecificConfig,
        }),
      ).rejects.toThrow(/EEXIST/);
    });
  });
});
