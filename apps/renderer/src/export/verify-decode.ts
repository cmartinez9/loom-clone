/**
 * §7.5's fifth verification point: *"**last frame actually decodes**"*.
 *
 * `decision-loom-storage-retention.md` deletes the user's only copy of the raw
 * sources on the strength of an export's success, so "the file exists and is the
 * right length" is not enough — a truncated or mis-offset `mdat` produces a file
 * that demuxes, reports the right duration, and hands a decoder garbage at the end.
 * The only way to know otherwise is to decode it.
 *
 * A decoder lives in a renderer, so main re-reads the finished file, reconstructs
 * the last GOP from the sample table **on disk** (never from the writer's memory),
 * and sends the encoded chunks here. Encoded chunks are exactly what may cross
 * (§1.4). What comes back is a count and the last timestamp, so "the decoder emitted
 * something" and "the decoder emitted the frame we asked about" stay different
 * answers.
 *
 * Every frame is closed in a `finally` (§10.2). A verification pass that leaked
 * frames would exhaust the decoder pool of the window that is about to run the next
 * export.
 */

import type { ExportDecodeRequest } from '@loom/ipc';

/** Longest wait for the flush to produce its outputs. */
const DECODE_TIMEOUT_MS = 15_000;

export interface DecodeOutcome {
  ok: boolean;
  framesDecoded: number;
  lastTimestampUs: number | null;
  error?: string;
}

export async function verifyByDecoding(request: ExportDecodeRequest): Promise<DecodeOutcome> {
  if (request.chunks.length === 0) {
    return { ok: false, framesDecoded: 0, lastTimestampUs: null, error: 'no chunks to decode' };
  }
  if (request.chunks[0]?.isKey !== true) {
    // Chromium requires a keyframe as the first chunk after `configure()`. Being
    // handed a delta first is main's bug, and saying so beats a decoder error whose
    // message is about a keyframe the caller never mentioned.
    return {
      ok: false,
      framesDecoded: 0,
      lastTimestampUs: null,
      error: 'the first chunk to verify is not a sync sample',
    };
  }

  let framesDecoded = 0;
  let lastTimestampUs: number | null = null;
  let failure: string | null = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        framesDecoded += 1;
        lastTimestampUs = frame.timestamp;
      } finally {
        frame.close();
      }
    },
    error: (error: DOMException) => {
      failure ??= error.message;
    },
  });

  try {
    decoder.configure({
      codec: request.codec,
      codedWidth: request.codedWidth,
      codedHeight: request.codedHeight,
      description: request.description,
    });
    for (const chunk of request.chunks) {
      decoder.decode(
        new EncodedVideoChunk({
          type: chunk.isKey ? 'key' : 'delta',
          timestamp: chunk.timestampUs,
          data: chunk.data,
        }),
      );
    }
    // `flush()` is right here and wrong in `SourceReader`: this decoder is used once
    // and thrown away, so the re-seek a flush costs the next frame does not exist.
    await withTimeout(decoder.flush(), DECODE_TIMEOUT_MS);
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }

  if (failure !== null) return { ok: false, framesDecoded, lastTimestampUs, error: failure };
  if (framesDecoded === 0) {
    return { ok: false, framesDecoded, lastTimestampUs, error: 'the decoder produced no frames' };
  }
  // Not "a frame came out" — *the* frame. A decoder that dropped the tail and
  // emitted the GOP's earlier frames would otherwise verify a truncated export.
  const wanted = request.expectLastTimestampUs;
  if (lastTimestampUs === null || Math.abs(lastTimestampUs - wanted) > 1) {
    return {
      ok: false,
      framesDecoded,
      lastTimestampUs,
      error:
        `the last decoded frame is at ${String(lastTimestampUs)}us, not the ` +
        `${wanted}us the file's sample table puts last`,
    };
  }
  return { ok: true, framesDecoded, lastTimestampUs };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`the decoder did not finish within ${ms}ms`));
      }, ms),
    ),
  ]);
}
