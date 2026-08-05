/**
 * `@loom/decode` — the one decode path.
 *
 * Architecture report §1.3 lists this package as `DemuxIndex, FrameRing,
 * SourceReader (WebCodecs VideoDecoder)`, and §4.2 explains why there is exactly
 * one of it: *"Two decoders means two color pipelines, two frame-selection rules
 * and two seek behaviours, which is exactly the 'looked right in the editor, wrong
 * in the export' bug."* Preview (phase 6) and export (phase 8) both run this code.
 *
 * The package is **pure**: no `node:`, no `electron`, no filesystem. It reaches the
 * world through two narrow seams — a {@link ByteRangeReader} for bytes and a
 * {@link DecoderFactory} for the platform's `VideoDecoder` — and `source-reader.ts`
 * documents what an adapter has to supply.
 */

export { closeQuietly, FrameLeakError, FrameLedger, type ClosableFrame } from './frames.ts';

export { DemuxIndex, NO_FRAME, type ByteSpan, type DemuxIndexInit } from './frame-index.ts';

export { DEFAULT_RING_CAPACITY, FrameRing, type FrameRingStats } from './frame-ring.ts';

export {
  bytesReader,
  fetchByteRangeReader,
  type ByteRangeReader,
  type FetchLike,
} from './byte-source.ts';

export {
  hasWebCodecs,
  webCodecsDecoderFactory,
  type ChunkInit,
  type DecoderCallbacks,
  type DecoderFactory,
  type VideoDecoderLike,
} from './decoder.ts';

export {
  DEFAULT_LOOKAHEAD_SEC,
  SourceReader,
  SupersededError,
  type SourceReaderInit,
  type SourceReaderStats,
} from './source-reader.ts';
