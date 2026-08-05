/**
 * A seeded generator of **real** random op sequences.
 *
 * Phase 7's first gate (report §8) is: *"Property test: `resolve()` after a random
 * op sequence == `resolve()` after save+reload+replay."* The brief is explicit that
 * the sequences must be generated rather than hand-picked, and this is the
 * generator. It is deterministic given a seed, so a failure is reproducible from
 * the number printed in the message.
 *
 * ## What it deliberately does
 *
 * - **Emits only ops that keep the document valid.** Main refuses to journal an op
 *   batch whose result fails `validateEditDocument`, so a generator that produced
 *   invalid documents would be exercising a path the app cannot reach. The gate
 *   asserts validity after every op, which is also how a generator bug shows up as
 *   a test failure rather than as a quietly narrower corpus.
 * - **Never mixes spring and curve easings within a channel.** §3.4 makes that a
 *   validation error; a channel picks its kind when it is created and keeps it.
 * - **Uses awkward numbers.** Keyframe times carry six decimals, values are not
 *   round, and clip speeds are not 1 — so a "save" that rounds, truncates or
 *   defaults anything has something to be caught losing.
 */

import type { Clip, EditDocument, EditOp, Ease, Keyframe, Track } from '@loom/format';

/**
 * mulberry32 — small, fast, and identical on every machine.
 *
 * `Math.random()` would make a failure unreproducible, which is the one thing a
 * property test must not be.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = seededRandom(seed);
  }
  float(low: number, high: number): number {
    return low + this.next() * (high - low);
  }
  /** Six decimals: fine enough that a two-decimal "save" loses something. */
  time(low: number, high: number): number {
    return Math.round(this.float(low, high) * 1e6) / 1e6;
  }
  int(lowInclusive: number, highExclusive: number): number {
    return lowInclusive + Math.floor(this.next() * (highExclusive - lowInclusive));
  }
  pick<T>(items: readonly T[]): T {
    const chosen = items[this.int(0, items.length)];
    if (chosen === undefined) throw new Error('pick from an empty list');
    return chosen;
  }
  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }
}

/** The recording these documents describe. Long enough for several trims. */
export const CORPUS_DURATION_SEC = 240;

interface ChannelPlan {
  name: string;
  width: 1 | 2;
  kind: 'curve' | 'spring';
}

interface TrackPlan {
  target: string;
  kind: Track['kind'];
  channels: ChannelPlan[];
  spans: boolean;
}

const TRACK_PLANS: readonly TrackPlan[] = [
  {
    target: 'zoom',
    kind: 'transform',
    channels: [
      { name: 'amount', width: 1, kind: 'curve' },
      { name: 'center', width: 2, kind: 'curve' },
    ],
    spans: false,
  },
  {
    target: 'zoom',
    kind: 'transform',
    channels: [
      { name: 'amount', width: 1, kind: 'spring' },
      { name: 'center', width: 2, kind: 'spring' },
    ],
    spans: false,
  },
  {
    target: 'bubble',
    kind: 'transform',
    channels: [
      { name: 'center', width: 2, kind: 'curve' },
      { name: 'sizeY', width: 1, kind: 'curve' },
      { name: 'aspect', width: 1, kind: 'curve' },
      { name: 'corner01', width: 1, kind: 'curve' },
      { name: 'opacity', width: 1, kind: 'curve' },
      { name: 'mirror', width: 1, kind: 'curve' },
    ],
    spans: false,
  },
  {
    target: 'cursor',
    kind: 'transform',
    channels: [
      { name: 'scale', width: 1, kind: 'curve' },
      { name: 'opacity', width: 1, kind: 'curve' },
    ],
    spans: false,
  },
  {
    target: 'annotation',
    kind: 'object',
    channels: [],
    spans: true,
  },
  {
    target: 'audio:mic',
    kind: 'audio',
    channels: [{ name: 'gainDb', width: 1, kind: 'curve' }],
    spans: true,
  },
  {
    target: 'audio:system',
    kind: 'audio',
    channels: [{ name: 'gainDb', width: 1, kind: 'spring' }],
    spans: true,
  },
];

