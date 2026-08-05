/**
 * Reading back what {@link ./boxes.ts | the writer} produced — the parsing half of
 * crash recovery.
 *
 * A capture file is `ftyp | moov | (moof mdat)*`. A process killed mid-recording
 * leaves that sequence intact up to some byte and then, at most, a partial box.
 * Recovery is therefore: walk the pairs, stop at the first one that is not wholly
 * present, and treat everything before it as the recording. This module is the
 * pure part of that — it knows nothing about files, so it can be tested against
 * bytes and reused by a reader that seeks rather than one that streams.
 *
 * Architecture report §7.1 rebuilds `recording.json` "from the frame indices,
 * which main wrote incrementally". We go one better and rebuild the index from the
 * media file itself: `tfdt` carries each fragment's exact decode time, `tfhd`
 * carries its sample's size and sync flag, and the `mdat` position gives the byte
 * offset — so the sidecar is derivable from the bytes that were written as chunks
 * arrived, rather than from a checkpoint that may be stale. Anything the file does
 * not contain is not guessed at.
 */

const decoder = new TextDecoder('latin1');

export interface BoxHeader {
  type: string;
  /** Total box size in bytes, header included. */
  size: number;
  /** 8 for a 32-bit size, 16 for a 64-bit `largesize`. */
  headerBytes: number;
}

/** The smallest number of bytes from which a header can possibly be read. */
export const MAX_BOX_HEADER_BYTES = 16;

/**
 * Read a box header, or return `null` if `bytes` does not hold a whole one.
 *
 * A declared size smaller than its own header, or a `size === 0` ("extends to end
 * of file") box, is refused rather than interpreted: both mean the tail is
 * untrustworthy, and this function is only ever used on a file we already suspect
 * was cut short.
 */
export function readBoxHeader(bytes: Uint8Array, offset = 0): BoxHeader | null {
  if (offset + 8 > bytes.byteLength) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(offset, false);
  const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));

  if (declared === 1) {
    if (offset + 16 > bytes.byteLength) return null;
    const high = view.getUint32(offset + 8, false);
    const low = view.getUint32(offset + 12, false);
    const size = high * 0x1_0000_0000 + low;
    if (!Number.isSafeInteger(size) || size < 16) return null;
    return { type, size, headerBytes: 16 };
  }
  if (declared < 8) return null;
  return { type, size: declared, headerBytes: 8 };
}

export interface FragmentSample {
  /** Bytes of encoded data. */
  sizeBytes: number;
  /** Duration in media timescale units. */
  durationUnits: number;
  isKey: boolean;
}

export interface ParsedFragment {
  sequenceNumber: number;
  /** `tfdt.baseMediaDecodeTime`, in media timescale units. */
  baseMediaDecodeTime: number;
  samples: FragmentSample[];
}

export class Mp4ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp4ParseError';
  }
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

function findChild(
  bytes: Uint8Array,
  from: number,
  to: number,
  type: string,
): { header: BoxHeader; at: number } | null {
  return children(bytes, from, to).find((c) => c.header.type === type) ?? null;
}

/**
 * Parse one complete `moof`.
 *
 * Only the subset the capture writer emits is understood: a single `traf` whose
 * `tfhd` carries default duration, size and flags, and whose `trun` carries a
 * sample count. Anything richer — per-sample tables, composition offsets, several
 * tracks — throws rather than being half-read, because a fragment we cannot fully
 * account for must not contribute frames to a recovered index.
 */
