/**
 * Reading a finished export back — the parsing half of §7.5's verification.
 *
 * `decision-loom-storage-retention.md` deletes the user's only copy of the raw
 * sources on the strength of an export's success signal, and §7.5 obligation 1
 * spells out what that signal has to be worth: *"file exists · size > 0 · demuxes ·
 * duration within 100 ms of expected · **last frame actually decodes** · sha256
 * recorded"*. "Demuxes" is this file.
 *
 * It parses the `moov` **off the disk**, not out of the writer's memory. That is the
 * whole point: `FastStartWriter` believing it wrote a correct table is not evidence,
 * because the failure this guards against is the bytes on disk not matching what the
 * process thought it wrote. So the verifier re-reads the header it just produced and
 * reconstructs the sample tables from it, and the last frame's byte range comes back
 * from *that* reconstruction rather than from the plan.
 *
 * Deliberately narrow: it understands the boxes {@link FastStartWriter} emits and
 * refuses anything else rather than half-reading it. A file we cannot fully account
 * for must not be able to report itself verified.
 */

import { Mp4ParseError, readBoxHeader, type BoxHeader } from './scan.ts';

const decoder = new TextDecoder('latin1');

export interface MovieSample {
  /** 0-based index within its track. */
  index: number;
  /** Absolute byte offset in the file. */
  offset: number;
  byteLength: number;
  /** Decode time of this sample, in media timescale units. */
  decodeUnits: number;
  durationUnits: number;
  isSync: boolean;
}

export interface MovieTrack {
  trackId: number;
  handler: 'vide' | 'soun';
  timescale: number;
  /** `mdhd.duration`, media timescale units. */
  durationUnits: number;
  durationSec: number;
  /**
   * `tkhd.duration` in seconds — what this track **presents**, priming excluded.
   *
   * Shorter than {@link durationSec} on an audio track, by exactly the `elst`'s
   * media time: the AAC priming is in the stream and is not sound. `mvhd.duration`
   * is the longest of these across the tracks, so a file where they disagree is one
   * whose header contradicts itself.
   */
  presentedSec: number;
  /** Four-character sample entry type: `avc1` or `mp4a`. */
  sampleEntry: string;
  /** The `avcC` (video) or AudioSpecificConfig (audio), verbatim. */
  codecDescription: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  /** `elst` media time — the priming this track asks a player to skip. */
  editMediaTime: number;
  samples: MovieSample[];
}

export interface Movie {
  /** `mvhd.timescale`. */
  timescale: number;
  durationSec: number;
  /** True when `moov` precedes `mdat` — what "faststart" names. */
  fastStart: boolean;
  tracks: MovieTrack[];
}

/**
 * How many bytes from the front of a file are guaranteed to contain the whole
 * header, for a caller that has to read before it can know.
 *
 * `ftyp` is 40 bytes and every `moov` declares its own size in its first four, so a
 * reader takes this much, learns the real length from {@link movieHeaderLength}, and
 * reads exactly that if it needs more.
 */
export const HEADER_PROBE_BYTES = 64 * 1024;

/**
 * Total bytes of `ftyp` + `moov`, or `null` if `head` does not yet hold enough to
 * say. `moov` after `mdat` — a non-faststart file — reports `null` too: this
 * function's caller wants a header at the front, and there is not one.
 */
export function movieHeaderLength(head: Uint8Array): number | null {
  let at = 0;
  while (at < head.byteLength) {
    const header = readBoxHeader(head, at);
    if (header === null) return null;
    if (header.type === 'moov') return at + header.size;
    if (header.type === 'mdat') return null;
    at += header.size;
  }
  return null;
}

function children(
  bytes: Uint8Array,
  from: number,
  to: number,
): { header: BoxHeader; at: number }[] {
  const found: { header: BoxHeader; at: number }[] = [];
  let at = from;
  while (at < to) {
    const header = readBoxHeader(bytes, at);
    if (header === null || at + header.size > to) break;
    found.push({ header, at });
    at += header.size;
  }
  return found;
}

function child(
  bytes: Uint8Array,
  from: number,
  to: number,
  type: string,
): { header: BoxHeader; at: number } {
  const found = children(bytes, from, to).find((c) => c.header.type === type);
  if (found === undefined) throw new Mp4ParseError(`missing ${type} box`);
  return found;
}

