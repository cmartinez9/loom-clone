/**
 * Applying edit ops to an `EditDocument`. Pure — no I/O, no clock, no randomness.
 *
 * The same function serves both properties the journal buys us: live editing calls
 * it with the ops the editor just sent, and crash recovery calls it with the ops it
 * finds on disk. If those two paths could ever disagree the journal would be
 * decorative, so there is exactly one implementation.
 */

import type { Channel, EditDocument, Keyframe, Span, Track } from '../types/edit.ts';
import type { EditOp } from './ops.ts';

export class OpApplyError extends Error {
  readonly op: EditOp;
  constructor(message: string, op: EditOp) {
    super(message);
    this.name = 'OpApplyError';
    this.op = op;
  }
}

function findTrack(doc: EditDocument, trackId: string, op: EditOp): Track {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (track === undefined)
    throw new OpApplyError(`no track with id ${JSON.stringify(trackId)}`, op);
  return track;
}

/**
 * Insert or replace a keyframe, keeping `keys` sorted by `t` with unique `t`.
 *
 * Timestamps are compared exactly. The editor sends back the `t` it read, so exact
 * comparison is what "move this key" means; a tolerance here would silently merge
 * two keys a user placed four milliseconds apart.
 */
function setKey(channel: Channel, key: Keyframe): void {
  const at = channel.keys.findIndex((k) => k.t === key.t);
  if (at >= 0) {
    channel.keys[at] = key;
    return;
  }
  const insertAt = channel.keys.findIndex((k) => k.t > key.t);
  if (insertAt < 0) channel.keys.push(key);
  else channel.keys.splice(insertAt, 0, key);
}

function upsertSpan(track: Track, span: Span): void {
  const spans = (track.spans ??= []);
  const at = spans.findIndex((s) => s.id === span.id);
  if (at >= 0) spans[at] = span;
  else spans.push(span);
}

/** Apply one op **in place**. Callers own cloning; see {@link applyOps}. */
export function applyOpInPlace(doc: EditDocument, op: EditOp): void {
  switch (op.op) {
    case 'track.add': {
      if (doc.tracks.some((t) => t.id === op.track.id)) {
        throw new OpApplyError(`track ${JSON.stringify(op.track.id)} already exists`, op);
      }
      doc.tracks.push(op.track);
      return;
    }
    case 'track.remove': {
      const at = doc.tracks.findIndex((t) => t.id === op.trackId);
      if (at < 0) throw new OpApplyError(`no track with id ${JSON.stringify(op.trackId)}`, op);
      doc.tracks.splice(at, 1);
      return;
    }
    case 'track.patch': {
      const track = findTrack(doc, op.trackId, op);
      // `id` and `kind` are excluded by TrackPatch's type; strip them again here
      // because a journal line is data from disk, not a value the compiler saw.
      const { id: _id, kind: _kind, ...patch } = op.patch as Record<string, unknown>;
      void _id;
      void _kind;
      Object.assign(track, patch);
      return;
    }
    case 'key.set': {
      const track = findTrack(doc, op.trackId, op);
      const channel = (track.channels[op.channel] ??= { keys: [] });
      setKey(channel, op.key);
      return;
    }
    case 'key.remove': {
      const track = findTrack(doc, op.trackId, op);
      const channel = track.channels[op.channel];
      if (channel === undefined) {
        throw new OpApplyError(`track ${op.trackId} has no channel ${op.channel}`, op);
      }
      const at = channel.keys.findIndex((k) => k.t === op.t);
      if (at < 0) {
        throw new OpApplyError(`no key at t=${String(op.t)} on ${op.trackId}.${op.channel}`, op);
      }
      channel.keys.splice(at, 1);
      return;
    }
    case 'span.set': {
      upsertSpan(findTrack(doc, op.trackId, op), op.span);
      return;
    }
    case 'span.remove': {
      const track = findTrack(doc, op.trackId, op);
      const spans = track.spans;
      const at = spans?.findIndex((s) => s.id === op.spanId) ?? -1;
      if (spans === undefined || at < 0) {
        throw new OpApplyError(`no span with id ${JSON.stringify(op.spanId)}`, op);
      }
      spans.splice(at, 1);
      return;
    }
    case 'clips.set': {
      doc.clips = op.clips;
      return;
    }
  }
}

/**
 * Apply a batch of ops to a copy of `doc`, advancing `revision` by one per op.
 *
 * Throws on the first op that cannot apply, leaving the caller's document
 * untouched — a rejected batch must never half-land.
 */
export function applyOps(doc: EditDocument, ops: readonly EditOp[]): EditDocument {
  const next = structuredClone(doc);
  for (const op of ops) {
    applyOpInPlace(next, op);
    next.revision += 1;
  }
  return next;
}