export function parseMoof(moof: Uint8Array): ParsedFragment {
  const header = readBoxHeader(moof, 0);
  if (header?.type !== 'moof' || header.size !== moof.byteLength) {
    throw new Mp4ParseError('not a complete moof box');
  }
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);

  const mfhd = findChild(moof, header.headerBytes, moof.byteLength, 'mfhd');
  if (mfhd === null) throw new Mp4ParseError('moof has no mfhd');
  const sequenceNumber = view.getUint32(mfhd.at + mfhd.header.headerBytes + 4, false);

  const traf = findChild(moof, header.headerBytes, moof.byteLength, 'traf');
  if (traf === null) throw new Mp4ParseError('moof has no traf');
  const trafFrom = traf.at + traf.header.headerBytes;
  const trafTo = traf.at + traf.header.size;

  const tfhd = findChild(moof, trafFrom, trafTo, 'tfhd');
  if (tfhd === null) throw new Mp4ParseError('traf has no tfhd');
  let at = tfhd.at + tfhd.header.headerBytes;
  const tfhdFlags = view.getUint32(at, false) & 0x00ff_ffff;
  at += 4;
  at += 4; // track_ID
  if ((tfhdFlags & 0x00_0001) !== 0) at += 8; // base_data_offset
  if ((tfhdFlags & 0x00_0002) !== 0) at += 4; // sample_description_index
  const defaultDuration = (tfhdFlags & 0x00_0008) !== 0 ? view.getUint32(at, false) : null;
  if (defaultDuration !== null) at += 4;
  const defaultSize = (tfhdFlags & 0x00_0010) !== 0 ? view.getUint32(at, false) : null;
  if (defaultSize !== null) at += 4;
  const defaultFlags = (tfhdFlags & 0x00_0020) !== 0 ? view.getUint32(at, false) : null;

  const tfdt = findChild(moof, trafFrom, trafTo, 'tfdt');
  if (tfdt === null) throw new Mp4ParseError('traf has no tfdt');
  const tfdtAt = tfdt.at + tfdt.header.headerBytes;
  const tfdtVersion = view.getUint8(tfdtAt);
  const baseMediaDecodeTime =
    tfdtVersion === 1
      ? view.getUint32(tfdtAt + 4, false) * 0x1_0000_0000 + view.getUint32(tfdtAt + 8, false)
      : view.getUint32(tfdtAt + 4, false);
  if (!Number.isSafeInteger(baseMediaDecodeTime)) {
    throw new Mp4ParseError('tfdt baseMediaDecodeTime is not exactly representable');
  }

  const trun = findChild(moof, trafFrom, trafTo, 'trun');
  if (trun === null) throw new Mp4ParseError('traf has no trun');
  let runAt = trun.at + trun.header.headerBytes;
  const trunFlags = view.getUint32(runAt, false) & 0x00ff_ffff;
  runAt += 4;
  const sampleCount = view.getUint32(runAt, false);
  runAt += 4;
  if ((trunFlags & 0x00_0001) !== 0) runAt += 4; // data_offset
  const firstSampleFlags = (trunFlags & 0x00_0004) !== 0 ? view.getUint32(runAt, false) : null;
  if (firstSampleFlags !== null) runAt += 4;

  const perSampleDuration = (trunFlags & 0x00_0100) !== 0;
  const perSampleSize = (trunFlags & 0x00_0200) !== 0;
  const perSampleFlags = (trunFlags & 0x00_0400) !== 0;
  const perSampleCts = (trunFlags & 0x00_0800) !== 0;

  const samples: FragmentSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    let duration = defaultDuration;
    let size = defaultSize;
    let flags = i === 0 && firstSampleFlags !== null ? firstSampleFlags : defaultFlags;
    if (perSampleDuration) {
      duration = view.getUint32(runAt, false);
      runAt += 4;
    }
    if (perSampleSize) {
      size = view.getUint32(runAt, false);
      runAt += 4;
    }
    if (perSampleFlags) {
      flags = view.getUint32(runAt, false);
      runAt += 4;
    }
    if (perSampleCts) {
      // The capture encoder runs with no B-frames, so a composition offset means
      // this file did not come from our writer and its presentation times cannot
      // be reconstructed from `tfdt` alone.
      throw new Mp4ParseError('composition time offsets are not supported');
    }
    if (duration === null || size === null || flags === null) {
      throw new Mp4ParseError('fragment sample has no duration, size or flags');
    }
    samples.push({ sizeBytes: size, durationUnits: duration, isKey: (flags & 0x0001_0000) === 0 });
  }
  if (runAt > trun.at + trun.header.size) {
    throw new Mp4ParseError('trun declares more samples than it contains');
  }
  return { sequenceNumber, baseMediaDecodeTime, samples };
}

