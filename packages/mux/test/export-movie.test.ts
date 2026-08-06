/**
 * The export movie: does it parse, does it play, and does a cancelled one leave
 * nothing behind.
 *
 * Three independent judges, on purpose:
 *
 *  1. **Our own reader.** `parseMovie` reconstructs the sample tables off the disk
 *     and every sample's byte range is checked to tile the `mdat` exactly. That
 *     catches a table that describes a different file than the one written.
 *  2. **AVFoundation.** `/usr/bin/avconvert` remuxes the file with
 *     `PresetPassthrough`, which exercises a demuxer that is not ours. A file it
 *     refuses is a file QuickTime refuses, which is the user-facing meaning of
 *     "playable" — the same argument `capture-crash.test.ts` makes.
 *  3. **The bytes themselves.** `moov` before `mdat` is what "faststart" names, and
 *     it is asserted rather than assumed.
 *
 * And a control for (1): a deliberately corrupted `co64` must make the tiling check
 * fail. A verifier that cannot see a wrong offset would report every export good.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FastStartWriter, movieHeaderLength, parseMovie, readBoxHeader } from '../src/index.ts';
import { ExportMp4Writer, sweepExportScratch } from '../src/fs/index.ts';
import { encodeAac, haveAfconvert, writeWav } from './helpers/aac.ts';
import { loadEncodedFixture } from './helpers/fixture.ts';
import { withTempDir } from './helpers/temp.ts';

const AVCONVERT = '/usr/bin/avconvert';
const fixture = loadEncodedFixture();

/** `fps * 1000`, so every frame is exactly 1000 units. See `faststart.ts`. */
const VIDEO_TIMESCALE = fixture.fps * 1000;
const FRAME_UNITS = 1000;

