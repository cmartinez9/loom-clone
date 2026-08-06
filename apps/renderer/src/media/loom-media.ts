/**
 * Getting at a recording's media from a renderer.
 *
 * Everything here is a `loom://` fetch and a pure parse. Renderers are sandboxed and
 * have no filesystem (§1.4); main serves bytes from inside one `.loomrec` with
 * `Range` support, and that is the whole channel. Nothing in this file knows a path.
 *
 * Three things a `SourceReader` needs, and where each comes from:
 *
 *  1. bytes — {@link loomByteReader}, a range reader over the part's URL;
 *  2. the index — {@link fetchFrameIndex}, the `loom.index/1` sidecar (§2.4);
 *  3. a `VideoDecoderConfig` — {@link readVideoDecoderConfig}, read out of the
 *     part's own initialisation segment.
 *
 * The third is the one `source-reader.ts` flags as *"the one thing an adapter has to
 * decide … where the `avcC` description comes from after a restart, since
 * `recording.json` does not carry it"*. It is read from the file. The alternative —
 * persisting it beside the part — is a second copy of a fact that is already on
 * disk, and two copies of a codec description is one that can be stale.
 */

import { fetchByteRangeReader, type ByteRangeReader } from '@loom/decode';
import { validateFrameIndexDoc, type FrameIndexDoc } from '@loom/format';
import {
  MAX_BOX_HEADER_BYTES,
  codecStringFromAsc,
  parseAudioInitSegment,
  parseInitSegment,
  parseMoof,
  readBoxHeader,
} from '@loom/mux';

/**
 * How much of a part is read to find its initialisation segment.
 *
 * `ftyp` + a single-track `moov` is well under a kilobyte; 64 KB is generous enough
 * that no plausible `avcC` or `esds` is cut in half, and small enough to be one
 * range request.
 */
const INIT_SEGMENT_PROBE_BYTES = 64 * 1024;

export function loomByteReader(url: string, fetchLike: typeof fetch = fetch): ByteRangeReader {
  return fetchByteRangeReader(url, {
    fetchImpl: (input, init) => fetchLike(input, { headers: init.headers, signal: init.signal }),
  });
}

/** Fetch and validate a `loom.index/1` sidecar. Parse → validate, like every read. */
export async function fetchFrameIndex(
  url: string,
  fetchLike: typeof fetch = fetch,
): Promise<FrameIndexDoc> {
  const response = await fetchLike(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const result = validateFrameIndexDoc(await response.json());
  if (!result.ok) {
    throw new Error(
      `${url} is not a valid frame index: ` +
        result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    );
  }
  return result.value;
}

/**
 * Read the head of a part and turn its `moov` into a `VideoDecoderConfig`.
 *
 * `optimizeForLatency` is deliberately *not* set here — `SourceReader` applies it
 * itself, the same way for preview and for export, so the two cannot disagree about
 * when frames come out (see `#configure` there).
 */
export async function readVideoDecoderConfig(bytes: ByteRangeReader): Promise<VideoDecoderConfig> {
  const head = await readHead(bytes, INIT_SEGMENT_PROBE_BYTES);
  const facts = parseInitSegment(head);
  return {
    // The capture parts are High profile AVC in `avc` (length-prefixed) framing, and
    // the profile/level bytes that make the codec string are the first three of the
    // `avcC` itself — so the string describes the bitstream rather than a guess.
    codec: avcCodecString(facts.avcC),
    codedWidth: facts.width,
    codedHeight: facts.height,
    description: facts.avcC,
  };
}

/** `avc1.PPCCLL` from an `avcC`'s profile, constraint flags and level. */
export function avcCodecString(avcC: Uint8Array): string {
  const profile = avcC[1] ?? 0;
  const constraints = avcC[2] ?? 0;
  const level = avcC[3] ?? 0;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
}

/** One encoded audio sample, as `AudioDecoder` wants it. */
export interface EncodedAudioSample {
  data: Uint8Array;
  /** Index of this frame's first sample in the part's encoded stream. */
  firstSample: number;
  sampleCount: number;
}

export interface AudioPartMedia {
  config: AudioDecoderConfig;
  sampleRate: number;
  channels: number;
  /** Priming samples the container's edit list trims. See `boxes.ts`. */
  encoderDelaySamples: number;
  samples: EncodedAudioSample[];
}

/**
 * Read a whole `.m4a` capture part and split it into encoded frames.
 *
 * The whole file, on purpose: an audio part is a fragmented MP4 whose sample
 * boundaries live in its `moof` headers, so finding frame *n* means walking the
 * fragments — and at 128 kbps a twenty-minute part is 19 MB, which is one fetch and
 * a walk rather than a reason to build a second index format.
 *
 * **The priming is reported, not applied.** `parseAudioInitSegment().encoderDelaySamples`
 * is the trim the container's `elst` states; a reader that pulls raw chunks out of a
 * part instead of demuxing it has to apply it itself, and this function's caller is
 * exactly that reader.
 */
export async function fetchAudioPartMedia(
  url: string,
  fetchLike: typeof fetch = fetch,
): Promise<AudioPartMedia> {
  const response = await fetchLike(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const facts = parseAudioInitSegment(bytes);

  const samples: EncodedAudioSample[] = [];
  let at = 0;
  let firstSample = 0;
  while (at < bytes.byteLength) {
    const header = readBoxHeader(bytes, at);
    if (header === null || at + header.size > bytes.byteLength) break;
    if (header.type !== 'moof') {
      at += header.size;
      continue;
    }
    const moof = parseMoof(bytes.subarray(at, at + header.size));
    const mdat = readBoxHeader(bytes, at + header.size);
    if (mdat?.type !== 'mdat') break;
    let payloadAt = at + header.size + mdat.headerBytes;
    for (const sample of moof.samples) {
      const end = payloadAt + sample.sizeBytes;
      if (end > bytes.byteLength) break;
      samples.push({
        data: bytes.subarray(payloadAt, end),
        firstSample,
        sampleCount: sample.durationUnits,
      });
      firstSample += sample.durationUnits;
      payloadAt = end;
    }
    at += header.size + mdat.size;
  }

  return {
    config: {
      codec: codecStringFromAsc(facts.audioSpecificConfig),
      sampleRate: facts.sampleRate,
      numberOfChannels: facts.channels,
      description: facts.audioSpecificConfig,
    },
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    encoderDelaySamples: facts.encoderDelaySamples,
    samples,
  };
}

/** Read up to `want` bytes from the front, tolerating a shorter source. */
async function readHead(bytes: ByteRangeReader, want: number): Promise<Uint8Array> {
  const size = bytes.byteLength;
  const end = size === null ? want : Math.min(want, size);
  if (end < MAX_BOX_HEADER_BYTES) {
    throw new Error('the media part is too short to hold an initialisation segment');
  }
  return bytes.read(0, end, new AbortController().signal);
}
