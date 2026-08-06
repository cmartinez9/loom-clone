/**
 * Manual zoom, as arithmetic over one ordinary track.
 *
 * The captain's editor-scope decision annotated exactly one row of the capability
 * table by hand — *"Manual option too."* on **auto-zoom & cursor-follow applied** —
 * so this is the part of `loom-p15` he asked for by name:
 *
 * > Generators apply automatically, and the user must also be able to take manual
 * > control — **tune, override, or place zoom by hand** rather than only accepting
 * > what the generator produced.
 *
 * All three verbs land here, and none of them is a new primitive. A manual zoom is a
 * `manualZoomTrack` (`@loom/edl`) carrying one `activeRanges` window per **region**
 * the user placed, with §6.5's own four-keys-per-segment shape on `amount` and
 * spring keys on `center`. It is an ordinary track in every respect that matters:
 * `resolve` folds it with `windowWeight` like any other, it crossfades over
 * `blendMs` at its edges, and outside its windows it has **no opinion at all**, so
 * whatever the generator put underneath shows through.
 *
 * ## Why "override" is a track above and not an edit to the generated one
 *
 * §3.5 is unambiguous: *"Regeneration rewrites only the generated track. User edits
 * survive by construction, because they were never in that track."* Editing a
 * generated track's keys in place would put the user's work in the one place a
 * regeneration is licensed to overwrite, and there is no third state — §3.5 again:
 * *"no partial-override merge, and no 'your edit was overwritten' bug — because the
 * two never share storage."* So {@link overrideZoomOps} seeds a **manual** region
 * over the generated segment, at the top of the stack, and the generated track is
 * left byte-for-byte alone. The user's other option is {@link bakeOps}, which
 * detaches the generated track from regeneration altogether; the editor offers both
 * and says which is which, because they are different intentions rather than two
 * routes to one outcome.
 *
 * ## Spring keys, and the settle tail that has to come with them
 *
 * §6.5 step 5 and §6.3: the keys are `ease: 'spring'` and the channel carries
 * {@link DEFAULT_SPRING}. That is not a stylistic match with the generator — it is
 * the same requirement. §3.4 forbids integrating a spring at frame rate anywhere, so
 * the only thing this file may do is emit keys; `precomputeSpring` integrates them on
 * the fixed 8 ms grid at compile time, analytically, and nothing here re-derives a
 * single value.
 *
 * The consequence phase 10 paid for and this inherits: **a region's `activeRanges`
 * window has to run past its last keyframe by the spring's settling time.** At the
 * last key the target is identity but the spring is still on its way there, so a
 * window that ended on the key would hand `blendMs` a discontinuity to crossfade and
 * turn a 0.6 s zoom-out into a 300 ms one. `segmentSettleTailSec` is phase 10's own
 * answer to exactly that (`auto-zoom.ts`'s module header has the measurements) and is
 * imported rather than restated.
 *
 * ## Pure, and in its own module, for `trim.ts`'s reason
 *
 * What a document *means* by "a manual zoom", what a control is allowed to produce,
 * and what ops to send are all testable without a window, and the arithmetic here is
 * the kind that is wrong in a way you cannot see.
 */

import { DEFAULT_SPRING, edgeSnap, manualZoomTrack, segmentSettleTailSec } from '@loom/edl';
import type {
  EditDocument,
  EditOp,
  Keyframe,
  Seconds,
  SpringParams,
  Track,
  Vec2,
} from '@loom/format';

/**
 * The id every manual zoom this editor writes lives on.
 *
 * One track holding every region, rather than one track per region. Both are legal
 * §3.5 documents, and this one is the right shape for two reasons: the regions never
 * overlap (see {@link placeZoomOps}), so they cannot need to stack against each
 * other; and the alternative grows the track array without bound, which is the
 * stacking UI the captain took **out** of the MVP arriving through the back door as
 * a list the user has to reason about.
 */
