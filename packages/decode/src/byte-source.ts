/**
 * `ByteRangeReader` — how this package gets at a media part's bytes.
 *
 * This is one half of the **frame-input interface** (the other half is the
 * `DemuxIndex` and the `VideoDecoderConfig`; see `source-reader.ts`). It is
 * deliberately the narrowest thing that can work: *give me these bytes, and let me
 * cancel*. `SourceReader` never learns what a file is, what a URL is, or what a
 * container is.
 *
 * That narrowness is the point. Architecture report §2.4: *"`offsets` lets the
 * editor seek to a keyframe with a single range request and decode forward, without
 * parsing the MP4 sample tables at all."* Because the index says where every frame
 * lives, the reader needs byte ranges and nothing else — so the capture spine can
 * write whatever container it likes as long as the index points into it.
 *
 * In the app the implementation is {@link fetchByteRangeReader} over a `loom://`
 * URL, which `protocol.handle()` in main serves with `Range` support
 * (`apps/main/src/media-reader.ts`). In a test it is {@link bytesReader}.
 */

/** Bytes on demand, cancellably. */
export interface ByteRangeReader {
  /** Total size when known, `null` when the source will not say. */
  readonly byteLength: number | null;
  /**
   * Read `[start, end)`.
   *
   * Must reject — not resolve short — when `signal` aborts, and must reject rather
   * than resolve a short read for any other reason. A silently short read would
   * feed the decoder a truncated access unit, which does not throw; it produces
   * garbage or nothing.
   */
  read(start: number, end: number, signal: AbortSignal): Promise<Uint8Array>;
}

/** `fetch`, narrowed to what this module uses, so a test can supply its own. */
export type FetchLike = (
  input: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/**
 * Read byte ranges over HTTP semantics — in the app, the `loom://` protocol.
 *
 * A server that ignores `Range` and answers `200` with the whole body is handled by
 * slicing, because being right is cheaper than being surprised at 4K. A server that
 * answers `206` with the wrong length is an error: silently accepting it is how you
 * get a decoder that stops producing frames with no message anywhere.
 */
export function fetchByteRangeReader(
  url: string,
  options: { byteLength?: number; fetchImpl?: FetchLike } = {},
): ByteRangeReader {
  const doFetch: FetchLike =
    options.fetchImpl ??
    ((input, init) => fetch(input, { headers: init.headers, signal: init.signal }));
  const declared = options.byteLength;

  return {
    byteLength: declared ?? null,
    async read(start, end, signal) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
        throw new RangeError(`bad byte range [${String(start)}, ${String(end)})`);
      }
      const want = end - start;
      const response = await doFetch(url, {
        headers: { Range: `bytes=${String(start)}-${String(end - 1)}` },
        signal,
      });
      if (response.status === 206) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== want) {
          throw new Error(
            `${url}: asked for ${String(want)} bytes at ${String(start)}, got ${String(bytes.byteLength)}`,
          );
        }
        return bytes;
      }
      if (response.status === 200) {
        const whole = new Uint8Array(await response.arrayBuffer());
        if (whole.byteLength < end) {
          throw new Error(
            `${url}: ignored Range and returned ${String(whole.byteLength)} bytes, ` +
              `short of the ${String(end)} needed`,
          );
        }
        return whole.subarray(start, end);
      }
      throw new Error(
        `${url}: HTTP ${String(response.status)} for bytes ${String(start)}-${String(end - 1)}`,
      );
    },
  };
}

/** An in-memory source. Used by fixtures and tests; the shape is identical. */
export function bytesReader(bytes: Uint8Array): ByteRangeReader {
  return {
    byteLength: bytes.byteLength,
    read(start, end, signal) {
      if (signal.aborted) return Promise.reject(abortError(signal));
      if (start < 0 || end > bytes.byteLength || end <= start) {
        return Promise.reject(new RangeError(`bad byte range [${String(start)}, ${String(end)})`));
      }
      return Promise.resolve(bytes.subarray(start, end));
    },
  };
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted');
}
