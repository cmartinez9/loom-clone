/**
 * `compile` — the once-per-edit half of the model.
 *
 * Architecture report §3.6 declares it as
 * `compile(doc: EditDocument, ctx: CompileContext): CompiledTimeline`, annotated
 * *"Runs the fixed-grid spring precompute once. ~14 ms for a 30-minute project"*,
 * and says when it runs:
 *
 * > `compile` is called on load and on any op that changes a spring channel
 * > (debounced 100 ms). `resolve` is what preview and export both call, and it is
 * > the reason they cannot disagree.
 *
 * Everything expensive happens here so that nothing expensive happens in
 * `resolve`: the spring tables are integrated on the fixed 8 ms grid (§3.4), the
 * curve bucket indexes are built, the clip list is flattened, and every track is
 * reduced to a fixed set of typed arrays plus **direct references** to the channels
 * it owns. `resolve` then does no string lookups, no `Map` reads, no allocation and
 * no branching on document shape — it walks arrays.
 *
 * ## The track stack, laid out
 *
 * §3.5 is one mechanism: *"tracks on the same `target` stack, and the topmost track
 * with an opinion wins."* A **stack** here is one target's worth of that — an
 * identity vector, a fixed component layout (`zoom` is `[amount, cx, cy]`), and the
 * enabled tracks that name that target, in document order. Compiling the layout
 * once is what lets the fold in `resolve` be a loop over numbers.
 *
 * *An opinion is per channel, not per track.* A zoom track carrying only `amount`
 * must not reset the centre the track below it set; §3.5's `evaluateChannels` is
 * therefore read as "the channels this track actually has", and a component no
 * layer names keeps the value it already had.
 */

import type { EditDocument, RecordingDoc, Seconds, Span, Track } from '@loom/format';
import { compileChannel, type CompiledChannel, CurveChannel, SpringChannel } from './channel.ts';
import { compileClips, sourceDurationSec, type CompiledClips } from './clips.ts';
import type { ClickEventStream, CursorEventStream } from './streams.ts';
import {
  identityState,
  IDENTITY_BUBBLE_ASPECT,
  IDENTITY_BUBBLE_CORNER01,
  IDENTITY_BUBBLE_CX,
  IDENTITY_BUBBLE_CY,
  IDENTITY_BUBBLE_OPACITY,
  IDENTITY_BUBBLE_SIZE_Y,
  IDENTITY_CURSOR_OPACITY,
  IDENTITY_CURSOR_SCALE,
  IDENTITY_GAIN_DB,
  IDENTITY_ZOOM_AMOUNT,
  IDENTITY_ZOOM_CX,
  IDENTITY_ZOOM_CY,
  type ResolvedAnnotation,
  type ResolvedState,
} from './state.ts';

/** §3.6's context, with the one deviation `streams.ts` explains. */
export interface CompileContext {
  cursor: CursorEventStream | null;
  clicks: ClickEventStream | null;
  recording: RecordingDoc | null;
}

/** A context that reaches nothing — the shape a model-only test or an empty project has. */
export const EMPTY_COMPILE_CONTEXT: CompileContext = {
  cursor: null,
  clicks: null,
  recording: null,
};

/** `0` = evaluate at `sourceTime`, `1` = at `timelineTime`. Never inferred (§3.2). */
export const DOMAIN_SOURCE = 0;
export const DOMAIN_TIMELINE = 1;

export const BLEND_REPLACE = 0;
export const BLEND_ADD = 1;
export const BLEND_MULTIPLY = 2;

/** One channel of one track, and where its components land in the stack's vector. */
export interface CompiledSlot {
  channel: CompiledChannel;
  offset: number;
  width: number;
}

/** One track's contribution to a target, reduced to numbers. */
export interface CompiledLayer {
  trackId: string;
  domain: number;
  blend: number;
  /** Flattened `[start, end]` pairs. Empty means the track is never active. */
  ranges: Float64Array;
  /** `blendMs / 1000`. Zero means a hard edge. */
  blendSec: number;
  slots: CompiledSlot[];
}

/**
 * All the layers stacked on one `target`, plus the vector they blend into.
 *
 * `acc` and `scratch` are owned here and rewritten on every resolve; that is the
 * whole of "no allocation" in §3.6.
 */