export const MANUAL_ZOOM_TRACK_ID = 't-zoom-manual';

/** What a freshly placed region magnifies to. §6.5's `amountRange` sits at 1.2–2.5. */
export const DEFAULT_ZOOM_AMOUNT = 2;

/**
 * The magnification a control may ask for.
 *
 * The floor is 1 because §3.3's own channel bound is *"zoom below 1 would not fill
 * the frame"*, and it is written into the channel's `clamp` as well as enforced here
 * so a hand-edited document is bounded by the model rather than by this file. The
 * ceiling is 4: at 4× a 1080p output is sampling a 480×270 window of the source, and
 * past that the picture a person is judging is mostly interpolation.
 */
export const MIN_ZOOM_AMOUNT = 1;
export const MAX_ZOOM_AMOUNT = 4;

/**
 * How long a region takes to zoom in, and to zoom back out.
 *
 * §6.5's `preRollSec`. Taken from the generator rather than chosen, because a
 * hand-placed zoom and a generated one appearing in the same recording at visibly
 * different speeds is a defect the user cannot name.
 */
export const ZOOM_RAMP_SEC = 0.6;

/** The shortest hold a region may have; below it the ramps meet and there is no zoom. */
export const MIN_HOLD_SEC = 0.2;

/** What a newly placed region holds for, before the ramp out. */
export const DEFAULT_HOLD_SEC = 2;

/** §6.5's `edgeSnapRatio`, so a hand-placed centre snaps to the frame edge as one does. */
const EDGE_SNAP_RATIO = 0.15;

/**
 * One zoom the user placed: a window of source time, a magnification, and a centre.
 *
 * `startSec`/`endSec` are the **keyframed** extent — where the ramp in begins and
 * where the ramp out finishes. `windowEndSec` is where the track's `activeRanges`
 * entry actually ends, which is later by the spring's settle tail; it is reported
 * rather than hidden because the timeline draws the window and a lane that stopped at
 * `endSec` would not explain why the zoom is still moving.
 */
export interface ZoomRegion {
  /** Index into the track's `activeRanges`, and the region's identity for an edit. */
  index: number;
  startSec: Seconds;
  endSec: Seconds;
  windowEndSec: Seconds;
  amount: number;
  center: Vec2;
}

/** The editor's own manual zoom track, or `null` when the user has placed none. */
export function manualZoomTrackOf(doc: EditDocument): Track | null {
  return doc.tracks.find((track) => track.id === MANUAL_ZOOM_TRACK_ID) ?? null;
}

/**
 * The regions on the manual track, in time order.
 *
 * Read out of the keys rather than remembered beside them: `edit.json` is the
 * authority, an undo rewrites it through the ordinary op path, and a cache of "what
 * the user meant" beside the document is a second state to keep correct. The four
 * keys per region are §6.5's shape, so the hold's amount is the second key's and the
 * centre is the middle `center` key's.
 */
export function zoomRegionsOf(doc: EditDocument): ZoomRegion[] {
  const track = manualZoomTrackOf(doc);
  if (track === null) return [];
  const amountKeys = track.channels['amount']?.keys ?? [];
  const centerKeys = track.channels['center']?.keys ?? [];
  const out: ZoomRegion[] = [];
  track.activeRanges.forEach((range, index) => {
    const [windowStart, windowEnd] = range;
    const inside = amountKeys.filter((key) => key.t >= windowStart - 1e-9 && key.t <= windowEnd);
    if (inside.length < 2) return;
    const startSec = inside[0]?.t ?? windowStart;
    const endSec = inside[inside.length - 1]?.t ?? windowEnd;
    // The hold, not the ramp ends: the largest target inside the window is what the
    // region magnifies to, and reading it that way survives a user who dragged the
    // ramp keys around.
    let amount = MIN_ZOOM_AMOUNT;
    for (const key of inside) {
      const v = typeof key.v === 'number' ? key.v : (key.v[0] ?? MIN_ZOOM_AMOUNT);
      if (v > amount) amount = v;
    }
    const centres = centerKeys.filter(
      (key) => key.t > startSec + 1e-9 && key.t < endSec - 1e-9 && Array.isArray(key.v),
    );
    const middle = centres[Math.floor(centres.length / 2)]?.v;
    const center: Vec2 =
      Array.isArray(middle) && middle.length >= 2
        ? [middle[0] ?? 0.5, middle[1] ?? 0.5]
        : [0.5, 0.5];
    out.push({ index, startSec, endSec, windowEndSec: windowEnd, amount, center });
  });
  return out;
}

