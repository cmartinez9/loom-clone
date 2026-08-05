/**
 * Bundle layout, identifiers and atomic writes — the small, load-bearing pieces.
 */

import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from './helpers/temp.ts';
import {
  BUNDLE,
  backupPath,
  cursorImagePath,
  filmstripPath,
  isSafeBundleRelativePath,
  mediaIndexPath,
  mediaPartPath,
  partSuffix,
  sanitizeRecordingName,
} from '../src/bundle/layout.ts';
import { isUlid, ulid, ulidTime } from '../src/ids.ts';
import { parseSchemaId, schemaId } from '../src/schema.ts';
import { writeAtomic, writeJsonAtomic, isTempArtifact } from '../src/fs/write-atomic.ts';

describe('bundle paths', () => {
  it('names media parts exactly as §2.1 does', () => {
    expect(mediaPartPath('screen', 0)).toBe('media/screen.000.mp4');
    expect(mediaPartPath('webcam', 1)).toBe('media/webcam.001.mp4');
    expect(mediaPartPath('mic', 0)).toBe('media/mic.000.m4a');
    expect(mediaPartPath('system', 12)).toBe('media/system.012.m4a');
    expect(mediaIndexPath('screen', 0)).toBe('media/screen.000.index.json');
  });

  it('keeps the .000 suffix even for a single-part track', () => {
    // A media track is a list of parts, not a file, from day one — the retrofit is
    // what Cap pays for forever (§2.1).
    expect(partSuffix(0)).toBe('000');
    expect(() => partSuffix(-1)).toThrow(RangeError);
    expect(() => partSuffix(1000)).toThrow(RangeError);
  });

  it('content-addresses cursor bitmaps', () => {
    const sha = 'a'.repeat(64);
    expect(cursorImagePath(sha)).toBe(`cursors/${sha}.png`);
    expect(() => cursorImagePath('not-a-hash')).toThrow(TypeError);
    expect(() => cursorImagePath('A'.repeat(64))).toThrow(TypeError);
  });

  it('names the filmstrip and the migration backup', () => {
    expect(filmstripPath(0)).toBe('thumbs/strip/00000.jpg');
    expect(backupPath(BUNDLE.edit, 1)).toBe('edit.json.v1.bak');
  });

  it('sanitizes names without mangling ordinary ones', () => {
    expect(sanitizeRecordingName('Sprint review — auth refactor')).toBe(
      'Sprint review — auth refactor',
    );
    expect(sanitizeRecordingName('a/b')).toBe('a b');
    expect(sanitizeRecordingName('a:b')).toBe('a b');
    expect(sanitizeRecordingName('.hidden')).toBe('hidden');
    expect(sanitizeRecordingName('')).toBe('Untitled');
    expect(sanitizeRecordingName('x'.repeat(200))).toHaveLength(80);
  });
});

describe('bundle-relative path safety', () => {
  it('accepts real bundle paths', () => {
    expect(isSafeBundleRelativePath('media/screen.000.mp4')).toBe(true);
    expect(isSafeBundleRelativePath('cursors/index.json')).toBe(true);
  });

  it('rejects anything that could leave the bundle', () => {
    for (const bad of [
      '',
      '..',
      '../secrets',
      'media/../../etc/passwd',
      '/etc/passwd',
      'C:\\Windows',
      'media\\screen.mp4',
      './media/screen.mp4',
      'media//screen.mp4',
      'media/screen\u0000.mp4',
    ]) {
      expect(isSafeBundleRelativePath(bad), bad).toBe(false);
    }
  });
});

describe('ULIDs', () => {
  it('encodes the creation time and sorts lexicographically by it', () => {
    const earlier = ulid(1_000_000_000_000);
    const later = ulid(1_000_000_001_000);
    expect(isUlid(earlier)).toBe(true);
    expect(earlier).toHaveLength(26);
    expect(ulidTime(earlier)).toBe(1_000_000_000_000);
    expect(earlier < later).toBe(true);
  });

  it('is unique across many draws', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => ulid(1_700_000_000_000)));
    expect(seen.size).toBe(5000);
  });

  it('rejects non-ULIDs', () => {
    expect(isUlid('')).toBe(false);
    expect(isUlid('01K1Y7QZ8N3M4P5R6S7T8V9W0')).toBe(false); // 25 chars
    expect(isUlid('01K1Y7QZ8N3M4P5R6S7T8V9W0I')).toBe(false); // Crockford excludes I
  });
});

describe('schema ids', () => {
  it('round-trips', () => {
    expect(parseSchemaId(schemaId('loom.edit', 3))).toEqual({ family: 'loom.edit', version: 3 });
  });

  it('returns null instead of throwing for anything unrecognised', () => {
    for (const bad of [
      '',
      'loom.edit',
      'loom.edit/',
      '/1',
      'loom.edit/0',
      'loom.edit/x',
      42,
      null,
    ]) {
      expect(parseSchemaId(bad)).toBeNull();
    }
    expect(parseSchemaId('cap.project/1')).toBeNull();
  });
});

describe('writeAtomic', () => {
  it('replaces a file completely and leaves no temp behind', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'project.json');
      await writeJsonAtomic(path, { a: 1 });
      await writeJsonAtomic(path, { b: 2 });

      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ b: 2 });
      expect((await readdir(dir)).filter(isTempArtifact)).toEqual([]);
    });
  });

  it('writes a trailing newline, so the file is line-oriented tooling friendly', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.json');
      await writeJsonAtomic(path, { a: 1 });
      expect(await readFile(path, 'utf8')).toMatch(/\n$/);
    });
  });

  it('survives concurrent writes to the same path', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'project.json');
      // Two writes in flight at once must not share a temp file — that would be
      // exactly the torn write this exists to prevent.
      await Promise.all([
        writeAtomic(path, Buffer.from('a'.repeat(200_000))),
        writeAtomic(path, Buffer.from('b'.repeat(200_000))),
      ]);
      const text = await readFile(path, 'utf8');
      expect(text.length).toBe(200_000);
      expect(new Set(text)).toHaveProperty('size', 1);
      expect((await readdir(dir)).filter(isTempArtifact)).toEqual([]);
    });
  });

  it('does not leave a temp file when the write fails', async () => {
    await withTempDir(async (dir) => {
      await expect(
        writeAtomic(join(dir, 'no-such-directory', 'x.json'), Buffer.from('x')),
      ).rejects.toThrow();
      expect((await readdir(dir)).filter(isTempArtifact)).toEqual([]);
    });
  });

  it('creates files the user can read and write, and nobody else can write', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'project.json');
      await writeJsonAtomic(path, {});
      expect((await stat(path)).mode & 0o777).toBe(0o644);
    });
  });
});
