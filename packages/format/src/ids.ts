/**
 * ULIDs. The architecture report's example ids (`01K1Y7QZ8N3M4P5R6S7T8V9W0X`,
 * §2.2) are ULIDs, so that is what a `RecordingId` is.
 *
 * Implemented here rather than taken as a dependency: it is forty lines, it must
 * work identically in main and in tests, and a lexicographically sortable id is
 * load-bearing for the library list (sort by id == sort by creation time).
 *
 * Uses `crypto.getRandomValues`, which exists in Node ≥ 19 and in every renderer.
 * This module must stay free of `node:` imports so it can be used on both sides.
 */

// Crockford base32, minus I, L, O and U so a ULID cannot be misread aloud.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 281474976710655; // 2^48 - 1

/** A ULID is 26 Crockford-base32 characters. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** One Crockford character. `charAt` returns `''` out of range, never undefined. */
function charAt(index: number): string {
  return ENCODING.charAt(index);
}

function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${String(now)}`);
  }
  let out = '';
  let remaining = now;
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = remaining % ENCODING_LEN;
    out = charAt(mod) + out;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    // Each byte contributes one base32 character. Taking the low 5 bits discards
    // 3 bits per character, leaving 80 bits of entropy — the ULID spec's own
    // amount, and far more than a per-machine recording list will ever need.
    out += charAt((bytes[i] ?? 0) & 0x1f);
  }
  return out;
}

/**
 * A new ULID. Monotonic within a millisecond is *not* guaranteed; two recordings
 * created in the same millisecond is not a case this app has.
 *
 * @param epochMs Injectable for tests. Defaults to `Date.now()`.
 */
export function ulid(epochMs: number = Date.now()): string {
  return encodeTime(epochMs) + encodeRandom();
}

/** The creation time encoded in a ULID, as epoch milliseconds. */
export function ulidTime(id: string): number {
  if (!ULID_PATTERN.test(id)) throw new TypeError(`not a ULID: ${id}`);
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    // `charAt` is total: it returns '' rather than undefined out of range, and
    // the pattern above already guarantees 26 characters from the alphabet.
    time = time * ENCODING_LEN + ENCODING.indexOf(id.charAt(i));
  }
  return time;
}
