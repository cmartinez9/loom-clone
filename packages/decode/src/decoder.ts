/**
 * The decoder seam — and why there is still exactly **one** decode path.
 *
 * Architecture report §4.2 is emphatic: *"Two decoders means two color pipelines,
 * two frame-selection rules and two seek behaviours, which is exactly the 'looked
 * right in the editor, wrong in the export' bug. So: `VideoDecoder` for both."*
 *
 * This file does not weaken that. There is one decode *path* — `SourceReader`, its
 * seek rule, its discard rule, its ring — and preview and export both run it. What
 * is substitutable here is the twenty lines that bind that path to the platform's
 * `VideoDecoder`, so the seek and lifetime logic can be exercised in a Node test
 * where WebCodecs does not exist. The shipping default is
 * {@link webCodecsDecoderFactory} and there is no second implementation of it.
 *
 * The seam also does one useful piece of work in its own right: it takes a plain
 * `ChunkInit` rather than an `EncodedVideoChunk`, so `SourceReader` never
 * constructs a platform object and the chunk it submits is exactly the shape the
 * capture spine already sends over IPC (§1.4's `ChunkMsg`).
 */

/** A chunk to decode. Deliberately the same shape as §1.4's `ChunkMsg` payload. */
export interface ChunkInit {
  type: 'key' | 'delta';
  /** Presentation timestamp in **microseconds**. */
  timestamp: number;
  /** Microseconds, or `null` when the source does not know — VFR usually does not. */
  duration: number | null;
  data: Uint8Array;
}

export interface DecoderCallbacks<T> {
  output: (frame: T) => void;
  error: (error: Error) => void;
}

/**
 * `VideoDecoder`, narrowed to what `SourceReader` uses.
 *
 * **`flush()` is deliberately absent**, and it cost a gate run to learn why.
 * Chromium requires a keyframe as the first chunk after `configure()` *and after
 * every `flush()`* — `DataError: A key frame is required after configure() or
 * flush()`. So a reader that flushed to find out whether its outputs had landed
 * would have to re-seek to a keyframe and re-decode a whole GOP on the next frame
 * of ordinary forward playback. `SourceReader` waits on the output callback
 * instead, which is both correct and cheaper. Anything added here later should
 * check the same thing: does it make the next chunk have to be a keyframe?
 */
export interface VideoDecoderLike {
  readonly state: 'unconfigured' | 'configured' | 'closed';
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: ChunkInit): void;
  /** Drops queued work and unconfigures. The next chunk must be a keyframe. */
  reset(): void;
  close(): void;
}

export type DecoderFactory<T> = (callbacks: DecoderCallbacks<T>) => VideoDecoderLike;

/**
 * The real thing: a WebCodecs `VideoDecoder`.
 *
 * `close()` is idempotent here because it is called from `finally` blocks on paths
 * that may already have closed it, and `VideoDecoder.close()` on a closed decoder
 * throws `InvalidStateError`.
 */
export const webCodecsDecoderFactory: DecoderFactory<VideoFrame> = (callbacks) => {
  const decoder = new VideoDecoder({
    output: callbacks.output,
    error: (error: DOMException) => {
      callbacks.error(error instanceof Error ? error : new Error(String(error)));
    },
  });

  return {
    get state() {
      return decoder.state;
    },
    get decodeQueueSize() {
      return decoder.decodeQueueSize;
    },
    configure(config) {
      decoder.configure(config);
    },
    decode(chunk) {
      decoder.decode(
        new EncodedVideoChunk(
          chunk.duration === null
            ? { type: chunk.type, timestamp: chunk.timestamp, data: chunk.data }
            : {
                type: chunk.type,
                timestamp: chunk.timestamp,
                duration: chunk.duration,
                data: chunk.data,
              },
        ),
      );
    },
    reset() {
      if (decoder.state !== 'closed') decoder.reset();
    },
    close() {
      if (decoder.state !== 'closed') decoder.close();
    },
  };
};

/** True when this runtime can decode at all — a renderer, not the main process. */
export function hasWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}
