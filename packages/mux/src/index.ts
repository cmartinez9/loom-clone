/**
 * `@loom/mux` — MP4 writing and reading.
 *
 * Architecture report §1.3 lists `packages/mux` as *"MP4 writer (fragmented for
 * capture, faststart for export)"*. Phase 1 owns the capture half: the fragmented
 * writer, and the scanner that crash recovery reads it back with. The export half
 * arrives with phase 8.
 *
 * This entry point is **pure**: no `node:` imports, no DOM, no I/O, exactly like
 * `@loom/format`. Everything that owns a file descriptor lives behind
 * `@loom/mux/fs`, which only `ProjectStore` imports — because main is the only
 * writer (§0, rule 2) and that is enforced by lint, not by memory.
 */

export {
  MOVIE_TIMESCALE,
  SAMPLE_FLAGS_DELTA,
  SAMPLE_FLAGS_SYNC,
  box,
  concat,
  fourcc,
  fragment,
  ftyp,
  fullBox,
  initSegment,
  type ColourDescription,
  type FragmentSpec,
  type InitSegmentSpec,
} from './boxes.ts';

export {
  FragmentWriter,
  frameIndexDoc,
  partDurationSec,
  type EmittedFragment,
  type EncodedSample,
  type FragmentWriterOptions,
  type IndexedFrame,
} from './fragment-writer.ts';

export {
  MAX_BOX_HEADER_BYTES,
  Mp4ParseError,
  codecStringFromAvcC,
  parseInitSegment,
  parseMoof,
  readBoxHeader,
  type BoxHeader,
  type FragmentSample,
  type InitSegmentFacts,
  type ParsedFragment,
} from './scan.ts';
