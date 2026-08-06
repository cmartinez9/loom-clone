/**
 * One export job, run inside the hidden export window.
 *
 * §1.2 gives this window its own row in the table: *"Export · hidden · one hidden
 * window per job; own GL context, decoder, encoder"*, and *"The export window is
 * owned by main, not by the editor — closing the editor mid-export must not kill the
 * export."* This file is what runs in it.
 *
 * ## The order of the two passes
 *
 * **Audio first, then video.** Not a detail of taste: audio is seconds of work where
 * video is minutes (§5.7 — 2.1–2.5× realtime composited), and `ExportMp4Writer`
 * keeps each track's samples in its own scratch stream, so the order they are
 * produced in has no effect on the file's interleave. Doing the cheap pass first
 * means a machine that cannot encode AAC at all fails in the first second rather
 * than after four minutes of compositing.
 *
 * ## What crosses to main, and what does not
 *
 * Encoded chunks, and the encoders' own `decoderConfig`. Never a frame, never a
 * pixel buffer, never the canvas (§1.4) — `packages/ipc/test/ipc-boundary.test.ts`
 * fails the build if one appears in the contract. Main writes; this window proposes
 * (§0, rule 2).
 */

import { Compositor, type TextAtlas } from '@loom/compositor';
import { uploadTextAtlas } from '@loom/compositor/raster';
import { compile, type CompiledTimeline } from '@loom/edl';
import type {
  ExportChunkMsg,
  ExportFailedMsg,
  ExportJob,
  ExportMetaMsg,
  ExportPassDoneMsg,
  ExportPassProgressMsg,
} from '@loom/ipc';
import { loadGlyphRaster } from '../glyphs.ts';
import { fetchAudioPartMedia, type AudioPartMedia } from '../media/loom-media.ts';
import { openVideoTrack, type TrackReader } from '../media/track-reader.ts';
import { AudioSourceTrack } from './audio-source.ts';
import { runAudioPass } from './audio-pass.ts';
import { AudioExportEncoder, VideoExportEncoder } from './encode.ts';
import { ExportCancelledError, ExportRenderLoop } from './render-loop.ts';

/** Where an export sends what it produces. `window.loom.exportRender` satisfies it. */
export interface ExportBridge {
  meta(message: ExportMetaMsg): void;
  chunk(message: ExportChunkMsg): void;
  passProgress(message: ExportPassProgressMsg): void;
  passDone(message: ExportPassDoneMsg): void;
  failed(message: ExportFailedMsg): void;
}

/** The output audio rate, unless a source runs faster. §5.5's timebase. */
const DEFAULT_AUDIO_RATE = 48000;

export interface RunningExport {
  cancel(): void;
  readonly done: Promise<void>;
}

/**
 * Build the GL context an export composites into.
 *
 * **The canvas is exactly the output size.** §5.2's decisive property is that there
 * is no readback — the encoder is handed the canvas — which means `present()`'s blit
 * from the render target to the canvas is what reaches the file. At equal sizes that
 * blit is `NEAREST` and 1:1, so the pixels the golden-frame gate reads out of the
 * render target are the pixels that get encoded. At unequal sizes it would be a
 * resample, and the gate would be checking something the file does not contain.
 *
 * `preserveDrawingBuffer` because the frame is constructed from the canvas *after*
 * the blit rather than inside a compositing callback; without it Chromium is
 * entitled to have cleared it by then.
 */
export function createExportCanvas(
  width: number,
  height: number,
): {
  canvas: OffscreenCanvas;
  compositor: Compositor;
} {
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (gl === null) throw new Error('the export window could not create a WebGL2 context');
  return { canvas, compositor: new Compositor(gl, [width, height]) };
}

/**
 * Run a job to completion.
 *
 * Returns immediately with a handle: `cancel()` aborts at the next frame boundary,
 * and `done` rejects with {@link ExportCancelledError} when it does. Everything a
 * job opened — readers, decoders, encoders, the GL context — is released in a
 * `finally`, on every path, because §10.2's failure mode is an export that hangs
 * with no error anywhere.
 */
export function runExportJob(job: ExportJob, bridge: ExportBridge): RunningExport {
  const controller = new AbortController();
  const done = execute(job, bridge, controller.signal).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    bridge.failed({ jobId: job.jobId, message });
    throw error;
  });
  return {
    cancel: () => {
      controller.abort();
    },
    done,
  };
}

async function execute(job: ExportJob, bridge: ExportBridge, signal: AbortSignal): Promise<void> {
  const timeline = compile(job.edit, { cursor: null, clicks: null, recording: job.recording });

  if (job.passes.audio) await runAudio(job, bridge, timeline, signal);
  if (job.passes.video) await runVideo(job, bridge, timeline, signal);
}

// ------------------------------------------------------------------------ audio

