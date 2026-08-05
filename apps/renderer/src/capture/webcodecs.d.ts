/**
 * `MediaStreamTrackProcessor` — the one capture API TypeScript's DOM library does
 * not declare yet.
 *
 * It is the reason capture works at all: research report §5.5 measured
 * `MediaRecorder` dropping **40–80% of frames** on a screen track, while
 * `MediaStreamTrackProcessor` + `VideoEncoder` keeps up. The rest of the pipeline
 * — `VideoFrame`, `VideoEncoder`, `EncodedVideoChunk` — is in `lib.dom.d.ts`.
 *
 * Declared narrowly: only the members this app uses, so an unimplemented option
 * cannot be typed into existence.
 */

/**
 * AAC options, which `lib.dom.d.ts` knows about for Opus and not for AAC.
 *
 * `format: 'aac'` is raw AAC frames plus an AudioSpecificConfig in
 * `decoderConfig.description` — exactly what an MP4 `esds` wants. The alternative,
 * `'adts'`, wraps every frame in a seven-byte header that would then have to be
 * stripped before muxing.
 */
interface AacEncoderConfig {
  format?: 'aac' | 'adts';
}

interface AudioEncoderConfig {
  aac?: AacEncoderConfig;
}

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  /** Frames buffered before the source starts dropping them. */
  maxBufferSize?: number;
}

declare class MediaStreamTrackProcessor<T = VideoFrame> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}
