/**
 * Read-only byte serving for the `loom://` protocol.
 *
 * This module reads files and does nothing else — no `open('w')`, no `rename`, no
 * `unlink`. It is the second and last file in `apps/main` permitted to import
 * `node:fs`, and the lint rule says so out loud.
 *
 * Byte ranges are not a nicety here. Architecture report §1.4: the cursor log must
 * never cross IPC as one blob — *"It is appended in main and read by the editor
 * through `loom://` with range requests"* — and the editor seeks a 4K MP4 by
 * asking for the byte range of one keyframe (§2.4).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname } from 'node:path';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.json': 'application/json',
  '.ndjson': 'application/x-ndjson',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface ByteRange {
  start: number;
  /** Inclusive, as in HTTP. */
  end: number;
}

/**
 * Parse an HTTP `Range` header against a known size.
 *
 * Returns `null` for "no range asked for", and `'unsatisfiable'` for a range that
 * cannot be served — which must become a 416, not a silent full-body response, or
 * a seeking `<video>` will quietly decode from the wrong offset.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (header === null || header.trim() === '') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return 'unsatisfiable';

  const [, startText = '', endText = ''] = match;
  if (startText === '' && endText === '') return 'unsatisfiable';

  if (startText === '') {
    // `bytes=-500` — the last 500 bytes.
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    if (size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number.parseInt(startText, 10);
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';
  const end = endText === '' ? size - 1 : Number.parseInt(endText, 10);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Serve a file as a `Response`, honouring `Range`.
 *
 * The body is a stream, not a buffer: a 2 GB screen recording must not be read
 * into main's heap to answer a seek.
 */
export async function serveFile(path: string, rangeHeader: string | null): Promise<Response> {
  const stats = await stat(path);
  const size = stats.size;
  const type = contentTypeFor(path);
  const range = parseRange(rangeHeader, size);

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${String(size)}`, 'Accept-Ranges': 'bytes' },
    });
  }

  if (range === null) {
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  }

  const stream = Readable.toWeb(
    createReadStream(path, { start: range.start, end: range.end }),
  ) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    },
  });
}
