/**
 * Range serving for `loom://`.
 *
 * Ranges are not a nicety. The editor seeks a 4K MP4 by asking for the byte range
 * of one keyframe (§2.4), and the cursor log is read through `loom://` with range
 * requests specifically so it never crosses IPC as one blob (§1.4). A wrong 206 is
 * a video that decodes from the wrong offset, which looks like a decoder bug and
 * is not one.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentTypeFor, parseRange, serveFile } from '../src/media-reader.ts';

describe('parseRange', () => {
  const SIZE = 1000;

  it('returns null when nothing was asked for', () => {
    expect(parseRange(null, SIZE)).toBeNull();
    expect(parseRange('   ', SIZE)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
    // A suffix longer than the file is the whole file, not an error.
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past the file rather than inventing bytes', () => {
    expect(parseRange('bytes=990-5000', SIZE)).toEqual({ start: 990, end: 999 });
  });

  it('calls anything unsatisfiable what it is, so the caller can 416', () => {
    for (const header of [
      'bytes=1000-',
      'bytes=5-1',
      'bytes=-0',
      'bytes=-',
      'items=0-1',
      'bytes=a-b',
    ]) {
      expect(parseRange(header, SIZE), header).toBe('unsatisfiable');
    }
  });
});

describe('contentTypeFor', () => {
  it('names the containers this format writes', () => {
    expect(contentTypeFor('media/screen.000.mp4')).toBe('video/mp4');
    expect(contentTypeFor('media/mic.000.m4a')).toBe('audio/mp4');
    expect(contentTypeFor('events/cursor.ndjson')).toBe('application/x-ndjson');
    expect(contentTypeFor('cursors/abc.png')).toBe('image/png');
    expect(contentTypeFor('mystery.bin')).toBe('application/octet-stream');
  });
});

describe('serveFile', () => {
  async function withFile<T>(bytes: string, run: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'loom-serve-'));
    const path = join(dir, 'screen.000.mp4');
    await writeFile(path, bytes);
    try {
      return await run(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('serves a whole file with Accept-Ranges', async () => {
    await withFile('0123456789', async (path) => {
      const response = await serveFile(path, null);
      expect(response.status).toBe(200);
      expect(response.headers.get('Accept-Ranges')).toBe('bytes');
      expect(response.headers.get('Content-Length')).toBe('10');
      expect(await response.text()).toBe('0123456789');
    });
  });

  it('serves a 206 with the exact bytes and a correct Content-Range', async () => {
    await withFile('0123456789', async (path) => {
      const response = await serveFile(path, 'bytes=2-5');
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
      expect(response.headers.get('Content-Length')).toBe('4');
      expect(await response.text()).toBe('2345');
    });
  });

  it('answers an unsatisfiable range with 416, not a silent full body', async () => {
    await withFile('0123456789', async (path) => {
      const response = await serveFile(path, 'bytes=99-200');
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */10');
    });
  });
});
