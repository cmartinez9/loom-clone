/**
 * ISO base media file format box construction.
 *
 * Nothing here knows about capture, files or time; it turns numbers into boxes.
 * Every box is built as `size | type | payload`, which is the only structural rule
 * the format has, so the builders below are deliberately literal — an fMP4 writer
 * that is clever about box layout is a writer nobody can debug against a hex dump.
 *
 * Field-by-field references are to ISO/IEC 14496-12 (ISO BMFF) and 14496-15
 * (AVC in ISO BMFF). Where a field has no meaning for us it is written as the
 * specified default rather than omitted, because a missing field is a different
 * file, not a smaller one.
 */

const encoder = new TextEncoder();

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export function u8(...values: readonly number[]): Uint8Array {
  return Uint8Array.from(values, (v) => v & 0xff);
}

export function u16(value: number): Uint8Array {
  return u8(value >>> 8, value);
}

export function i16(value: number): Uint8Array {
  return u16(value < 0 ? value + 0x1_0000 : value);
}

export function u32(value: number): Uint8Array {
  return u8(value >>> 24, value >>> 16, value >>> 8, value);
}

export function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

/**
 * 64-bit big-endian, written from a JS number.
 *
 * `tfdt`'s `baseMediaDecodeTime` is the only 64-bit field we write. At a
 * microsecond timescale it stays inside `Number.MAX_SAFE_INTEGER` for 285 years
 * of recording, so the split is exact; it is asserted rather than assumed.
 */
export function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`u64 out of range: ${String(value)}`);
  }
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value - high * 0x1_0000_0000;
  return concat([u32(high), u32(low)]);
}

export function fourcc(type: string): Uint8Array {
  if (type.length !== 4) throw new RangeError(`box type must be four characters: ${type}`);
  return encoder.encode(type);
}

export function bytes(...values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** `size | type | payload`. */
export function box(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.byteLength + 8), fourcc(type), body]);
}

/** A box whose first four payload bytes are `version | flags`. */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payload: readonly Uint8Array[]
): Uint8Array {
  return box(type, u8(version, flags >>> 16, flags >>> 8, flags), ...payload);
}

/** The 3x3 unity transformation matrix every `tkhd`/`mvhd` carries. */
const UNITY_MATRIX = concat([
  u32(0x0001_0000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x0001_0000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x4000_0000),
]);

const ZERO = (count: number): Uint8Array => new Uint8Array(count);

/** 16.16 fixed point, as `tkhd` stores display width and height. */
function fixed16_16(value: number): Uint8Array {
  return u32(Math.round(value * 0x1_0000));
}

export const MOVIE_TIMESCALE = 1000;

/** Colour description, written into the sample entry as an `nclx` `colr` box. */
export interface ColourDescription {
  /** ISO/IEC 23001-8 colour primaries. 1 = BT.709. */
  primaries: number;
  /** Transfer characteristics. 13 = IEC 61966-2-1 (sRGB). */
  transfer: number;
  /** Matrix coefficients. 1 = BT.709. */
  matrix: number;
  fullRange: boolean;
}

export interface InitSegmentSpec {
  /** Coded width in pixels. */
  width: number;
  /** Coded height in pixels. */
  height: number;
  /** Units per second on the media timeline. Capture uses 1_000_000. */
  timescale: number;
  /** The `avcC` record, verbatim from `VideoDecoderConfig.description`. */
  avcC: Uint8Array;
  colour?: ColourDescription;
}

/** `ftyp` — fragmented-MP4 brands. `iso5` is the floor for `default_base_is_moof`. */
export function ftyp(): Uint8Array {
  return box(
    'ftyp',
    fourcc('iso5'),
    u32(512),
    fourcc('isom'),
    fourcc('iso2'),
    fourcc('iso5'),
    fourcc('iso6'),
    fourcc('avc1'),
    fourcc('mp41'),
  );
}

function avcSampleEntry(spec: InitSegmentSpec): Uint8Array {
  // 32-byte fixed-length Pascal string. The name is cosmetic; the length byte is not.
  const compressorName = new Uint8Array(32);
  const label = encoder.encode('Loom H.264');
  compressorName[0] = label.byteLength;
  compressorName.set(label, 1);

  const extensions: Uint8Array[] = [box('avcC', spec.avcC)];
  if (spec.colour !== undefined) {
    extensions.push(
      box(
        'colr',
        fourcc('nclx'),
        u16(spec.colour.primaries),
        u16(spec.colour.transfer),
        u16(spec.colour.matrix),
        u8(spec.colour.fullRange ? 0x80 : 0x00),
      ),
    );
  }

  return box(
    'avc1',
    ZERO(6), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    ZERO(12), // pre_defined[3]
    u16(spec.width),
    u16(spec.height),
    u32(0x0048_0000), // horizresolution, 72 dpi
    u32(0x0048_0000), // vertresolution, 72 dpi
    u32(0), // reserved
    u16(1), // frame_count
    compressorName,
    u16(0x0018), // depth
    i16(-1), // pre_defined
    ...extensions,
  );
}

/**
 * `ftyp` + `moov` — the initialisation segment.
 *
 * The `moov` is an **empty moov**: its sample tables are present and empty, and a
 * `mvex` declares that samples arrive in fragments instead. That is what makes the
 * file readable the instant it is created, rather than only after a `moov` is
 * written at the end — which is the difference the architecture report measured
 * between "723 of 1200 frames" and "total loss" (§12.2).
 */