function optionalChild(
  bytes: Uint8Array,
  from: number,
  to: number,
  type: string,
): { header: BoxHeader; at: number } | null {
  return children(bytes, from, to).find((c) => c.header.type === type) ?? null;
}

/**
 * Parse `ftyp` + `moov` into tracks with absolute sample offsets.
 *
 * `head` must hold the whole header — {@link movieHeaderLength} says how much that
 * is. The `mdat` payload is *not* needed and is never read: every offset comes out
 * of `co64`/`stco`, which is exactly the indirection a verifier wants, because it
 * means a table pointing outside the file is caught rather than papered over.
 */
export function parseMovie(head: Uint8Array): Movie {
  const top = children(head, 0, head.byteLength);
  const moovIndex = top.findIndex((c) => c.header.type === 'moov');
  const moov = top[moovIndex];
  if (moov === undefined) throw new Mp4ParseError('no moov box');
  const mdatIndex = top.findIndex((c) => c.header.type === 'mdat');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

  const mvhd = child(head, moov.at + moov.header.headerBytes, moov.at + moov.header.size, 'mvhd');
  const mvhdAt = mvhd.at + mvhd.header.headerBytes;
  const mvhdVersion = view.getUint8(mvhdAt);
  if (mvhdVersion !== 0) throw new Mp4ParseError('only a version-0 mvhd is understood');
  const timescale = view.getUint32(mvhdAt + 12, false);
  const durationUnits = view.getUint32(mvhdAt + 16, false);

  const tracks = children(head, moov.at + moov.header.headerBytes, moov.at + moov.header.size)
    .filter((c) => c.header.type === 'trak')
    .map((trak) => parseTrack(head, view, trak.at, trak.at + trak.header.size, timescale));

  return {
    timescale,
    durationSec: timescale > 0 ? durationUnits / timescale : 0,
    fastStart: mdatIndex < 0 || moovIndex < mdatIndex,
    tracks,
  };
}

function parseTrack(
  head: Uint8Array,
  view: DataView,
  trakAt: number,
  trakTo: number,
  movieTimescale: number,
): MovieTrack {
  const trakFrom = trakAt + (readBoxHeader(head, trakAt)?.headerBytes ?? 8);
  const tkhd = child(head, trakFrom, trakTo, 'tkhd');
  const tkhdAt = tkhd.at + tkhd.header.headerBytes;
  if (view.getUint8(tkhdAt) !== 0) throw new Mp4ParseError('only a version-0 tkhd is understood');
  const trackId = view.getUint32(tkhdAt + 12, false);
  const presentedMovieUnits = view.getUint32(tkhdAt + 20, false);

  const edts = optionalChild(head, trakFrom, trakTo, 'edts');
  let editMediaTime = 0;
  if (edts !== null) {
    const elst = child(head, edts.at + edts.header.headerBytes, edts.at + edts.header.size, 'elst');
    const elstAt = elst.at + elst.header.headerBytes;
    if (view.getUint8(elstAt) !== 0) throw new Mp4ParseError('only a version-0 elst is understood');
    if (view.getUint32(elstAt + 4, false) >= 1) {
      editMediaTime = Math.max(0, view.getInt32(elstAt + 12, false));
    }
  }

  const mdia = child(head, trakFrom, trakTo, 'mdia');
  const mdiaFrom = mdia.at + mdia.header.headerBytes;
  const mdiaTo = mdia.at + mdia.header.size;

  const mdhd = child(head, mdiaFrom, mdiaTo, 'mdhd');
  const mdhdAt = mdhd.at + mdhd.header.headerBytes;
  if (view.getUint8(mdhdAt) !== 0) throw new Mp4ParseError('only a version-0 mdhd is understood');
  const timescale = view.getUint32(mdhdAt + 12, false);
  const durationUnits = view.getUint32(mdhdAt + 16, false);

  const hdlr = child(head, mdiaFrom, mdiaTo, 'hdlr');
  const handler = decoder.decode(
    head.subarray(hdlr.at + hdlr.header.headerBytes + 8, hdlr.at + hdlr.header.headerBytes + 12),
  );
  if (handler !== 'vide' && handler !== 'soun') {
    throw new Mp4ParseError(`unexpected handler ${JSON.stringify(handler)}`);
  }

  const minf = child(head, mdiaFrom, mdiaTo, 'minf');
  const stbl = child(head, minf.at + minf.header.headerBytes, minf.at + minf.header.size, 'stbl');
  const stblFrom = stbl.at + stbl.header.headerBytes;
  const stblTo = stbl.at + stbl.header.size;

  const entry = parseSampleEntry(head, view, stblFrom, stblTo);
  const samples = parseSampleTables(head, view, stblFrom, stblTo);

  return {
    trackId,
    handler,
    timescale,
    durationUnits,
    durationSec: timescale > 0 ? durationUnits / timescale : 0,
    presentedSec: movieTimescale > 0 ? presentedMovieUnits / movieTimescale : 0,
    ...entry,
    editMediaTime,
    samples,
  };
}

