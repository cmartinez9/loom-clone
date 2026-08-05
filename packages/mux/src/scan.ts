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

/** The largest a box header can be: 16 bytes, when it carries a `largesize`. */
export const MAX_BOX_HEADER_BYTES = 16;

/** The smallest a box header can be, and all this writer ever emits. */
export const MIN_BOX_HEADER_BYTES = 8;

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
  const { entriesFrom, to, timescale } = findSampleDescription(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entry = children(bytes, entriesFrom, to)[0];
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

export interface AudioInitSegmentFacts {
  /** Units per second on the media timeline, which for audio is the sample rate. */
  timescale: number;
  sampleRate: number;
  channels: number;
  /** The AudioSpecificConfig from `esds`, verbatim. */
  audioSpecificConfig: Uint8Array;
  /**
   * Samples the edit list says to skip — the encoder's priming.
   *
   * A reader that decodes raw chunks rather than handing the file to a demuxer
   * (which is what `packages/decode` and the exporter will do) has to apply this
   * itself: the trim lives in the container, and pulling the samples out from
   * under it loses the trim with it.
   */
  encoderDelaySamples: number;
}

/** Sampling frequencies an AudioSpecificConfig can name by index (ISO 14496-3). */
const ASC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Channel counts an AudioSpecificConfig can name by configuration (ISO 14496-3). */
const ASC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

/**
 * Walk MPEG-4 descriptors, which carry their length in one to four bytes with the
 * top bit as a continuation flag. Both forms are legal and both are in the wild.
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
    if (found === tag) return payload;
    // Descend into the two container descriptors on the path to the codec config,
    // rather than assuming a fixed layout that a different muxer would break.
    if (found === 0x03) {
      // ES_Descriptor: ES_ID (2) + flags (1), then nested descriptors.
      const nested = findDescriptor(payload.subarray(3), tag);
      if (nested !== null) return nested;
    } else if (found === 0x04) {
      // DecoderConfigDescriptor: 13 bytes of fields, then DecoderSpecificInfo.
      const nested = findDescriptor(payload.subarray(13), tag);
      if (nested !== null) return nested;
    }
    at += size;
  }
  return null;
}

/** Object type, rate and channel count, read out of an AudioSpecificConfig. */
export function parseAudioSpecificConfig(asc: Uint8Array): {
  objectType: number;
  sampleRate: number;
  channels: number;
} {
  if (asc.byteLength < 2) throw new Mp4ParseError('AudioSpecificConfig is too short');
  const first = asc[0] ?? 0;
  const second = asc[1] ?? 0;
  const objectType = first >>> 3;
  if (objectType === 31) throw new Mp4ParseError('escaped AAC object types are not supported');
  const frequencyIndex = ((first & 0x07) << 1) | (second >>> 7);
  const channelConfig = (second >>> 3) & 0x0f;
  if (frequencyIndex === 0x0f) {
    if (asc.byteLength < 5) throw new Mp4ParseError('AudioSpecificConfig declares no sample rate');
    const rate =
      (((asc[1] ?? 0) & 0x7f) << 17) |
      ((asc[2] ?? 0) << 9) |
      ((asc[3] ?? 0) << 1) |
      ((asc[4] ?? 0) >>> 7);
    return { objectType, sampleRate: rate, channels: ((asc[4] ?? 0) >>> 3) & 0x0f };
  }
  return {
    objectType,
    sampleRate: ASC_SAMPLE_RATES[frequencyIndex] ?? 0,
    channels: ASC_CHANNELS[channelConfig] ?? channelConfig,
  };
}

/** `mp4a.40.2` — the codec string `recording.json` and `AudioDecoder` both want. */
export function codecStringFromAsc(asc: Uint8Array): string {
  return `mp4a.40.${parseAudioSpecificConfig(asc).objectType}`;
}

/**
 * The `elst` media time of the file's single track, in media timescale units, or
 * `0` when there is no edit list.
 */
function editListMediaTime(bytes: Uint8Array): number {
  const top = children(bytes, 0, bytes.byteLength);
  const moov = top.find((c) => c.header.type === 'moov');
  if (moov === undefined) return 0;
  const trak = findChild(
    bytes,
    moov.at + moov.header.headerBytes,
    moov.at + moov.header.size,
    'trak',
  );
  if (trak === null) return 0;
  const edts = findChild(
    bytes,
    trak.at + trak.header.headerBytes,
    trak.at + trak.header.size,
    'edts',
  );
  if (edts === null) return 0;
  const elst = findChild(
    bytes,
    edts.at + edts.header.headerBytes,
    edts.at + edts.header.size,
    'elst',
  );
  if (elst === null) return 0;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = elst.at + elst.header.headerBytes;
  const version = view.getUint8(at);
  if (view.getUint32(at + 4, false) < 1) return 0;
  // v0: segment_duration u32 then media_time i32; v1 widens both to 64 bits.
  const mediaTime =
    version === 1
      ? view.getUint32(at + 16, false) * 0x1_0000_0000 + view.getUint32(at + 20, false)
      : view.getInt32(at + 12, false);
  return mediaTime > 0 ? mediaTime : 0;
}

/** Read back the facts {@link audioInitSegment} wrote, for crash recovery. */
export function parseAudioInitSegment(bytes: Uint8Array): AudioInitSegmentFacts {
  const stsd = findSampleDescription(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entry = children(bytes, stsd.entriesFrom, stsd.to)[0];
  if (entry === undefined) throw new Mp4ParseError('stsd has no sample entry');
  const body = entry.at + entry.header.headerBytes;
  const channels = view.getUint16(body + 16, false);
  const sampleRate = view.getUint32(body + 24, false) / 0x1_0000;

  // Sample-entry extensions begin after the 28-byte AudioSampleEntry body.
  const esds = findChild(bytes, body + 28, entry.at + entry.header.size, 'esds');
  if (esds === null) throw new Mp4ParseError('audio sample entry has no esds');
  const asc = findDescriptor(
    bytes.subarray(esds.at + esds.header.headerBytes + 4, esds.at + esds.header.size),
    0x05,
  );
  if (asc === null) throw new Mp4ParseError('esds carries no AudioSpecificConfig');

  const declared = parseAudioSpecificConfig(asc);
  return {
    encoderDelaySamples: editListMediaTime(bytes),
    timescale: stsd.timescale,
    // The AudioSpecificConfig is the authority; the sample entry's 16.16 rate
    // cannot even represent every rate a device might report.
    sampleRate: declared.sampleRate > 0 ? declared.sampleRate : sampleRate,
    channels: declared.channels > 0 ? declared.channels : channels,
    audioSpecificConfig: asc.slice(),
  };
}

/** The `stsd` of the file's single track, plus its media timescale. */
function findSampleDescription(bytes: Uint8Array): {
  entriesFrom: number;
  to: number;
  timescale: number;
} {
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
  return {
    entriesFrom: stsd.at + stsd.header.headerBytes + 8,
    to: stsd.at + stsd.header.size,
    timescale,
  };
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