function playsUnderAVFoundation(mediaPath: string, outPath: string): { ok: boolean; log: string } {
  const result = spawnSync(
    AVCONVERT,
    ['--source', mediaPath, '--output', outPath, '--preset', 'PresetPassthrough'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return { ok: result.status === 0, log: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

async function writeExport(
  dir: string,
  options: { audio?: boolean; frames?: number } = {},
): Promise<string> {
  const outputPath = join(dir, 'Export.mp4');
  const frames = fixture.frames.slice(0, options.frames ?? fixture.frames.length);

  const audio = options.audio === true ? encodedAudio(dir, frames.length / fixture.fps) : null;

  const writer = await ExportMp4Writer.create({
    outputPath,
    video: {
      width: fixture.width,
      height: fixture.height,
      timescale: VIDEO_TIMESCALE,
      avcC: fixture.avcC,
      colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
    },
    ...(audio === null
      ? {}
      : {
          audio: {
            sampleRate: audio.sampleRate,
            channels: audio.channels,
            audioSpecificConfig: audio.audioSpecificConfig,
            bitrate: 128_000,
            encoderDelaySamples: 2112,
          },
        }),
  });

  // Audio first, then video — the order the exporter itself uses, and the one this
  // writer exists to make irrelevant to the file's layout.
  if (audio !== null) {
    for (const frame of audio.frames) {
      await writer.appendAudio({
        data: frame.data,
        byteLength: frame.data.byteLength,
        durationUnits: 1024,
        isKey: true,
      });
    }
  }
  for (const [i, frame] of frames.entries()) {
    await writer.appendVideo({
      data: frame.data,
      byteLength: frame.data.byteLength,
      durationUnits: FRAME_UNITS,
      isKey: frame.isKey,
      timestampUs: Math.round((i * 1e6) / fixture.fps),
    });
  }
  await writer.finalize();
  return outputPath;
}

function encodedAudio(dir: string, seconds: number): ReturnType<typeof encodeAac> {
  const wav = join(dir, 'tone.wav');
  const sampleRate = 48000;
  writeWav(wav, {
    sampleRate,
    channels: 2,
    sampleCount: Math.max(sampleRate, Math.round(seconds * sampleRate)),
    sampleAt: (i) => Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.4,
  });
  return encodeAac(wav, join(dir, 'tone.adts'));
}

/**
 * Every sample the tables describe lands inside the `mdat` and the samples tile it
 * with no gap and no overlap.
 *
 * This is the check the whole verification rests on: an offset that is wrong by a
 * byte produces a file that demuxes and plays garbage.
 */
async function assertSamplesTileTheMdat(path: string): Promise<void> {
  const bytes = await readFile(path);
  const headerLength = movieHeaderLength(bytes);
  expect(headerLength, 'the header is at the front of the file').not.toBeNull();
  const movie = parseMovie(bytes.subarray(0, headerLength!));

  const mdat = readBoxHeader(bytes, headerLength!);
  expect(mdat?.type).toBe('mdat');
  const mediaFrom = headerLength! + mdat!.headerBytes;
  const mediaTo = headerLength! + mdat!.size;
  expect(mediaTo).toBe(bytes.byteLength);

  const spans = movie.tracks
    .flatMap((track) => track.samples)
    .map((s) => ({ from: s.offset, to: s.offset + s.byteLength }))
    .sort((a, b) => a.from - b.from);
  expect(spans.length).toBeGreaterThan(0);
  expect(spans[0]!.from).toBe(mediaFrom);
  expect(spans.at(-1)!.to).toBe(mediaTo);
  for (let i = 1; i < spans.length; i++) {
    expect(spans[i]!.from, `sample ${i} does not abut sample ${i - 1}`).toBe(spans[i - 1]!.to);
  }
}

describe('the export movie', () => {
  it('is faststart, tiles its mdat, and AVFoundation opens it', async () => {
    await withTempDir(async (dir) => {
      const path = await writeExport(dir);
      const bytes = await readFile(path);

      // Faststart: `ftyp`, then `moov`, then `mdat`. Not a claim about the brand —
      // a claim about the byte order, which is the thing that makes a player able
      // to start without seeking to the end.
      const ftyp = readBoxHeader(bytes, 0);
      expect(ftyp?.type).toBe('ftyp');
      const moov = readBoxHeader(bytes, ftyp!.size);
      expect(moov?.type).toBe('moov');
      const mdat = readBoxHeader(bytes, ftyp!.size + moov!.size);
      expect(mdat?.type).toBe('mdat');

      const movie = parseMovie(bytes.subarray(0, ftyp!.size + moov!.size));
      expect(movie.fastStart).toBe(true);
      expect(movie.tracks).toHaveLength(1);
      const video = movie.tracks[0]!;
      expect(video.handler).toBe('vide');
      expect(video.sampleEntry).toBe('avc1');
      expect(video.width).toBe(fixture.width);
      expect(video.height).toBe(fixture.height);
      expect(video.samples).toHaveLength(fixture.frames.length);
      expect(video.timescale).toBe(VIDEO_TIMESCALE);
      // The `avcC` survives the round trip byte for byte: a decoder configured from
      // a re-read file has to be configurable from what we wrote.
      expect(Array.from(video.codecDescription ?? [])).toEqual(Array.from(fixture.avcC));
      // Sync samples are marked, so a player can seek. `stss` missing would mean
      // "every sample is a sync sample", which is false and unseekable in practice.
      expect(video.samples.filter((s) => s.isSync).length).toBe(
        fixture.frames.filter((f) => f.isKey).length,
      );
      expect(video.samples[0]!.isSync).toBe(true);

      await assertSamplesTileTheMdat(path);

      const play = playsUnderAVFoundation(path, join(dir, 'remux.mov'));
      expect(play.ok, `avconvert refused the export: ${play.log}`).toBe(true);
    });
  }, 120_000);

  it.runIf(haveAfconvert())(
    'carries an audio track AVFoundation accepts, with the priming trimmed',
    async () => {
      await withTempDir(async (dir) => {
        const path = await writeExport(dir, { audio: true });
        const bytes = await readFile(path);
        const movie = parseMovie(bytes.subarray(0, movieHeaderLength(bytes)!));

        expect(movie.tracks.map((t) => t.handler)).toEqual(['vide', 'soun']);
        const audio = movie.tracks[1]!;
        expect(audio.sampleEntry).toBe('mp4a');
        expect(audio.timescale).toBe(audio.sampleRate);
        expect(audio.samples.length).toBeGreaterThan(0);
        // §2.3's trap, in a finished file: the 2112 priming samples are in the
        // stream and the edit list is what makes every demuxer skip exactly them.
        expect(audio.editMediaTime).toBe(2112);
        // Interleaved rather than two blocks: a player reading forward gets both
        // tracks from one place.
        expect(movie.tracks[0]!.samples[0]!.offset).toBeLessThan(audio.samples.at(-1)!.offset);
        expect(audio.samples[0]!.offset).toBeLessThan(movie.tracks[0]!.samples.at(-1)!.offset);

        await assertSamplesTileTheMdat(path);
        const play = playsUnderAVFoundation(path, join(dir, 'remux.mov'));
        expect(play.ok, `avconvert refused the export: ${play.log}`).toBe(true);
      });
    },
    180_000,
  );

  it('leaves nothing behind when it is cancelled', async () => {
    await withTempDir(async (dir) => {
      const writer = await ExportMp4Writer.create({
        outputPath: join(dir, 'Export.mp4'),
        video: {
          width: fixture.width,
          height: fixture.height,
          timescale: VIDEO_TIMESCALE,
          avcC: fixture.avcC,
        },
      });
      for (const [i, frame] of fixture.frames.slice(0, 8).entries()) {
        await writer.appendVideo({
          data: frame.data,
          byteLength: frame.data.byteLength,
          durationUnits: FRAME_UNITS,
          isKey: frame.isKey,
          timestampUs: Math.round((i * 1e6) / fixture.fps),
        });
      }
      // The scratch stream really did receive bytes, so "nothing is left" below is
      // a claim about cleanup rather than about an export that never started.
      expect(writer.mediaBytes).toBeGreaterThan(0);
      await expect(stat(join(dir, 'Export.mp4.video.part'))).resolves.toBeDefined();

      await writer.cancel();
      // Not "the output is absent" — *nothing* is, including anything a later
      // recovery pass or a curious user could mistake for a shorter export.
      expect(await readdir(dir)).toEqual([]);
      await expect(writer.finalize()).rejects.toThrow(/closed/);
    });
  }, 60_000);

  it('refuses an export with no video frames rather than writing an empty movie', () => {
    const writer = new FastStartWriter({
      video: { width: 640, height: 360, timescale: 30_000, avcC: new Uint8Array([1, 2, 3]) },
    });
    expect(() => writer.plan()).toThrow(/at least one video frame/);
  });

  it('refuses B-frame ordering rather than writing a table that cannot express it', () => {
    const writer = new FastStartWriter({
      video: { width: 640, height: 360, timescale: 30_000, avcC: new Uint8Array([1, 2, 3]) },
    });
    writer.addVideoSample({ byteLength: 10, durationUnits: 1000, isKey: true, timestampUs: 1000 });
    expect(() => {
      writer.addVideoSample({
        byteLength: 10,
        durationUnits: 1000,
        isKey: false,
        timestampUs: 500,
      });
    }).toThrow(/backwards/);
  });

  it('re-exports over the scratch a killed export left behind', async () => {
    await withTempDir(async (dir) => {
      // What a `SIGKILL` mid-export leaves. The scratch streams open `wx+`, so
      // without the sweep this is permanent: every later export to the same name
      // fails in `create` with an opaque `EEXIST`, pointing at files the user has no
      // reason to know exist, and that recording can never be exported again.
      const outputPath = join(dir, 'Export.mp4');
      await writeFile(`${outputPath}.video.part`, 'half a dead export');
      await writeFile(`${outputPath}.audio.part`, 'and its audio');
      await writeFile(`${outputPath}.partial`, 'and a partial assembly');

      const path = await writeExport(dir, { frames: 12 });
      expect(path).toBe(outputPath);
      await assertSamplesTileTheMdat(path);
      // And nothing of the dead export survives it.
      expect((await readdir(dir)).filter((name) => name.startsWith('Export.mp4'))).toEqual([
        'Export.mp4',
      ]);
    });
  }, 120_000);

  /**
   * CONTROL for the sweep's bound.
   *
   * The sweep is allowed exactly three deterministic names derived from the output
   * path. `<out>` is not one of them: a file already there is a previously exported
   * video — the user's finished work — and removing it is the destructive act the
   * bound exists to prevent. Without this test, "sweeps the scratch" and "clears the
   * way by deleting whatever is in it" read identically.
   */
  it('control: the sweep does not touch an export already at the output path', async () => {
    await withTempDir(async (dir) => {
      const outputPath = join(dir, 'Export.mp4');
      const earlier = 'an earlier export, which is the user’s finished work';
      await writeFile(outputPath, earlier);
      await writeFile(`${outputPath}.video.part`, 'scratch');

      await sweepExportScratch(outputPath);

      expect(await readFile(outputPath, 'utf8')).toBe(earlier);
      expect((await readdir(dir)).sort()).toEqual(['Export.mp4']);
    });
  });

  /**
   * CONTROL for `assertSamplesTileTheMdat`.
   *
   * A tiling check that could not see a wrong offset would pass every export,
   * including one whose sample table points at the wrong bytes — which is the exact
   * damage that plays as garbage rather than failing. So one `co64` entry is moved
   * by a byte and the check has to notice.
   */
  it('control: a corrupted chunk offset fails the tiling check', async () => {
    await withTempDir(async (dir) => {
      const path = await writeExport(dir, { frames: 12 });
      const bytes = await readFile(path);
      const headerLength = movieHeaderLength(bytes)!;
      const at = findBox(bytes.subarray(0, headerLength), 'co64');
      expect(at, 'the writer emitted a co64').not.toBeNull();

      // The first chunk offset is the 8 bytes after `version|flags` and `entry_count`.
      const offsetAt = at! + 8 + 4 + 4 + 4;
      const corrupted = Buffer.from(bytes);
      corrupted.writeUInt32BE(corrupted.readUInt32BE(offsetAt + 4) + 1, offsetAt + 4);
      const corruptedPath = join(dir, 'Corrupt.mp4');
      await writeFile(corruptedPath, corrupted);

      await expect(assertSamplesTileTheMdat(corruptedPath)).rejects.toThrow();
    });
  }, 120_000);
});

/** Byte offset of the first box of `type` anywhere in `bytes`, or `null`. */
function findBox(bytes: Uint8Array, type: string): number | null {
  const needle = new TextEncoder().encode(type);
  outer: for (let at = 4; at + 4 <= bytes.byteLength; at++) {
    for (let i = 0; i < 4; i++) if (bytes[at + i] !== needle[i]) continue outer;
    return at - 4;
  }
  return null;
}