export interface InitSegmentFacts {
  /** Units per second on the media timeline. */
  timescale: number;
  width: number;
  height: number;
  /** The `avcC` record, verbatim. */
  avcC: Uint8Array;
}

/** Read back the facts {@link initSegment} wrote, for rebuilding `recording.json`. */
export function parseInitSegment(bytes: Uint8Array): InitSegmentFacts {
  const top = children(bytes, 0, bytes.byteLength);
  const moov = top.find((c) => c.header.type === 'moov');
  if (moov === undefined) throw new Mp4ParseError('no complete moov box');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const trak = findChild(
    bytes,
    moov.at + moov.header.headerBytes,
    moov.at + moov.header.size,
    'trak',
  );
  if (trak === null) throw new Mp4ParseError('moov has no trak');
  const mdia = findChild(
    bytes,
    trak.at + trak.header.headerBytes,
    trak.at + trak.header.size,
    'mdia',
  );
  if (mdia === null) throw new Mp4ParseError('trak has no mdia');
  const mdhd = findChild(
    bytes,
    mdia.at + mdia.header.headerBytes,
    mdia.at + mdia.header.size,
    'mdhd',
  );
  if (mdhd === null) throw new Mp4ParseError('mdia has no mdhd');
  const mdhdAt = mdhd.at + mdhd.header.headerBytes;
  const timescale =
    view.getUint8(mdhdAt) === 1
      ? view.getUint32(mdhdAt + 20, false)
      : view.getUint32(mdhdAt + 12, false);

  const minf = findChild(
    bytes,
    mdia.at + mdia.header.headerBytes,
    mdia.at + mdia.header.size,
    'minf',
  );
  if (minf === null) throw new Mp4ParseError('mdia has no minf');
  const stbl = findChild(
    bytes,
    minf.at + minf.header.headerBytes,
    minf.at + minf.header.size,
    'stbl',
  );
  if (stbl === null) throw new Mp4ParseError('minf has no stbl');
  const stsd = findChild(
    bytes,
    stbl.at + stbl.header.headerBytes,
    stbl.at + stbl.header.size,
    'stsd',
  );
  if (stsd === null) throw new Mp4ParseError('stbl has no stsd');

  // stsd: version/flags (4) + entry_count (4), then the sample entries.
  const entriesFrom = stsd.at + stsd.header.headerBytes + 8;
  const entry = children(bytes, entriesFrom, stsd.at + stsd.header.size)[0];
  if (entry === undefined) throw new Mp4ParseError('stsd has no sample entry');
  const width = view.getUint16(entry.at + entry.header.headerBytes + 24, false);
  const height = view.getUint16(entry.at + entry.header.headerBytes + 26, false);

  // Sample-entry extensions begin after the 78-byte VisualSampleEntry body.
  const avcCBox = findChild(
    bytes,
    entry.at + entry.header.headerBytes + 78,
    entry.at + entry.header.size,
    'avcC',
  );
  if (avcCBox === null) throw new Mp4ParseError('sample entry has no avcC');
  const avcC = bytes.slice(
    avcCBox.at + avcCBox.header.headerBytes,
    avcCBox.at + avcCBox.header.size,
  );

  return { timescale, width, height, avcC };
}

/**
 * `avc1.PPCCLL` — the codec string `recording.json` and `VideoDecoder` both want,
 * read off the `avcC` record's profile, constraint and level bytes.
 */
export function codecStringFromAvcC(avcC: Uint8Array): string {
  if (avcC.byteLength < 4) throw new Mp4ParseError('avcC record is too short to name a codec');
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1] ?? 0)}${hex(avcC[2] ?? 0)}${hex(avcC[3] ?? 0)}`;
}
