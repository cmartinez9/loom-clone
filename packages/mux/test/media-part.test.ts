/**
 * `MediaPartWriter` and `recoverMediaPart` — the file half of capture.
 *
 * The crash gate (`apps/main/test/capture-crash.test.ts`) kills a process and
 * measures what comes back. It can only kill where the kill happens to land, and a
 * write of a 1 KB fragment is over in microseconds, so in practice it lands
 * *between* writes. This file covers the other case exhaustively and on purpose:
 * the file is cut at every plausible byte offset, and recovery has to produce a
 * coherent recording from each one.
 *
 * "Coherent" is spelled out rather than assumed:
 *
 * - the frame count never exceeds what a cut at that point could contain, and
 *   grows monotonically as the cut moves later;
 * - the rebuilt index describes the *repaired* file, entry for entry;
 * - the repaired file is one AVFoundation will open, which is what "playable"
 *   means to the person who double-clicks it.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateFrameIndexDoc, type FrameIndexDoc } from '@loom/format';
import { MediaPartWriter, UnrecoverablePartError, recoverMediaPart } from '../src/fs/index.ts';
import { loadEncodedFixture } from './helpers/fixture.ts';
import { withTempDir } from './helpers/temp.ts';

const AVCONVERT = '/usr/bin/avconvert';
const fixture = loadEncodedFixture();

/** Cuts whose recovered file is additionally opened by AVFoundation. */
const PLAYBACK_CHECKED = new Set([0.1, 0.5, 0.999]);

async function writePart(
  dir: string,
  frameCount = fixture.frames.length,
): Promise<{ media: string; index: string }> {
  const media = join(dir, 'screen.000.mp4');
  const index = join(dir, 'screen.000.index.json');
  const writer = await MediaPartWriter.create({
    mediaPath: media,
    indexPath: index,
    width: fixture.width,
    height: fixture.height,
    avcC: fixture.avcC,
    nominalFps: fixture.fps,
    colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
  });
  for (const frame of fixture.frames.slice(0, frameCount)) {
    await writer.append({
      data: frame.data,
      isKey: frame.isKey,
      timestampUs: frame.timestampUs,
      durationUs: null,
    });
  }
  await writer.finalize();
  return { media, index };
}

async function readIndex(path: string): Promise<FrameIndexDoc> {
  const result = validateFrameIndexDoc(JSON.parse(await readFile(path, 'utf8')));
  if (!result.ok) throw new Error(`index is invalid: ${JSON.stringify(result.issues)}`);
  return result.value;
}

/** AVFoundation opens it and remuxes it. Present on every macOS; skipped elsewhere. */
function playsUnderAVFoundation(media: string, out: string): boolean {
  if (process.platform !== 'darwin') return true;
  return (
    spawnSync(AVCONVERT, ['--source', media, '--output', out, '--preset', 'PresetPassthrough'], {
      encoding: 'utf8',
      timeout: 60_000,
    }).status === 0
  );
}

/** Every index entry lands on a run of AVCC NAL units that tiles its size exactly. */
async function assertIndexDescribes(media: string, index: FrameIndexDoc): Promise<void> {
  const bytes = await readFile(media);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(index.pts.length).toBe(index.sizes.length);
  expect(index.pts.length).toBe(index.offsets.length);
  for (let i = 0; i < index.pts.length; i++) {
    const offset = index.offsets[i] ?? -1;
    const size = index.sizes[i] ?? -1;
    expect(offset + size).toBeLessThanOrEqual(bytes.byteLength);
    let at = offset;
    while (at < offset + size) {
      const nal = view.getUint32(at, false);
      expect(nal).toBeGreaterThan(0);
      at += 4 + nal;
    }
    expect(at).toBe(offset + size);
  }
}

describe('writing a capture part', () => {
  it('produces a file AVFoundation reads, with an index that describes it', async () => {
    await withTempDir(async (dir) => {
      const { media, index } = await writePart(dir);
      const doc = await readIndex(index);

      expect(doc.pts.length).toBe(fixture.frames.length);
      expect(doc.keyframes.length).toBe(fixture.frames.filter((f) => f.isKey).length);
      expect(doc.timescale).toBe(1_000_000);
      await assertIndexDescribes(media, doc);
      expect(playsUnderAVFoundation(media, join(dir, 'probe.mov'))).toBe(true);
    });
  });

  it('refuses to overwrite a part that already exists', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'screen.000.mp4'), 'not a recording');
      await expect(
        MediaPartWriter.create({
          mediaPath: join(dir, 'screen.000.mp4'),
          indexPath: join(dir, 'screen.000.index.json'),
          width: 320,
          height: 180,
          avcC: fixture.avcC,
          nominalFps: 30,
        }),
      ).rejects.toThrow(/EEXIST/);
    });
  });

  it('an abort keeps what was written and describes it', async () => {
    await withTempDir(async (dir) => {
      const media = join(dir, 'screen.000.mp4');
      const index = join(dir, 'screen.000.index.json');
      const writer = await MediaPartWriter.create({
        mediaPath: media,
        indexPath: index,
        width: fixture.width,
        height: fixture.height,
        avcC: fixture.avcC,
        nominalFps: fixture.fps,
      });
      for (const frame of fixture.frames.slice(0, 20)) {
        await writer.append({
          data: frame.data,
          isKey: frame.isKey,
          timestampUs: frame.timestampUs,
          durationUs: null,
        });
      }
      const summary = await writer.abort();
      expect(summary.frameCount).toBe(20);
      await assertIndexDescribes(media, await readIndex(index));
    });
  });
});