export interface CompiledStack {
  target: string;
  width: number;
  identity: Float64Array;
  layers: CompiledLayer[];
  acc: Float64Array;
  scratch: Float64Array;
  /** Set by the fold: true when some layer had a non-zero window at that instant. */
  covered: boolean;
}

/** One annotation span, with its channels compiled and its resolved form pooled. */
export interface CompiledSpan {
  start: Seconds;
  end: Seconds;
  channels: { name: string; channel: CompiledChannel; out: Float64Array }[];
  resolved: ResolvedAnnotation;
}

/** An `kind: 'object'` track: a window, a domain, and its spans. */
export interface CompiledSpanLayer {
  trackId: string;
  domain: number;
  ranges: Float64Array;
  blendSec: number;
  spans: CompiledSpan[];
}

/** An audio track's mute spans, in the track's own domain. */
export interface CompiledMuteLayer {
  domain: number;
  /** Flattened `[start, end]` pairs. */
  spans: Float64Array;
}

const ZOOM_LAYOUT: Record<string, [number, number]> = {
  amount: [0, 1],
  center: [1, 2],
};

const BUBBLE_LAYOUT: Record<string, [number, number]> = {
  center: [0, 2],
  sizeY: [2, 1],
  aspect: [3, 1],
  corner01: [4, 1],
  opacity: [5, 1],
  mirror: [6, 1],
};

const CURSOR_LAYOUT: Record<string, [number, number]> = {
  scale: [0, 1],
  opacity: [1, 1],
};

const GAIN_LAYOUT: Record<string, [number, number]> = {
  gainDb: [0, 1],
};

export const TARGET_ZOOM = 'zoom';
export const TARGET_BUBBLE = 'bubble';
export const TARGET_CURSOR = 'cursor';
export const TARGET_ANNOTATION = 'annotation';
export const TARGET_AUDIO_MIC = 'audio:mic';
export const TARGET_AUDIO_SYSTEM = 'audio:system';

/**
 * The compiled timeline. §3.6 declares the first four fields by name and type; the
 * rest is the layout that makes `resolve` a walk over arrays and is marked
 * `@internal` because nothing outside this package should reach for it.
 */
export class CompiledTimeline {
  readonly durationSec: Seconds;
  /** Timeline-time start of each clip (§3.6). */
  readonly clipStarts: Float64Array;
  /** `<trackId>.<channel>` → its fixed-8 ms-grid samples (§3.6). */
  readonly springSamples: Map<string, Float32Array>;
  /** `<trackId>.<channel>` → its bucket index (§3.6). */
  readonly curveIndex: Map<string, Uint32Array>;

  /** @internal */ readonly clips: CompiledClips;
  /** @internal */ readonly zoom: CompiledStack;
  /** @internal */ readonly bubble: CompiledStack;
  /** @internal */ readonly cursorStack: CompiledStack;
  /** @internal */ readonly mic: CompiledStack;
  /** @internal */ readonly system: CompiledStack;
  /** @internal */ readonly micMutes: CompiledMuteLayer[];
  /** @internal */ readonly systemMutes: CompiledMuteLayer[];
  /** @internal */ readonly annotations: CompiledSpanLayer[];
  /** @internal */ readonly cursorStream: CursorEventStream | null;
  /** @internal */ readonly clickStream: ClickEventStream | null;
  /**
   * The single state object `resolve` returns, overwritten in place (§3.6, and
   * `state.ts`'s ownership note).
   * @internal
   */
  readonly state: ResolvedState;

  constructor(init: {
    clips: CompiledClips;
    zoom: CompiledStack;
    bubble: CompiledStack;
    cursorStack: CompiledStack;
    mic: CompiledStack;
    system: CompiledStack;
    micMutes: CompiledMuteLayer[];
    systemMutes: CompiledMuteLayer[];
    annotations: CompiledSpanLayer[];
    cursorStream: CursorEventStream | null;
    clickStream: ClickEventStream | null;
    springSamples: Map<string, Float32Array>;
    curveIndex: Map<string, Uint32Array>;
  }) {
    this.clips = init.clips;
    this.durationSec = init.clips.durationSec;
    this.clipStarts = init.clips.starts;
    this.zoom = init.zoom;
    this.bubble = init.bubble;
    this.cursorStack = init.cursorStack;
    this.mic = init.mic;
    this.system = init.system;
    this.micMutes = init.micMutes;
    this.systemMutes = init.systemMutes;
    this.annotations = init.annotations;
    this.cursorStream = init.cursorStream;
    this.clickStream = init.clickStream;
    this.springSamples = init.springSamples;
    this.curveIndex = init.curveIndex;
    this.state = identityState(0);
  }
}