const CURVE_EASES: readonly Ease['kind'][] = ['hold', 'linear', 'cubic'];

function makeEase(rng: Rng, kind: 'curve' | 'spring'): Ease {
  if (kind === 'spring') return { kind: 'spring' };
  const chosen = rng.pick(CURVE_EASES);
  if (chosen === 'cubic') {
    return {
      kind: 'cubic',
      p1: [
        Math.round(rng.float(0, 1) * 1000) / 1000,
        Math.round(rng.float(-0.3, 1.3) * 1000) / 1000,
      ],
      p2: [
        Math.round(rng.float(0, 1) * 1000) / 1000,
        Math.round(rng.float(-0.3, 1.3) * 1000) / 1000,
      ],
    };
  }
  return chosen === 'hold' ? { kind: 'hold' } : { kind: 'linear' };
}

function makeValue(rng: Rng, width: 1 | 2): number | number[] {
  const one = (): number => Math.round(rng.float(-2, 4) * 1e4) / 1e4;
  return width === 1 ? one() : [one(), one()];
}

function makeKey(rng: Rng, plan: ChannelPlan, t: number): Keyframe {
  return { t, v: makeValue(rng, plan.width), ease: makeEase(rng, plan.kind) };
}

function makeRanges(rng: Rng): [number, number][] {
  const count = rng.int(0, 4);
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const start = rng.time(0, CORPUS_DURATION_SEC);
    ranges.push([start, start + rng.time(0.5, 60)]);
  }
  return ranges;
}