describe('recovering a part cut short', () => {
  it('recovers everything from a file that was never damaged', async () => {
    await withTempDir(async (dir) => {
      const { media, index } = await writePart(dir);
      const recovered = await recoverMediaPart(media, index);
      expect(recovered.frameCount).toBe(fixture.frames.length);
      expect(recovered.truncatedBytes).toBe(0);
      expect(recovered.size).toEqual([fixture.width, fixture.height]);
      expect(recovered.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
      expect(recovered.observedFps).toBeCloseTo(fixture.fps, 1);
    });
  });

  it('recovers a coherent, playable recording from a cut at any offset', async () => {
    await withTempDir(async (dir) => {
      const { media } = await writePart(dir);
      const full = (await stat(media)).size;
      const source = await readFile(media);

      let previous = -1;
      // Fractions rather than a fixed stride, so the cuts land in headers, in
      // sample data and on fragment boundaries alike.
      for (const fraction of [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
        const cutAt = Math.floor(full * fraction);
        const cut = join(dir, `cut-${String(cutAt)}.mp4`);
        const cutIndex = join(dir, `cut-${String(cutAt)}.index.json`);
        await writeFile(cut, source);
        await truncate(cut, cutAt);

        const recovered = await recoverMediaPart(cut, cutIndex);

        // Monotone: a later cut can never recover fewer frames than an earlier one.
        expect(recovered.frameCount).toBeGreaterThanOrEqual(previous);
        previous = recovered.frameCount;

        // The file left behind ends exactly where the last whole fragment did.
        expect((await stat(cut)).size).toBe(recovered.byteLength);
        expect(recovered.truncatedBytes).toBe(cutAt - recovered.byteLength);

        const doc = await readIndex(cutIndex);
        expect(doc.pts.length).toBe(recovered.frameCount);
        await assertIndexDescribes(cut, doc);

        if (recovered.frameCount > 0) {
          expect(doc.keyframes[0]).toBe(0);
          // AVFoundation is the expensive check (~2 s a call), so it runs on a
          // spread of the cuts rather than all of them; the index assertions
          // above run on every one.
          if (PLAYBACK_CHECKED.has(fraction)) {
            expect(playsUnderAVFoundation(cut, join(dir, `probe-${String(cutAt)}.mov`))).toBe(true);
          }
        }
      }
      expect(previous).toBe(fixture.frames.length - 1);
    });
  });

  it('repairs the file in place so a second recovery is a no-op', async () => {
    await withTempDir(async (dir) => {
      const { media, index } = await writePart(dir);
      const full = (await stat(media)).size;
      await truncate(media, full - 137);

      const first = await recoverMediaPart(media, index);
      expect(first.truncatedBytes).toBeGreaterThan(0);
      const second = await recoverMediaPart(media, index);
      expect(second.truncatedBytes).toBe(0);
      expect(second.frameCount).toBe(first.frameCount);
    });
  });

  it('refuses a file with no readable header rather than inventing one', async () => {
    await withTempDir(async (dir) => {
      const media = join(dir, 'screen.000.mp4');
      await writeFile(media, Buffer.alloc(64));
      await expect(recoverMediaPart(media, join(dir, 'screen.000.index.json'))).rejects.toThrow(
        UnrecoverablePartError,
      );
    });
  });

  it('recovers an empty part from a file that got no further than its header', async () => {
    await withTempDir(async (dir) => {
      const media = join(dir, 'screen.000.mp4');
      const index = join(dir, 'screen.000.index.json');
      const writer = await MediaPartWriter.create({
        mediaPath: media,
        indexPath: index,
        width: fixture.width,
        height: fixture.height,
        avcC: fixture.avcC,
        nominalFps: fixture.fps,
      });
      await writer.close();

      // Zero frames is a fact to report, not an error to throw: the bundle still
      // opens and the caller still gets to say what was lost.
      const recovered = await recoverMediaPart(media, index);
      expect(recovered.frameCount).toBe(0);
      expect(recovered.durationSec).toBe(0);
      expect((await readIndex(index)).pts).toEqual([]);
    });
  });

  it('stops at a fragment whose mdat is short rather than reading past it', async () => {
    await withTempDir(async (dir) => {
      const { media, index } = await writePart(dir, 30);
      const doc = await readIndex(index);
      // Cut one byte into the last frame's data.
      const lastOffset = doc.offsets.at(-1) ?? 0;
      await truncate(media, lastOffset + 1);

      const recovered = await recoverMediaPart(media, index);
      expect(recovered.frameCount).toBe(29);
      await assertIndexDescribes(media, await readIndex(index));
    });
  });
});