interface SampleEntryFacts {
  sampleEntry: string;
  codecDescription: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
}

function parseSampleEntry(
  head: Uint8Array,
  view: DataView,
  stblFrom: number,
  stblTo: number,
): SampleEntryFacts {
  const stsd = child(head, stblFrom, stblTo, 'stsd');
  const entriesFrom = stsd.at + stsd.header.headerBytes + 8;
  const entry = children(head, entriesFrom, stsd.at + stsd.header.size)[0];
  if (entry === undefined) throw new Mp4ParseError('stsd has no sample entry');
  const body = entry.at + entry.header.headerBytes;
  const type = entry.header.type;

  if (type === 'avc1') {
    const avcC = optionalChild(head, body + 78, entry.at + entry.header.size, 'avcC');
    return {
      sampleEntry: type,
      codecDescription:
        avcC === null
          ? null
          : head.slice(avcC.at + avcC.header.headerBytes, avcC.at + avcC.header.size),
      width: view.getUint16(body + 24, false),
      height: view.getUint16(body + 26, false),
      sampleRate: 0,
      channels: 0,
    };
  }
  if (type === 'mp4a') {
    const esds = optionalChild(head, body + 28, entry.at + entry.header.size, 'esds');
    return {
      sampleEntry: type,
      codecDescription:
        esds === null
          ? null
          : findDescriptor(
              head.subarray(esds.at + esds.header.headerBytes + 4, esds.at + esds.header.size),
              0x05,
            ),
      width: 0,
      height: 0,
      sampleRate: view.getUint32(body + 24, false) / 0x1_0000,
      channels: view.getUint16(body + 16, false),
    };
  }
  throw new Mp4ParseError(`unsupported sample entry ${JSON.stringify(type)}`);
}

/**
 * `stts` + `stss` + `stsc` + `stsz` + `co64`/`stco` → one absolute record per sample.
 *
 * This is the reconstruction that makes the "last frame decodes" check honest: the
 * byte range it hands back is the one a player would use, arrived at the way a
 * player arrives at it, rather than the one the writer remembers using.
 */