/** The region covering `atSec`, or `null`. Windows never overlap, so there is at most one. */
export function zoomRegionAt(doc: EditDocument, atSec: Seconds): ZoomRegion | null {
  return (
    zoomRegionsOf(doc).find((region) => atSec >= region.startSec && atSec <= region.windowEndSec) ??
    null
  );
}

/** What a region is being asked to be. Every field is the user's, none is derived. */
export interface ZoomRegionInput {
  startSec: Seconds;
  endSec: Seconds;
  amount: number;
  center: Vec2;
}

/**
 * The ops that place a new zoom region, or `null` when there is no room for one.
 *
 * `null` rather than an empty batch, for `trimOp`'s reason: an op that changes
 * nothing still costs a revision, a journal line and an undo step that appears to do
 * nothing when it is used.
 *
 * **Regions never overlap.** A request that would land inside an existing window is
 * refused rather than merged, because two overlapping windows on one track are two
 * `activeRanges` entries whose crossfades add — `windowWeight` takes the maximum, so
 * the seam is silent rather than wrong, but the *keys* interleave and the second
 * region's ramp-in would be evaluated against the first's hold. §6.5 merges instead;
 * a hand-placed zoom has a person to ask, and refusing is the answer that does not
 * quietly move the thing they already placed.
 */
export function placeZoomOps(
  doc: EditDocument,
  input: ZoomRegionInput,
  sourceDurationSec: Seconds,
): EditOp[] | null {
  const region = clampRegion(input, sourceDurationSec);
  if (region === null) return null;
  const existing = manualZoomTrackOf(doc);
  const windows = (existing?.activeRanges ?? []).map(
    (range) => [range[0], range[1]] as [number, number],
  );
  const tail = segmentSettleTailSec(DEFAULT_SPRING);
  const window: [number, number] = [region.startSec, region.endSec + tail];
  if (windows.some((other) => overlaps(other, window))) return null;

  const next = [...windows, window].sort((a, b) => a[0] - b[0]);
  const regions = [...zoomRegionsOf(doc).map(asInput), region].sort(
    (a, b) => a.startSec - b.startSec,
  );
  return rewriteTrackOps(doc, existing, next, regions);
}

/**
 * The ops that change one region — the *tune* verb.
 *
 * Everything about a region is one edit: its amount, its centre, and where it starts
 * and ends. They travel together because they are one keyframe layout, and sending
 * "just the amount" would mean rewriting three of the four `amount` keys and leaving
 * `center`'s window untouched — which is the same batch with a worse name on it.
 */