function makeStack(target: string, identity: readonly number[]): CompiledStack {
  return {
    target,
    width: identity.length,
    identity: Float64Array.from(identity),
    layers: [],
    acc: new Float64Array(identity.length),
    scratch: new Float64Array(Math.max(1, identity.length)),
    covered: false,
  };
}

function compileRanges(track: Track): Float64Array {
  const flat = new Float64Array(track.activeRanges.length * 2);
  track.activeRanges.forEach((range, i) => {
    flat[i * 2] = range[0];
    flat[i * 2 + 1] = range[1];
  });
  return flat;
}

function domainCode(track: Track): number {
  // §3.2: "The field is per-track and explicit; there is no inference." An
  // unrecognised value is not silently read as `source`.
  if (track.domain === 'source') return DOMAIN_SOURCE;
  if (track.domain === 'timeline') return DOMAIN_TIMELINE;
  throw new Error(
    `track ${JSON.stringify(track.id)} has domain ${JSON.stringify(String(track.domain))}; ` +
      'expected "source" or "timeline" (architecture report §3.2)',
  );
}

function blendCode(track: Track): number {
  switch (track.blend) {
    case 'add':
      return BLEND_ADD;
    case 'multiply':
      return BLEND_MULTIPLY;
    default:
      return BLEND_REPLACE;
  }
}

/** Record a compiled channel in §3.6's two public maps. */
function record(
  channel: CompiledChannel,
  springSamples: Map<string, Float32Array>,
  curveIndex: Map<string, Uint32Array>,
): void {
  if (channel instanceof SpringChannel) springSamples.set(channel.key, channel.samples);
  else if (channel instanceof CurveChannel) curveIndex.set(channel.key, channel.buckets);
}

function compileLayer(
  track: Track,
  layout: Record<string, [number, number]>,
  springSamples: Map<string, Float32Array>,
  curveIndex: Map<string, Uint32Array>,
): CompiledLayer {
  const slots: CompiledSlot[] = [];
  for (const [name, channel] of Object.entries(track.channels)) {
    const place = layout[name];
    // A channel the target does not define is kept in the document and ignored
    // here rather than refused: a newer build's extra channel must not make a
    // recording unopenable, and §2.7 refuses *unknown schemas*, not unknown keys.
    if (place === undefined) continue;
    const compiled = compileChannel(`${track.id}.${name}`, channel);
    if (compiled === null) continue;
    record(compiled, springSamples, curveIndex);
    slots.push({ channel: compiled, offset: place[0], width: Math.min(place[1], compiled.width) });
  }
  return {
    trackId: track.id,
    domain: domainCode(track),
    blend: blendCode(track),
    ranges: compileRanges(track),
    blendSec: Math.max(0, track.blendMs) / 1000,
    slots,
  };
}

function compileSpanLayer(
  track: Track,
  springSamples: Map<string, Float32Array>,
  curveIndex: Map<string, Uint32Array>,
): CompiledSpanLayer {
  const spans: CompiledSpan[] = [];
  for (const span of track.spans ?? []) {
    const channels: CompiledSpan['channels'] = [];
    const values = new Map<string, Float64Array>();
    for (const [name, channel] of Object.entries(span.channels ?? {})) {
      const compiled = compileChannel(`${track.id}#${span.id}.${name}`, channel);
      if (compiled === null) continue;
      record(compiled, springSamples, curveIndex);
      const out = new Float64Array(compiled.width);
      values.set(name, out);
      channels.push({ name, channel: compiled, out });
    }
    const resolved: ResolvedAnnotation = {
      id: span.id,
      type: span.type,
      style: span.style ?? null,
      values,
      weight: 0,
    };
    spans.push({ start: span.start, end: span.end, channels, resolved });
  }
  return {
    trackId: track.id,
    domain: domainCode(track),
    ranges: compileRanges(track),
    blendSec: Math.max(0, track.blendMs) / 1000,
    spans,
  };
}