export function initSegment(spec: InitSegmentSpec): Uint8Array {
  const trak = box(
    'trak',
    fullBox(
      'tkhd',
      0,
      0x0000_07, // enabled | in movie | in preview
      u32(0), // creation_time
      u32(0), // modification_time
      u32(1), // track_ID
      u32(0), // reserved
      u32(0), // duration — unknown while fragments are still arriving
      ZERO(8), // reserved
      u16(0), // layer
      u16(0), // alternate_group
      u16(0), // volume (0 for video)
      u16(0), // reserved
      UNITY_MATRIX,
      fixed16_16(spec.width),
      fixed16_16(spec.height),
    ),
    box(
      'mdia',
      fullBox(
        'mdhd',
        0,
        0,
        u32(0), // creation_time
        u32(0), // modification_time
        u32(spec.timescale),
        u32(0), // duration
        u16(0x55c4), // language: 'und'
        u16(0), // pre_defined
      ),
      fullBox(
        'hdlr',
        0,
        0,
        u32(0), // pre_defined
        fourcc('vide'),
        ZERO(12), // reserved
        encoder.encode('VideoHandler\0'),
      ),
      box(
        'minf',
        fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        box(
          'stbl',
          fullBox('stsd', 0, 0, u32(1), avcSampleEntry(spec)),
          fullBox('stts', 0, 0, u32(0)),
          fullBox('stsc', 0, 0, u32(0)),
          fullBox('stsz', 0, 0, u32(0), u32(0)),
          fullBox('stco', 0, 0, u32(0)),
        ),
      ),
    ),
  );

  const moov = box(
    'moov',
    fullBox(
      'mvhd',
      0,
      0,
      u32(0), // creation_time
      u32(0), // modification_time
      u32(MOVIE_TIMESCALE),
      u32(0), // duration
      u32(0x0001_0000), // rate 1.0
      u16(0x0100), // volume 1.0
      u16(0), // reserved
      ZERO(8), // reserved
      UNITY_MATRIX,
      ZERO(24), // pre_defined
      u32(2), // next_track_ID
    ),
    trak,
    box(
      'mvex',
      fullBox(
        'trex',
        0,
        0,
        u32(1), // track_ID
        u32(1), // default_sample_description_index
        u32(0), // default_sample_duration
        u32(0), // default_sample_size
        u32(0), // default_sample_flags
      ),
    ),
  );

  return concat([ftyp(), moov]);
}

/**
 * `sample_flags` for a sync sample: `sample_depends_on = 2` ("does not depend on
 * others"), `sample_is_non_sync_sample = 0`.
 */
export const SAMPLE_FLAGS_SYNC = 0x0200_0000;

/** `sample_depends_on = 1` ("depends on others"), `sample_is_non_sync_sample = 1`. */
export const SAMPLE_FLAGS_DELTA = 0x0101_0000;

export interface FragmentSpec {
  /** `mfhd.sequence_number`, 1-based and strictly increasing. */
  sequenceNumber: number;
  /** `tfdt.baseMediaDecodeTime`, in media timescale units. */
  baseMediaDecodeTime: number;
  /** Duration of the sample, in media timescale units. */
  durationUnits: number;
  isKey: boolean;
  /** The encoded sample, AVCC framed (4-byte length prefixes). */
  data: Uint8Array;
}

/**
 * One `moof` + `mdat` pair carrying exactly one sample.
 *
 * **One sample per fragment is the crash-safety decision.** A `SIGKILL` costs
 * whatever the writing process still held in memory, so the loss window is the
 * fragment being assembled; making a fragment one frame makes that window one
 * frame instead of the report's "≤ 1 s" upper bound (§7.1). The cost is the
 * `moof` header on every frame — about 100 bytes against a ~50 KB frame at
 * 12 Mbps, so roughly 0.2% of the file. That is the same layout CMAF low-latency
 * chunks use, so it is well-trodden rather than novel.
 *
 * Keyframe cadence is a *separate* knob and stays at one per second (§7.1), which
 * is what the editor seeks against.
 */
export function fragment(spec: FragmentSpec): Uint8Array {
  const flags = spec.isKey ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_DELTA;

  const mfhd = fullBox('mfhd', 0, 0, u32(spec.sequenceNumber));
  const tfhd = fullBox(
    'tfhd',
    0,
    // default-sample-duration | default-sample-size | default-sample-flags |
    // default-base-is-moof. The last one is why `ftyp` claims `iso5`: it makes
    // `trun.data_offset` relative to this `moof`, so a fragment is positionally
    // self-contained and a scanner never has to know where the file began.
    0x02_0038,
    u32(1), // track_ID
    u32(spec.durationUnits),
    u32(spec.data.byteLength),
    u32(flags),
  );
  const tfdt = fullBox('tfdt', 1, 0, u64(spec.baseMediaDecodeTime));
  const trun = fullBox(
    'trun',
    0,
    0x00_0001, // data-offset-present
    u32(1), // sample_count
    i32(0), // data_offset — patched below, once the moof size is known
  );

  const moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun));

  // `data_offset` is the last four bytes of `trun`, which is the last box in the
  // `moof`. Patching it in place beats guessing the size in advance.
  const dataOffsetAt = moof.byteLength - 4;
  const mdatHeaderBytes = 8;
  new DataView(moof.buffer, moof.byteOffset).setInt32(
    dataOffsetAt,
    moof.byteLength + mdatHeaderBytes,
    false,
  );

  return concat([moof, box('mdat', spec.data)]);
}