async function runAudio(
  job: ExportJob,
  bridge: ExportBridge,
  timeline: CompiledTimeline,
  signal: AbortSignal,
): Promise<void> {
  if (job.audio.length === 0) return;

  const loaded: {
    key: 'mic' | 'system';
    part: ExportJob['audio'][number];
    media: AudioPartMedia;
  }[] = [];
  for (const source of job.audio) {
    loaded.push({
      key: source.track === 'mic' ? 'mic' : 'system',
      part: source,
      media: await fetchAudioPartMedia(source.mediaUrl),
    });
  }
  if (loaded.length === 0) return;

  const sampleRate = Math.max(DEFAULT_AUDIO_RATE, ...loaded.map((l) => l.media.sampleRate));
  const channels = Math.min(2, Math.max(1, ...loaded.map((l) => l.media.channels)));

  const build = (key: 'mic' | 'system'): AudioSourceTrack | null => {
    const parts = loaded
      .filter((l) => l.key === key)
      .map((l) => ({ part: l.part.part, media: l.media }));
    return parts.length === 0 ? null : new AudioSourceTrack({ parts });
  };
  const mic = build('mic');
  const system = build('system');

  const encoder = await AudioExportEncoder.open({
    sampleRate,
    channels,
    bitrate: job.settings.audioBitrate,
    onConfig: (decoderConfig) => {
      bridge.meta({ jobId: job.jobId, kind: 'audio', decoderConfig });
    },
    onChunk: (chunk) => {
      bridge.chunk({ jobId: job.jobId, kind: 'audio', ...chunk });
    },
  });

  try {
    await runAudioPass({
      timeline,
      mic,
      system,
      sampleRate,
      channels,
      signal,
      onBlock: async (block) => {
        encoder.encode(block.channels, block.timestampUs);
        await encoder.drain();
      },
      onProgress: (renderedSec, totalSec) => {
        bridge.passProgress({ jobId: job.jobId, phase: 'audio', renderedSec, totalSec });
      },
    });
    await encoder.close();
    bridge.passDone({ jobId: job.jobId, kind: 'audio', sampleCount: encoder.encodedCount });
  } finally {
    mic?.close();
    system?.close();
    // `close()` above already flushed on the happy path; on a throw this is what
    // stops a configured encoder outliving the job that owns it.
    await encoder.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------------ video

async function runVideo(
  job: ExportJob,
  bridge: ExportBridge,
  timeline: CompiledTimeline,
  signal: AbortSignal,
): Promise<void> {
  const { width, height, fps, bitrate } = job.settings;
  const { canvas, compositor } = createExportCanvas(width, height);

  let screen: TrackReader | null = null;
  let encoder: VideoExportEncoder | null = null;
  try {
    screen = await openVideoTrack({
      parts: job.screen.map((source) => ({
        mediaUrl: source.mediaUrl,
        indexUrl: source.indexUrl,
        startTimeSec: source.part.startTimeSec,
        durationSec: source.part.durationSec,
      })),
    });

    encoder = await VideoExportEncoder.open({
      width,
      height,
      bitrate,
      fps,
      onConfig: (decoderConfig) => {
        bridge.meta({ jobId: job.jobId, kind: 'video', decoderConfig });
      },
      onChunk: (chunk) => {
        bridge.chunk({ jobId: job.jobId, kind: 'video', ...chunk });
      },
    });

    const video = encoder;
    const durationUs = Math.round(1e6 / fps);
    const loop = new ExportRenderLoop({
      compositor,
      screen,
      timeline,
      fps,
      signal,
      // §4.5: annotation geometry, colour and opacity are on the must-be-identical
      // list, and a glyph raster is the one part of an annotation a renderer decides
      // rather than we do — so a `text` span reaching a file needs an atlas here as
      // well as in the preview, made the same way. `../glyphs.ts` is that one way,
      // and it is where the trap lives: a face nothing on the page renders is never
      // fetched, and this page has no DOM at all.
      //
      // Built only when the document actually has a `text` span. The atlas is a
      // texture and a fetch of five woff2 files, and every other annotation kind
      // draws without one.
      textAtlas: (await exportTextAtlas(job, compositor.gl)) ?? null,

      onFrame: async (frame) => {
        // The composite is already on the canvas: `renderFrame` called `present()`,
        // and the canvas is the output size, so this is the render target's pixels.
        video.encode(canvas, frame.timestampUs, frame.isKey, durationUs);
        await video.drain();
      },
      onProgress: (renderedSec, totalSec) => {
        bridge.passProgress({ jobId: job.jobId, phase: 'video', renderedSec, totalSec });
      },
    });

    await loop.run();
    await encoder.close();
    bridge.passDone({ jobId: job.jobId, kind: 'video', sampleCount: encoder.encodedCount });
  } finally {
    if (encoder !== null) await encoder.close().catch(() => undefined);
    // Every `VideoFrame` the ring holds, closed — §10.2. The GL context goes with
    // it, so a cancelled job leaves no 4K render target behind either.
    screen?.close();
    compositor.dispose();
  }
}

/**
 * The glyph atlas for this job, or `null` when it needs none.
 *
 * "Needs one" is *any* `text` span on any annotation track of the document, without
 * asking whether the span is enabled, inside its window, or inside the trim. Deciding
 * that here would be a second opinion about what `resolve` will do sixty times a
 * second over the whole export, and getting it wrong in the strict direction costs a
 * label in a finished file that the sources may then be deleted behind. Getting it
 * wrong in the lax direction costs one texture in a window that is about to encode a
 * video.
 */
async function exportTextAtlas(
  job: ExportJob,
  gl: WebGL2RenderingContext,
): Promise<TextAtlas | null> {
  const wantsText = job.edit.tracks.some((track) =>
    (track.spans ?? []).some((span) => span.type === 'text'),
  );
  if (!wantsText) return null;
  const raster = await loadGlyphRaster();
  return raster === null ? null : uploadTextAtlas(gl, raster);
}

export { ExportCancelledError };
