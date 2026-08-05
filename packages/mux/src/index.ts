/**
 * `@loom/mux` — MP4 writing and reading.
 *
 * Architecture report §1.3 lists `packages/mux` as *"MP4 writer (fragmented for
 * capture, faststart for export)"*. Phases 1 and 3 own the capture half: the
 * fragmented writers for video and for AAC audio, and the scanner that crash
 * recovery reads them back with. The export half arrives with phase 8.
 *
 * This entry point is **pure**: no `node:` imports, no DOM, no I/O, exactly like
 * `@loom/format`. Everything that owns a file descriptor lives behind
 * `@loom/mux/fs`, which only `ProjectStore` imports — because main is the only
 * writer (§0, rule 2) and that is enforced by lint, not by memory.
 */

export {
  AAC_ENCODER_DELAY_SAMPLES,
  MOVIE_TIMESCALE,
  SAMPLE_FLAGS_DELTA,
  SAMPLE_FLAGS_SYNC,
  audioFtyp,
  audioInitSegment,
  box,
  concat,
  fourcc,
  fragment,
  ftyp,
  fullBox,
  initSegment,
  type AudioInitSegmentSpec,
  type ColourDescription,
  type FragmentSpec,
  type InitSegmentSpec,
} from './boxes.ts';

export {
  AAC_FRAME_SAMPLES,
  AudioFragmentWriter,
  type EmittedAudioFragment,
} from './audio-fragment-writer.ts';

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
  MIN_BOX_HEADER_BYTES,
  Mp4ParseError,
  codecStringFromAsc,
  codecStringFromAvcC,
  parseAudioInitSegment,
  parseAudioSpecificConfig,
  parseInitSegment,
  parseMoof,
  readBoxHeader,
  type AudioInitSegmentFacts,
  type BoxHeader,
  type FragmentSample,
  type InitSegmentFacts,
  type ParsedFragment,
} from './scan.ts';