function parseSampleTables(
  head: Uint8Array,
  view: DataView,
  stblFrom: number,
  stblTo: number,
): MovieSample[] {
  const stts = child(head, stblFrom, stblTo, 'stts');
  const sttsAt = stts.at + stts.header.headerBytes;
  const sttsCount = view.getUint32(sttsAt + 4, false);
  const durations: number[] = [];
  for (let i = 0; i < sttsCount; i++) {
    const count = view.getUint32(sttsAt + 8 + i * 8, false);
    const delta = view.getUint32(sttsAt + 12 + i * 8, false);
    for (let n = 0; n < count; n++) durations.push(delta);
  }

  const stsz = child(head, stblFrom, stblTo, 'stsz');
  const stszAt = stsz.at + stsz.header.headerBytes;
  const uniformSize = view.getUint32(stszAt + 4, false);
  const sampleCount = view.getUint32(stszAt + 8, false);
  const sizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    sizes.push(uniformSize !== 0 ? uniformSize : view.getUint32(stszAt + 12 + i * 4, false));
  }
  if (durations.length !== sampleCount) {
    throw new Mp4ParseError(
      `stts describes ${durations.length} samples but stsz declares ${sampleCount}`,
    );
  }

  const co64 = optionalChild(head, stblFrom, stblTo, 'co64');
  const stco = co64 ?? child(head, stblFrom, stblTo, 'stco');
  const chunkAt = stco.at + stco.header.headerBytes;
  const chunkCount = view.getUint32(chunkAt + 4, false);
  const chunkOffsets: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    if (co64 !== null) {
      const high = view.getUint32(chunkAt + 8 + i * 8, false);
      const low = view.getUint32(chunkAt + 12 + i * 8, false);
      const offset = high * 0x1_0000_0000 + low;
      if (!Number.isSafeInteger(offset)) throw new Mp4ParseError('co64 offset is out of range');
      chunkOffsets.push(offset);
    } else {
      chunkOffsets.push(view.getUint32(chunkAt + 8 + i * 4, false));
    }
  }

  const stsc = child(head, stblFrom, stblTo, 'stsc');
  const stscAt = stsc.at + stsc.header.headerBytes;
  const stscCount = view.getUint32(stscAt + 4, false);
  const runs: { firstChunk: number; perChunk: number }[] = [];
  for (let i = 0; i < stscCount; i++) {
    runs.push({
      firstChunk: view.getUint32(stscAt + 8 + i * 12, false),
      perChunk: view.getUint32(stscAt + 12 + i * 12, false),
    });
  }

  const stss = optionalChild(head, stblFrom, stblTo, 'stss');
  const sync = new Set<number>();
  if (stss !== null) {
    const at = stss.at + stss.header.headerBytes;
    const count = view.getUint32(at + 4, false);
    for (let i = 0; i < count; i++) sync.add(view.getUint32(at + 8 + i * 4, false));
  }

  const samples: MovieSample[] = [];
  let index = 0;
  let decodeUnits = 0;
  for (const [chunkIndex, chunkOffset] of chunkOffsets.entries()) {
    // The last `stsc` entry whose `first_chunk` is at or before this one governs it.
    const run = runs.filter((r) => r.firstChunk <= chunkIndex + 1).at(-1);
    if (run === undefined) throw new Mp4ParseError('stsc does not cover chunk 1');
    let offset = chunkOffset;
    for (let n = 0; n < run.perChunk; n++) {
      const byteLength = sizes[index];
      const durationUnits = durations[index];
      if (byteLength === undefined || durationUnits === undefined) {
        throw new Mp4ParseError('stsc places more samples in chunks than stsz declares');
      }
      samples.push({
        index,
        offset,
        byteLength,
        decodeUnits,
        durationUnits,
        // No `stss` means every sample is a sync sample (ISO 14496-12 §8.6.2).
        isSync: stss === null || sync.has(index + 1),
      });
      offset += byteLength;
      decodeUnits += durationUnits;
      index += 1;
    }
  }
  if (index !== sampleCount) {
    throw new Mp4ParseError(`the chunk tables place ${index} of ${sampleCount} samples`);
  }
  return samples;
}

/**
 * Walk MPEG-4 descriptors to a tag. A trimmed copy of `scan.ts`'s walker, kept here
 * rather than exported from there because `scan.ts` owns the *fragmented* reader and
 * this file owns the finished-movie one; the two share the format, not a module.
 */
function findDescriptor(bytes: Uint8Array, tag: number): Uint8Array | null {
  let at = 0;
  while (at + 2 <= bytes.byteLength) {
    const found = bytes[at];
    at += 1;
    let size = 0;
    for (let i = 0; i < 4 && at < bytes.byteLength; i++) {
      const byte = bytes[at] ?? 0;
      at += 1;
      size = (size << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    if (at + size > bytes.byteLength) return null;
    const payload = bytes.subarray(at, at + size);
    if (found === tag) return payload.slice();
    if (found === 0x03) {
      const nested = findDescriptor(payload.subarray(3), tag);
      if (nested !== null) return nested;
    } else if (found === 0x04) {
      const nested = findDescriptor(payload.subarray(13), tag);
      if (nested !== null) return nested;
    }
    at += size;
  }
  return null;
}