function compileMutes(track: Track): CompiledMuteLayer {
  const mutes = (track.spans ?? []).filter((s: Span) => s.type === 'mute');
  const flat = new Float64Array(mutes.length * 2);
  mutes.forEach((span, i) => {
    flat[i * 2] = span.start;
    flat[i * 2 + 1] = span.end;
  });
  return { domain: domainCode(track), spans: flat };
}

/**
 * Compile a document into the form `resolve` walks.
 *
 * Throws {@link ChannelCompileError} on a channel that mixes spring and curve
 * easings, and an `Error` on a track whose `domain` is neither `source` nor
 * `timeline`. Both are conditions `validateEditDocument` already refuses on the way
 * to disk; compiling is the second place they cannot pass, because a generator's
 * output and a test fixture never go through a file.
 */
export function compile(
  doc: EditDocument,
  ctx: CompileContext = EMPTY_COMPILE_CONTEXT,
): CompiledTimeline {
  const springSamples = new Map<string, Float32Array>();
  const curveIndex = new Map<string, Uint32Array>();

  const clips = compileClips(doc.clips, sourceDurationSec(ctx.recording));

  const zoom = makeStack(TARGET_ZOOM, [IDENTITY_ZOOM_AMOUNT, IDENTITY_ZOOM_CX, IDENTITY_ZOOM_CY]);
  const bubble = makeStack(TARGET_BUBBLE, [
    IDENTITY_BUBBLE_CX,
    IDENTITY_BUBBLE_CY,
    IDENTITY_BUBBLE_SIZE_Y,
    IDENTITY_BUBBLE_ASPECT,
    IDENTITY_BUBBLE_CORNER01,
    IDENTITY_BUBBLE_OPACITY,
    0,
  ]);
  const cursorStack = makeStack(TARGET_CURSOR, [IDENTITY_CURSOR_SCALE, IDENTITY_CURSOR_OPACITY]);
  const mic = makeStack(TARGET_AUDIO_MIC, [IDENTITY_GAIN_DB]);
  const system = makeStack(TARGET_AUDIO_SYSTEM, [IDENTITY_GAIN_DB]);
  const micMutes: CompiledMuteLayer[] = [];
  const systemMutes: CompiledMuteLayer[] = [];
  const annotations: CompiledSpanLayer[] = [];

  // Document order is stack order (§3.5: "in array order"). A disabled track is
  // dropped here rather than skipped in the hot path.
  for (const track of doc.tracks) {
    if (!track.enabled) continue;
    switch (track.target) {
      case TARGET_ZOOM:
        zoom.layers.push(compileLayer(track, ZOOM_LAYOUT, springSamples, curveIndex));
        break;
      case TARGET_BUBBLE:
        bubble.layers.push(compileLayer(track, BUBBLE_LAYOUT, springSamples, curveIndex));
        break;
      case TARGET_CURSOR:
        cursorStack.layers.push(compileLayer(track, CURSOR_LAYOUT, springSamples, curveIndex));
        break;
      case TARGET_ANNOTATION:
        annotations.push(compileSpanLayer(track, springSamples, curveIndex));
        break;
      case TARGET_AUDIO_MIC:
        mic.layers.push(compileLayer(track, GAIN_LAYOUT, springSamples, curveIndex));
        micMutes.push(compileMutes(track));
        break;
      case TARGET_AUDIO_SYSTEM:
        system.layers.push(compileLayer(track, GAIN_LAYOUT, springSamples, curveIndex));
        systemMutes.push(compileMutes(track));
        break;
      default:
        // A target this build does not render — a later phase's, or a hand-edited
        // document's. Kept on disk, ignored here.
        break;
    }
  }

  return new CompiledTimeline({
    clips,
    zoom,
    bubble,
    cursorStack,
    mic,
    system,
    micMutes,
    systemMutes,
    annotations,
    cursorStream: ctx.cursor,
    clickStream: ctx.clicks,
    springSamples,
    curveIndex,
  });
}