export function updateZoomOps(
  doc: EditDocument,
  index: number,
  patch: Partial<ZoomRegionInput>,
  sourceDurationSec: Seconds,
): EditOp[] | null {
  const track = manualZoomTrackOf(doc);
  if (track === null) return null;
  const regions = zoomRegionsOf(doc);
  const current = regions.find((region) => region.index === index);
  if (current === undefined) return null;

  const wanted = clampRegion({ ...asInput(current), ...patch }, sourceDurationSec);
  if (wanted === null) return null;

  const tail = segmentSettleTailSec(DEFAULT_SPRING);
  const window: [number, number] = [wanted.startSec, wanted.endSec + tail];
  const others = regions.filter((region) => region.index !== index);
  if (others.some((other) => overlaps([other.startSec, other.windowEndSec], window))) return null;

  const nextRegions = [...others.map(asInput), wanted].sort((a, b) => a.startSec - b.startSec);
  const nextWindows = nextRegions
    .map((region) => [region.startSec, region.endSec + tail] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (sameLayout(track, nextWindows, nextRegions)) return null;
  return rewriteTrackOps(doc, track, nextWindows, nextRegions);
}

/**
 * The ops that remove one region — and the whole track when it was the last one.
 *
 * Removing the track rather than leaving it with no windows is deliberate. An empty
 * `activeRanges` is *never active* (§3.5, and `windowWeight` reads it that way), so a
 * parked empty track resolves identically to no track at all — but it is a row in the
 * document, an entry in the stack, and a thing the next reader has to decide is
 * inert. `track.remove` is exactly invertible (`inverse.ts` restores it at its index),
 * so nothing is lost by saying so.
 */
export function removeZoomOps(doc: EditDocument, index: number): EditOp[] | null {
  const track = manualZoomTrackOf(doc);
  if (track === null) return null;
  const regions = zoomRegionsOf(doc);
  if (!regions.some((region) => region.index === index)) return null;
  const rest = regions.filter((region) => region.index !== index);
  if (rest.length === 0) return [{ op: 'track.remove', trackId: track.id }];
  const tail = segmentSettleTailSec(DEFAULT_SPRING);
  const inputs = rest.map(asInput).sort((a, b) => a.startSec - b.startSec);
  const windows = inputs.map(
    (region) => [region.startSec, region.endSec + tail] as [number, number],
  );
  return rewriteTrackOps(doc, track, windows, inputs);
}

/**
 * *Override* — take manual control of the zoom a generator produced, at one instant.
 *
 * The seeded amount and centre are the **resolved** ones the caller read off the
 * compiled timeline at `atSec`, so the picture does not jump the moment control
 * changes hands: the manual region starts life saying what the generator was already
 * saying, and the user tunes from there. That number cannot be computed here —
 * `resolve` needs a `CompiledTimeline` and this module is pure arithmetic over a
 * document — and it should not be, because a second opinion about what the generated
 * track is doing at `atSec` is exactly the drift §4.5 is about.
 *
 * `span` is the generated segment's own window when the caller found one, so
 * "override this zoom" covers the zoom rather than an arbitrary few seconds around
 * the playhead. When there is none — the user is over a stretch the generator has no
 * opinion about — it falls back to a default-length region at the playhead, which is
 * the *place by hand* verb arriving through the same door.
 */
export function overrideZoomOps(
  doc: EditDocument,
  init: {
    atSec: Seconds;
    seed: { amount: number; center: Vec2 };
    span?: { startSec: Seconds; endSec: Seconds } | null;
  },
  sourceDurationSec: Seconds,
): EditOp[] | null {
  const span = init.span ?? null;
  const startSec = span?.startSec ?? init.atSec - ZOOM_RAMP_SEC;
  const endSec = span?.endSec ?? init.atSec + DEFAULT_HOLD_SEC + ZOOM_RAMP_SEC;
  // A generator that is at identity where the playhead is — between two auto-zoom
  // segments, or a cursor-follow track carrying only `center` — seeds a magnification
  // of 1, and a "zoom" that magnifies nothing is not what the button says. The seed
  // is what stops the picture jumping; it is not a reason to place a no-op.
  const amount = init.seed.amount > MIN_ZOOM_AMOUNT + 1e-6 ? init.seed.amount : DEFAULT_ZOOM_AMOUNT;
  return placeZoomOps(
    doc,
    { startSec, endSec, amount, center: init.seed.center },
    sourceDurationSec,
  );
}

/**
 * The window of a generated zoom track that covers `atSec`, or `null`.
 *
 * A generated track's `activeRanges` **is** its segment list — §6.5 sets it to the
 * merged segments — so this is a read of the document rather than a re-derivation of
 * anything the generator decided.
 */
export function generatedSegmentAt(
  track: Track,
  atSec: Seconds,
): { startSec: Seconds; endSec: Seconds } | null {
  for (const [start, end] of track.activeRanges) {
    if (atSec >= start && atSec <= end) return { startSec: start, endSec: end };
  }
  return null;
}

// ---------------------------------------------------------------- keyframes

/** One keyframe on one channel, addressed the way §2.7's ops address it. */
export interface KeyRef {
  trackId: string;
  channel: string;
  t: Seconds;
}

/** A keyframe and where it sits, for a lane that draws them and an inspector that edits one. */
export interface KeyView extends KeyRef {
  key: Keyframe;
  /** `false` for a key on a generated track — see {@link isKeyEditable}. */
  editable: boolean;
}

/**
 * Every zoom keyframe in the document, in time order, with its provenance.
 *
 * Source-domain zoom tracks only, for `timeline.ts`'s reason: a `timeline`-domain
 * track describes the *output* (§3.2) and its keys are not at these coordinates, so
 * drawing them on a source-time ruler would put them under the wrong frames.
 */
export function zoomKeysOf(doc: EditDocument): KeyView[] {
  const out: KeyView[] = [];
  for (const track of doc.tracks) {
    if (track.target !== 'zoom' || !track.enabled || track.domain !== 'source') continue;
    const editable = isKeyEditable(track);
    for (const [channel, value] of Object.entries(track.channels)) {
      for (const key of value.keys) {
        out.push({ trackId: track.id, channel, t: key.t, key, editable });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * May a keyframe on this track be edited in place?
 *
 * Only on a track a regeneration will not overwrite. §3.5: *"Regeneration rewrites
 * only the generated track. User edits survive by construction, because they were
 * never in that track."* Letting a person drag a key on a live generated track would
 * make that sentence false — the edit would sit in the one place the next
 * *Regenerate* is licensed to throw away, and it would be thrown away silently.
 *
 * A **baked** track is editable, and that is the whole point of §3.5's bake: it is
 * `origin: 'manual'` with the spec kept as `generatedFrom` provenance and no
 * `generator` block, so it is detached from regeneration and its keys are the user's.
 */
export function isKeyEditable(track: Track): boolean {
  return track.origin === 'manual';
}

/**
 * The ops that move one key in time, or `null` when it would change nothing.
 *
 * `key.remove` then `key.set`, in that order and in one batch — one undo step, and
 * one revision. The order matters for a reason `setKey` makes easy to miss: a
 * `key.set` at a `t` that already has a key **replaces** it, so a move that landed on
 * a neighbour would delete that neighbour and report success. {@link neighbourBounds}
 * is what keeps it from ever landing there, and it is applied here rather than in the
 * caller so no control can skip it.
 *
 * ## And the key stays inside its own `activeRanges` window
 *
 * The neighbour bound alone is not enough, and what it leaves open corrupts a
 * document silently. The first `amount` key of the first manual region has no
 * neighbour before it, so its `lowSec` is 0 and a drag could take it **earlier than
 * the window** {@link buildManualZoomTrack} wrote for that region. {@link
 * zoomRegionsOf} then filters it out, the region reads back with three keys and a
 * `startSec` of its hold, the lane's band no longer matches the window, and the next
 * region-level edit — {@link updateZoomOps} or {@link removeZoomOps}, which rebuild
 * the whole track from the read-back regions — writes that misreading in. The user
 * has no way to see any of it happen.
 *
 * So the bound is the **intersection** of the neighbour gap and the window the key
 * lives in, and it is inclusive at both ends because `zoomRegionsOf`'s own filter is:
 * a key clamped exactly onto its window edge is still one of that region's keys. A
 * key on a track with no window over it — anything this editor did not write — keeps
 * the neighbour bound alone.
 */
export function moveKeyOps(doc: EditDocument, ref: KeyRef, toSec: Seconds): EditOp[] | null {
  const track = doc.tracks.find((t) => t.id === ref.trackId);
  if (track === undefined || !isKeyEditable(track)) return null;
  const channel = track.channels[ref.channel];
  if (channel === undefined) return null;
  const key = channel.keys.find((k) => k.t === ref.t);
  if (key === undefined) return null;
  const bounds = keyBounds(track, channel.keys, ref.t);
  if (bounds.lowSec > bounds.highSec) return null;
  const t = clamp(toSec, bounds.lowSec, bounds.highSec);
  if (t === ref.t || !Number.isFinite(t)) return null;
  return [
    { op: 'key.remove', trackId: ref.trackId, channel: ref.channel, t: ref.t },
    { op: 'key.set', trackId: ref.trackId, channel: ref.channel, key: { ...key, t } },
  ];
}

/** The ops that change one key's value. `null` when the track is not the user's to edit. */
export function setKeyValueOps(
  doc: EditDocument,
  ref: KeyRef,
  value: number | number[],
): EditOp[] | null {
  const track = doc.tracks.find((t) => t.id === ref.trackId);
  if (track === undefined || !isKeyEditable(track)) return null;
  const key = track.channels[ref.channel]?.keys.find((k) => k.t === ref.t);
  if (key === undefined) return null;
  if (sameValue(key.v, value)) return null;
  return [{ op: 'key.set', trackId: ref.trackId, channel: ref.channel, key: { ...key, v: value } }];
}

/**
 * The ops that delete one key.
 *
 * Refused when it would leave the channel with fewer than two keys, which is not
 * tidiness: a spring channel with one key is a step from rest to that key and stays
 * there for the rest of the recording, so deleting the third of four `amount` keys is
 * an edit and deleting the last two is a zoom that never comes back. The region-level
 * {@link removeZoomOps} is how a person removes a whole zoom, and it says so.
 */
export function removeKeyOps(doc: EditDocument, ref: KeyRef): EditOp[] | null {
  const track = doc.tracks.find((t) => t.id === ref.trackId);
  if (track === undefined || !isKeyEditable(track)) return null;
  const channel = track.channels[ref.channel];
  if (channel === undefined || channel.keys.length <= 2) return null;
  if (!channel.keys.some((k) => k.t === ref.t)) return null;
  return [{ op: 'key.remove', trackId: ref.trackId, channel: ref.channel, t: ref.t }];
}

/**
 * How far a key may travel before it would collide with a neighbour.
 *
 * §2.6 requires keys sorted by `t` with **unique** `t`, and `validateEditDocument`
 * enforces it, so the bound is not a nicety — a document that breaks it is one that
 * stops opening. {@link KEY_GAP_SEC} keeps a strict inequality reachable in floating
 * point: clamping to the neighbour exactly would produce an equal `t`, which
 * `setKey` treats as a replacement.
 */
export function neighbourBounds(
  keys: readonly Keyframe[],
  t: Seconds,
): { lowSec: Seconds; highSec: Seconds } {
  const at = keys.findIndex((key) => key.t === t);
  const before = at > 0 ? keys[at - 1]?.t : undefined;
  const after = at >= 0 && at + 1 < keys.length ? keys[at + 1]?.t : undefined;
  return {
    lowSec: before === undefined ? 0 : before + KEY_GAP_SEC,
    highSec: after === undefined ? Number.POSITIVE_INFINITY : after - KEY_GAP_SEC,
  };
}

/**
 * How far a key may travel: its neighbours, and the window it belongs to.
 *
 * The two constraints are independent and both are the user's — one keeps §2.6's
 * unique, strictly ordered `t`, the other keeps the key inside the region it is part
 * of. {@link moveKeyOps} argues why the second is not optional.
 */
export function keyBounds(
  track: Track,
  keys: readonly Keyframe[],
  t: Seconds,
): { lowSec: Seconds; highSec: Seconds } {
  const bounds = neighbourBounds(keys, t);
  const window = windowContaining(track, t);
  if (window === null) return bounds;
  return {
    lowSec: Math.max(bounds.lowSec, window[0]),
    highSec: Math.min(bounds.highSec, window[1]),
  };
}

/**
 * The `activeRanges` entry a key sits in, or `null`.
 *
 * The `1e-9` on the lower edge is {@link zoomRegionsOf}'s own tolerance, restated
 * rather than shared so a key this answers "inside" is exactly a key that filter
 * keeps: the first key of a region sits *on* its window start, and a bound that
 * disagreed with the reader by one float would drop a key from its own region.
 */
function windowContaining(track: Track, t: Seconds): readonly [number, number] | null {
  for (const range of track.activeRanges) {
    if (t >= range[0] - 1e-9 && t <= range[1]) return [range[0], range[1]];
  }
  return null;
}

/**
 * The least gap between two keys a drag may leave.
 *
 * A millisecond, which is an eighth of §3.4's 8 ms spring grid — so two keys this
 * close land in the same grid cell and the spring cannot tell them apart, but the
 * document is still valid and the user's intent (they are adjacent) is preserved
 * rather than refused.
 */
export const KEY_GAP_SEC = 0.001;

// ---------------------------------------------------------------- internals

function asInput(region: ZoomRegion): ZoomRegionInput {
  return {
    startSec: region.startSec,
    endSec: region.endSec,
    amount: region.amount,
    center: [region.center[0], region.center[1]],
  };
}

function overlaps(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * A requested region held inside the recording and inside the model's own bounds.
 *
 * `null` when there is nothing legal left — a request entirely past the end of the
 * recording, or one with no room for the two ramps and the minimum hold. Refusing is
 * the honest answer: a region silently moved to somewhere it fits is a zoom on the
 * wrong moment.
 */
function clampRegion(input: ZoomRegionInput, sourceDurationSec: Seconds): ZoomRegionInput | null {
  const duration = Math.max(0, sourceDurationSec);
  const shortest = 2 * ZOOM_RAMP_SEC + MIN_HOLD_SEC;
  if (!(duration >= shortest)) return null;
  // `startSec` is held at `duration - shortest` at the latest, so the low bound the
  // line below clamps `endSec` against is never past the end of the recording — which
  // is what makes a region asked for at the very end keep its length and slide
  // earlier rather than shrink below the two ramps and the minimum hold. It is the
  // *first* clamp that produces that, not the second.
  const startSec = clamp(input.startSec, 0, duration - shortest);
  const endSec = clamp(input.endSec, startSec + shortest, duration);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
  const amount = clamp(
    Number.isFinite(input.amount) ? input.amount : DEFAULT_ZOOM_AMOUNT,
    MIN_ZOOM_AMOUNT,
    MAX_ZOOM_AMOUNT,
  );
  // §6.5 step 3, and the same function: the zoomed viewport is `1/amount` of the
  // frame, so a centre nearer an edge than half of that shows letterbox the
  // compositor would clamp away anyway (`sourceSampleRect`). Snapping here means the
  // number in the document is the number that will be used.
  const raw: Vec2 = [
    Number.isFinite(input.center[0]) ? input.center[0] : 0.5,
    Number.isFinite(input.center[1]) ? input.center[1] : 0.5,
  ];
  const center = edgeSnap(raw, amount, EDGE_SNAP_RATIO);
  return { startSec, endSec, amount, center: [center[0], center[1]] };
}

/**
 * The whole track, rewritten — as `track.remove` + `track.add` **at the same index**,
 * or one `track.add` when there was none.
 *
 * Not `key.set` per key. Changing a region moves four keys on `amount` and three on
 * `center` and the window under them, and expressing that as a dozen ops makes the
 * batch's inverse a dozen ops that have to be applied in exactly the right order to
 * pass validation at every intermediate step — `applyOps` walks them one at a time.
 * A whole-track replacement is one op pair whose inverse `inverse.ts` already
 * computes exactly (`track.add` carries `at`, because **track order is stacking
 * order**), and §3.5's own regeneration is written the same way for the same reason.
 *
 * The index is where the track already is, or the **end** of the array for a new one.
 * The end is the top of the stack (`resolve` folds in array order and `replace` wins),
 * which is §3.5's *"the user's manual zoom keyframes sit above"* — and it is the whole
 * of how the captain's manual option beats the generator without a stacking UI.
 */
function rewriteTrackOps(
  doc: EditDocument,
  existing: Track | null,
  windows: readonly [number, number][],
  regions: readonly ZoomRegionInput[],
): EditOp[] {
  const track = buildManualZoomTrack(windows, regions);
  if (existing === null) return [{ op: 'track.add', track, at: doc.tracks.length }];
  const at = doc.tracks.indexOf(existing);
  return [
    { op: 'track.remove', trackId: existing.id },
    { op: 'track.add', track, at: at < 0 ? doc.tracks.length : at },
  ];
}

/**
 * The manual zoom track for a set of regions.
 *
 * §6.5 step 5's shape, region by region: four keys on `amount` (1 → A → A → 1) and
 * three on `center` (identity → the user's centre → identity), every one of them
 * `ease: 'spring'` over {@link DEFAULT_SPRING}. Springing the centre back to the
 * middle as the amount returns to 1 is what stops the frame sliding sideways while it
 * zooms out — `auto-zoom.ts` argues it and this is the same geometry.
 */
export function buildManualZoomTrack(
  windows: readonly [number, number][],
  regions: readonly ZoomRegionInput[],
): Track {
  const spring: SpringParams = { ...DEFAULT_SPRING };
  const amount: Keyframe[] = [];
  const center: Keyframe[] = [];
  for (const region of regions) {
    const holdStart = region.startSec + ZOOM_RAMP_SEC;
    const holdEnd = Math.max(holdStart + MIN_HOLD_SEC, region.endSec - ZOOM_RAMP_SEC);
    push(amount, { t: region.startSec, v: 1, ease: { kind: 'spring' } });
    push(amount, { t: holdStart, v: region.amount, ease: { kind: 'spring' } });
    push(amount, { t: holdEnd, v: region.amount, ease: { kind: 'spring' } });
    push(amount, { t: region.endSec, v: 1, ease: { kind: 'spring' } });

    push(center, { t: region.startSec, v: [0.5, 0.5], ease: { kind: 'spring' } });
    push(center, {
      t: holdStart,
      v: [region.center[0], region.center[1]],
      ease: { kind: 'spring' },
    });
    push(center, { t: region.endSec, v: [0.5, 0.5], ease: { kind: 'spring' } });
  }
  return manualZoomTrack({
    id: MANUAL_ZOOM_TRACK_ID,
    activeRanges: windows.map((window) => [window[0], window[1]]),
    amount,
    center,
    spring,
    // §3.3's channel bound, written into the document so a hand-edited `amount` is
    // held by the model rather than by whichever control last wrote one.
    amountClamp: [MIN_ZOOM_AMOUNT, MAX_ZOOM_AMOUNT],
  });
}

/** Append, keeping `t` strictly increasing — §2.6 requires it and validation enforces it. */
function push(keys: Keyframe[], key: Keyframe): void {
  const last = keys[keys.length - 1];
  if (last !== undefined && key.t <= last.t) return;
  keys.push(key);
}

/** Would rewriting produce the track that is already there? Then it is not an edit. */
function sameLayout(
  track: Track,
  windows: readonly [number, number][],
  regions: readonly ZoomRegionInput[],
): boolean {
  return JSON.stringify(track) === JSON.stringify(buildManualZoomTrack(windows, regions));
}

function sameValue(a: number | number[], b: number | number[]): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => value === b[i]);
  }
  return a === b;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
