/**
 * `edit.json` — the edit-decision document. Architecture report §2.6 and §3.3.
 *
 * The whole model is four track kinds, one keyframe type, one channel type.
 * Manual zoom keyframes, generated cursor-follow keyframes, annotations, trims
 * and audio levels are all the *same* primitive, which is what makes features
 * layer instead of fight.
 *
 * **Boundary note.** `packages/format` owns these types, their on-disk schema,
 * their migrations, and the journal ops that mutate them. `packages/edl`
 * (phase 7) owns the *semantics* — `compile()`, `resolve()`, the generators —
 * and imports these types from here. Architecture report §1.3 lists both
 * "EditDocument types" under `edl` and "on-disk schemas" under `format`; the
 * phase 0 brief resolves that overlap in favour of `format`, and putting them
 * here is also what keeps `edl` free of any dependency cycle.
 */

import type { IsoTimestamp, Seconds, Vec2 } from './common.ts';
import type { SchemaId } from '../schema.ts';

/** How you *leave* this keyframe toward the next. */
export type Ease =
  | { kind: 'hold' }
  | { kind: 'linear' }
  /** CSS `cubic-bezier(p1x, p1y, p2x, p2y)`. */
  | { kind: 'cubic'; p1: Vec2; p2: Vec2 }
  /** Spring parameters live on the channel, not the key. */
  | { kind: 'spring' };

export type ChannelValue = number | number[];

export interface Keyframe<V extends ChannelValue = ChannelValue> {
  t: Seconds;
  v: V;
  ease: Ease;
}

export interface SpringParams {
  tension: number;
  mass: number;
  friction: number;
}

/**
 * A channel is evaluated one of two ways and **mixing them within a channel is a
 * validation error** (§3.4):
 *
 * - *Curve* channels (`hold` / `linear` / `cubic`) are pointwise, O(log n), stateless.
 * - *Spring* channels (`ease: 'spring'` on every key, plus `channel.spring`) turn the
 *   keyframes into step targets for a spring-mass-damper integrated on a fixed 8 ms
 *   grid at compile time. Integrating at the frame rate instead diverges by a
 *   measured 82.6 px at 3456 wide, so this is a rule, not a preference.
 */
export interface Channel<V extends ChannelValue = ChannelValue> {
  /** Sorted by `t`, unique `t`. */
  keys: Keyframe<V>[];
  spring?: SpringParams;
  clamp?: [number, number];
}

/**
 * The generators a track may declare itself the output of.
 *
 * A closed list, and one array rather than a union written twice: the validator
 * reads this, so adding a generator is one edit and a document carrying an unknown
 * one is refused rather than quietly accepted by a type that has no runtime.
 *
 * `live-drawing` is phase 12's, and it is a generator in exactly §3.5's sense even
 * though nothing is computed: `events/drawing.ndjson` is an input the user cannot
 * edit, the track is rewritten wholesale when it is re-imported, and their own
 * annotations live in a different track and therefore survive by construction.
 */
export const GENERATOR_TYPES = [
  'cursor-follow',
  'auto-zoom-on-click',
  'duck-under-mic',
  'live-drawing',
] as const;

export type GeneratorType = (typeof GENERATOR_TYPES)[number];

export interface GeneratorSpec {
  type: GeneratorType;
  params: Record<string, number | number[]>;
  /** Fingerprint of the inputs, e.g. `{ clicks: 'sha256:41ba…' }`. If the hash no
   * longer matches, the UI offers "regenerate" rather than serving stale motion. */
  inputs: Record<string, string>;
  generatedAt: IsoTimestamp;
}

/** A discrete object on a track: an annotation, a mute. A span can itself be animated. */
export interface Span {
  id: string;
  start: Seconds;
  end: Seconds;
  type: string;
  style?: Record<string, unknown>;
  channels?: Record<string, Channel>;
}

export type TrackKind = 'clips' | 'transform' | 'object' | 'audio';

/**
 * `'source'` — seconds into the raw recording. `'timeline'` — seconds into the
 * edited output. Effect tracks default to `source` so that trimming does not
 * re-time your zooms (§3.2, a deliberate divergence from Cap). Tracks that
 * describe the *output* rather than the *content* — background, aspect ratio,
 * global grade — set `timeline`. The field is per-track and explicit; there is
 * no inference.
 */
export type TimeDomain = 'source' | 'timeline';

export type BlendMode = 'replace' | 'add' | 'multiply';

export interface Track {
  id: string;
  kind: TrackKind;
  /** `'zoom' | 'bubble' | 'cursor' | 'annotation' | 'audio:mic' | 'audio:system'` */
  target: string;
  domain: TimeDomain;
  origin: 'manual' | 'generated';
  generator?: GeneratorSpec;
  /** Provenance kept when a generated track is baked to `origin: 'manual'` (§3.5). */
  generatedFrom?: GeneratorSpec;
  blend: BlendMode;
  /** Crossfade at `activeRanges` edges, milliseconds. */
  blendMs: number;
  activeRanges: [Seconds, Seconds][];
  enabled: boolean;
  channels: Record<string, Channel>;
  spans?: Span[];

  // ---- per-target extras, as they appear in the §2.6 reference document ----
  /** Bubble tracks only. Exists so the UI can show which chip is selected; the
   * shape itself is geometry (`aspect` + `corner01`), not an enum. */
  shapePreset?: string;
  /** Cursor tracks only. */
  smoothing?: SpringParams;
  /** Cursor tracks only. */
  clickSpring?: SpringParams;
  /** Cursor tracks only. `null` means "never hide". */
  hideWhenIdleSec?: Seconds | null;
}

/** The only thing that maps source time to timeline time (§3.1). */
export interface Clip {
  id: string;
  sourceStart: Seconds;
  sourceEnd: Seconds;
  speed: number;
}

export type BackgroundSpec = { kind: 'none' } | { kind: 'color'; color: string };

export interface OutputSpec {
  size: [number, number];
  fps: number;
  background: BackgroundSpec;
}

export interface EditDocument {
  schema: SchemaId;
  /**
   * Monotonic. Bumped once per applied op batch. `applyOps` takes a `baseRevision`
   * and reports a conflict when it does not match, which only happens if two
   * windows have the same project open (§2.7).
   */
  revision: number;
  output: OutputSpec;
  clips: Clip[];
  tracks: Track[];
}