let nextId = 0;
/** Ids are per-process and monotonic so a `track.add` can never collide. */
function freshId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${String(nextId)}`;
}

function makeTrack(rng: Rng): Track {
  const plan = rng.pick(TRACK_PLANS);
  const channels: Track['channels'] = {};
  for (const channel of plan.channels) {
    // Not every channel every time: a track with only `amount` is exactly the case
    // §3.5's "an opinion is per channel" has to get right.
    if (rng.bool(0.25)) continue;
    const keyCount = rng.int(1, 6);
    const times = new Set<number>();
    while (times.size < keyCount) times.add(rng.time(0, CORPUS_DURATION_SEC));
    const keys = [...times].sort((a, b) => a - b).map((t) => makeKey(rng, channel, t));
    channels[channel.name] = {
      keys,
      ...(channel.kind === 'spring'
        ? {
            spring: {
              tension: Math.round(rng.float(80, 400)),
              mass: Math.round(rng.float(0.5, 4) * 100) / 100,
              friction: Math.round(rng.float(10, 90)),
            },
          }
        : {}),
      ...(rng.bool(0.3) ? { clamp: [-1, 3] as [number, number] } : {}),
    };
  }

  const spans = plan.spans ? makeSpans(rng, plan) : undefined;

  return {
    id: freshId(plan.target.replace(':', '-')),
    kind: plan.kind,
    target: plan.target,
    // §3.2: explicit, never inferred — so the generator picks it explicitly too, and
    // both readings get exercised.
    domain: rng.bool(0.75) ? 'source' : 'timeline',
    origin: rng.bool(0.7) ? 'manual' : 'generated',
    blend: rng.pick(['replace', 'add', 'multiply'] as const),
    blendMs: rng.pick([0, 0, 120, 250, 300, 900]),
    activeRanges: makeRanges(rng),
    enabled: rng.bool(0.85),
    channels,
    ...(spans === undefined ? {} : { spans }),
  };
}

function makeSpans(rng: Rng, plan: TrackPlan): Track['spans'] {
  const count = rng.int(0, 3);
  const spans: NonNullable<Track['spans']> = [];
  for (let i = 0; i < count; i++) spans.push(makeSpan(rng, plan));
  return spans;
}

function makeSpan(rng: Rng, plan: TrackPlan): NonNullable<Track['spans']>[number] {
  const start = rng.time(0, CORPUS_DURATION_SEC);
  const isAudio = plan.target.startsWith('audio:');
  const type = isAudio ? 'mute' : rng.pick(['arrow', 'blur', 'rect']);
  const animated = !isAudio && rng.bool(0.7);
  return {
    id: freshId('span'),
    start,
    end: start + rng.time(0.5, 20),
    type,
    ...(rng.bool(0.5) ? { style: { stroke: '#FF3B30', strokeWidth: 0.004 } } : {}),
    ...(animated
      ? {
          channels: {
            opacity: {
              keys: [
                { t: start, v: 0, ease: makeEase(rng, 'curve') },
                { t: start + 0.25, v: 1, ease: { kind: 'hold' } },
              ],
            },
            center: {
              keys: [
                { t: start, v: [rng.float(0, 1), rng.float(0, 1)], ease: { kind: 'linear' } },
                { t: start + 1, v: [rng.float(0, 1), rng.float(0, 1)], ease: { kind: 'hold' } },
              ],
            },
          },
        }
      : {}),
  };
}

function makeClips(rng: Rng): Clip[] {
  const count = rng.int(1, 4);
  const clips: Clip[] = [];
  let at = rng.time(0, 5);
  for (let i = 0; i < count; i++) {
    const length = rng.time(5, 60);
    clips.push({
      id: freshId('clip'),
      sourceStart: at,
      sourceEnd: at + length,
      // Not 1, so a mapping that ignores speed is caught.
      speed: rng.pick([1, 1, 0.5, 1.5, 2]),
    });
    at += length + rng.time(0, 20);
  }
  return clips;
}

/** A channel that already exists on `track`, with the ease kind it was built with. */
function existingChannel(
  rng: Rng,
  track: Track,
): { name: string; kind: 'curve' | 'spring' } | null {
  const names = Object.keys(track.channels);
  if (names.length === 0) return null;
  const name = rng.pick(names);
  const channel = track.channels[name];
  if (channel === undefined) return null;
  const first = channel.keys[0];
  const kind: 'curve' | 'spring' =
    first === undefined
      ? channel.spring === undefined
        ? 'curve'
        : 'spring'
      : first.ease.kind === 'spring'
        ? 'spring'
        : 'curve';
  return { name, kind };
}

/**
 * One random op against `doc`, or `null` when the document offers nothing to do.
 *
 * The distribution is weighted toward keyframe edits because that is what an
 * editing session is mostly made of, but every op kind in §2.7's vocabulary is
 * reachable — `coverageOf` in the gate asserts that they all actually occurred.
 */
export function randomOp(rng: Rng, doc: EditDocument): EditOp | null {
  const tracks = doc.tracks;
  const roll = rng.next();

  if (tracks.length === 0 || roll < 0.14) {
    const track = makeTrack(rng);
    return rng.bool(0.5) && tracks.length > 0
      ? { op: 'track.add', track, at: rng.int(0, tracks.length + 1) }
      : { op: 'track.add', track };
  }

  if (roll < 0.2) {
    return { op: 'track.remove', trackId: rng.pick(tracks).id };
  }

  if (roll < 0.3) {
    // Removing `spans` is the removal `resolve` can see — a mute stops muting, an
    // annotation stops drawing — so it is the one that makes the gate's comparator,
    // and not just the type, prove that a removal survived the journal.
    const withSpans = tracks.filter((t) => (t.spans?.length ?? 0) > 0);
    if (withSpans.length > 0 && rng.bool(0.3)) {
      return { op: 'track.patch', trackId: rng.pick(withSpans).id, patch: { remove: ['spans'] } };
    }
    const track = rng.pick(tracks);
    const which = rng.int(0, 7);
    // A key a patch added and a later patch takes away again: the shape an undo of
    // "add a generator block" has, on a field nothing else in the corpus touches.
    if (which === 5) {
      return { op: 'track.patch', trackId: track.id, patch: { shapePreset: 'pill' } };
    }
    if (which === 6) {
      return { op: 'track.patch', trackId: track.id, patch: { remove: ['shapePreset'] } };
    }
    if (which === 0)
      return { op: 'track.patch', trackId: track.id, patch: { enabled: !track.enabled } };
    if (which === 1)
      return {
        op: 'track.patch',
        trackId: track.id,
        patch: { blend: rng.pick(['replace', 'add', 'multiply'] as const) },
      };
    if (which === 2)
      return { op: 'track.patch', trackId: track.id, patch: { blendMs: rng.pick([0, 150, 400]) } };
    if (which === 3)
      return { op: 'track.patch', trackId: track.id, patch: { activeRanges: makeRanges(rng) } };
    return {
      op: 'track.patch',
      trackId: track.id,
      patch: { domain: track.domain === 'source' ? 'timeline' : 'source' },
    };
  }

  if (roll < 0.36) {
    return { op: 'clips.set', clips: makeClips(rng) };
  }

  if (roll < 0.46) {
    const withSpans = tracks.filter((t) => (t.spans?.length ?? 0) > 0);
    if (withSpans.length > 0 && rng.bool(0.5)) {
      const track = rng.pick(withSpans);
      const span = rng.pick(track.spans ?? []);
      return { op: 'span.remove', trackId: track.id, spanId: span.id };
    }
    const track = rng.pick(tracks);
    const plan = TRACK_PLANS.find((p) => p.target === track.target && p.spans);
    if (plan === undefined) return null;
    return { op: 'span.set', trackId: track.id, span: makeSpan(rng, plan) };
  }

  // The bulk: keyframe edits.
  const track = rng.pick(tracks);
  const channel = existingChannel(rng, track);
  if (channel === null) return null;
  const keys = track.channels[channel.name]?.keys ?? [];

  if (keys.length > 0 && rng.bool(0.3)) {
    return {
      op: 'key.remove',
      trackId: track.id,
      channel: channel.name,
      t: rng.pick(keys).t,
    };
  }

  // Either move an existing key's value (same `t`) or place a new one.
  const t = keys.length > 0 && rng.bool(0.4) ? rng.pick(keys).t : rng.time(0, CORPUS_DURATION_SEC);
  const width: 1 | 2 = Array.isArray(keys[0]?.v) ? 2 : 1;
  return {
    op: 'key.set',
    trackId: track.id,
    channel: channel.name,
    key: makeKey(rng, { name: channel.name, width, kind: channel.kind }, t),
  };
}

/** One op with the journal bookkeeping main would give it. */
export interface GeneratedStep {
  op: EditOp;
  revision: number;
}

export interface GeneratedSequence {
  /** The `edit.json` the journal is replayed on top of. */
  base: EditDocument;
  steps: GeneratedStep[];
  /** The document after every step, as the editor holds it in memory. */
  live: EditDocument;
}

/** What the corpus contained, so the gate can assert it was not thin. */
export interface Coverage {
  opKinds: Set<string>;
  targets: Set<string>;
  domains: Set<string>;
  blends: Set<string>;
  easeKinds: Set<string>;
  /** Track keys a `track.patch` actually removed — §2.7's `patch.remove`. */
  removedKeys: Set<string>;
  springChannels: number;
  clampedChannels: number;
  crossfadedTracks: number;
  spans: number;
  nonUnitSpeeds: number;
}

export function emptyCoverage(): Coverage {
  return {
    opKinds: new Set(),
    targets: new Set(),
    domains: new Set(),
    blends: new Set(),
    easeKinds: new Set(),
    removedKeys: new Set(),
    springChannels: 0,
    clampedChannels: 0,
    crossfadedTracks: 0,
    spans: 0,
    nonUnitSpeeds: 0,
  };
}

export function observe(coverage: Coverage, doc: EditDocument, op: EditOp): void {
  coverage.opKinds.add(op.op);
  if (op.op === 'track.patch')
    for (const key of op.patch.remove ?? []) coverage.removedKeys.add(key);
  for (const track of doc.tracks) {
    coverage.targets.add(track.target);
    coverage.domains.add(track.domain);
    coverage.blends.add(track.blend);
    if (track.blendMs > 0 && track.activeRanges.length > 0) coverage.crossfadedTracks++;
    coverage.spans += track.spans?.length ?? 0;
    for (const channel of Object.values(track.channels)) {
      if (channel.spring !== undefined) coverage.springChannels++;
      if (channel.clamp !== undefined) coverage.clampedChannels++;
      for (const key of channel.keys) coverage.easeKinds.add(key.ease.kind);
    }
  }
  for (const clip of doc.clips) if (clip.speed !== 1) coverage.nonUnitSpeeds++;
}
