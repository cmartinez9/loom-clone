/**
 * Inverse ops — the other half of §2.7's *"one mechanism, two properties"*.
 *
 * > Main appends each op to `edit.journal.ndjson` … **Undo/redo is the inverse-op
 * > stack in the editor**; crash-safety is the journal in main. One mechanism, two
 * > properties.
 *
 * So undo is not a second representation of an edit and not a document snapshot: it
 * is the *same* `EditOp` vocabulary, pointed backwards. An undo travels to main
 * through `applyOps` exactly like the edit it reverses, lands in the journal exactly
 * like it, and survives a crash exactly like it. Nothing about undo needs the store
 * to know it is undo.
 *
 * ## The rule these obey
 *
 * `inverseOps(before, ops)` is computed against the document **as it stands before
 * the ops apply**, and the returned list is already reversed, so
 * `applyOps(applyOps(doc, ops), inverseOps(doc, ops))` is `doc` again — with the
 * revision advanced, which is the point: an undo is an edit.
 *
 * Three places where "again" is exact and worth saying out loud, because a weaker
 * inverse is the classic source of the "my other zoom took over after undo" bug:
 *
 *  - **Track order is stacking order.** §3.5 resolves tracks *"in array order"*, so
 *    the inverse of removing a middle track restores it at its index, via
 *    `track.add`'s `at`.
 *  - **A patch that added a key is undone by removing it**, not by setting it to
 *    `undefined` — `applyOpInPlace` deletes on an explicit `undefined` so that the
 *    document after an undo is the document before the edit, not a JSON-equivalent
 *    of it.
 *  - **A `key.set` that created a channel is undone by removing the channel**, not
 *    by removing the key. `key.remove` would leave `{ keys: [] }` behind — inert to
 *    `resolve` and accepted by validation, but a channel the editor would list and
 *    the user never made. §2.7's vocabulary has no `channel.remove`, so the inverse
 *    is a `track.patch` restoring the channel map as it was.
 */

import {
  applyOpInPlace,
  type Channel,
  type EditDocument,
  type EditOp,
  type Track,
  type TrackPatch,
} from '@loom/format';

export class InverseOpError extends Error {
  readonly op: EditOp;
  constructor(message: string, op: EditOp) {
    super(message);
    this.name = 'InverseOpError';
    this.op = op;
  }
}

function trackOf(doc: EditDocument, trackId: string, op: EditOp): Track {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (track === undefined) {
    throw new InverseOpError(`no track with id ${JSON.stringify(trackId)}`, op);
  }
  return track;
}

/**
 * The op that undoes `op`, computed against `doc` **before** `op` is applied.
 *
 * The captured fragments are deep copies: the caller is about to mutate the
 * document these came out of, and an inverse holding a live reference would undo to
 * whatever the value became rather than to what it was.
 */
export function inverseOp(doc: EditDocument, op: EditOp): EditOp {
  switch (op.op) {
    case 'track.add':
      return { op: 'track.remove', trackId: op.track.id };

    case 'track.remove': {
      const track = doc.tracks.find((t) => t.id === op.trackId);
      if (track === undefined) {
        throw new InverseOpError(`no track with id ${JSON.stringify(op.trackId)}`, op);
      }
      return { op: 'track.add', track: structuredClone(track), at: doc.tracks.indexOf(track) };
    }

    case 'track.patch': {
      const track = trackOf(doc, op.trackId, op);
      const before: TrackPatch = {};
      const fields = before as unknown as Record<string, unknown>;
      for (const key of Object.keys(op.patch)) {
        if (key === 'id' || key === 'kind') continue;
        const current = (track as unknown as Record<string, unknown>)[key];
        // `undefined` here is the instruction to remove the key on undo, which is
        // exactly right when the patch is adding one.
        fields[key] = current === undefined ? undefined : structuredClone(current);
      }
      return { op: 'track.patch', trackId: op.trackId, patch: before };
    }

    case 'key.set': {
      const track = trackOf(doc, op.trackId, op);
      const channel: Channel | undefined = track.channels[op.channel];
      if (channel === undefined) {
        // `key.set` creates the channel it is given. Undoing with `key.remove`
        // would leave an empty one behind — inert to `resolve` and to validation,
        // but a channel the editor would list and the user never made. Restoring
        // the whole map is the only op in §2.7's vocabulary that can remove one.
        return {
          op: 'track.patch',
          trackId: op.trackId,
          patch: { channels: structuredClone(track.channels) },
        };
      }
      const existing = channel.keys.find((k) => k.t === op.key.t);
      if (existing === undefined) {
        return { op: 'key.remove', trackId: op.trackId, channel: op.channel, t: op.key.t };
      }
      return {
        op: 'key.set',
        trackId: op.trackId,
        channel: op.channel,
        key: structuredClone(existing),
      };
    }

    case 'key.remove': {
      const track = trackOf(doc, op.trackId, op);
      const channel: Channel | undefined = track.channels[op.channel];
      const existing = channel?.keys.find((k) => k.t === op.t);
      if (existing === undefined) {
        throw new InverseOpError(
          `no key at t=${String(op.t)} on ${op.trackId}.${op.channel} to invert`,
          op,
        );
      }
      return {
        op: 'key.set',
        trackId: op.trackId,
        channel: op.channel,
        key: structuredClone(existing),
      };
    }

    case 'span.set': {
      const track = trackOf(doc, op.trackId, op);
      const spans = track.spans ?? [];
      const existing = spans.find((s) => s.id === op.span.id);
      if (existing === undefined) {
        return { op: 'span.remove', trackId: op.trackId, spanId: op.span.id };
      }
      return {
        op: 'span.set',
        trackId: op.trackId,
        span: structuredClone(existing),
        at: spans.indexOf(existing),
      };
    }

    case 'span.remove': {
      const track = trackOf(doc, op.trackId, op);
      const spans = track.spans ?? [];
      const existing = spans.find((s) => s.id === op.spanId);
      if (existing === undefined) {
        throw new InverseOpError(`no span with id ${JSON.stringify(op.spanId)} to invert`, op);
      }
      return {
        op: 'span.set',
        trackId: op.trackId,
        span: structuredClone(existing),
        at: spans.indexOf(existing),
      };
    }

    case 'clips.set':
      return { op: 'clips.set', clips: structuredClone(doc.clips) };
  }
}

/**
 * The batch that undoes `ops`, already in the order it must be applied.
 *
 * Each op's inverse is taken against the document as it stands *at that point in
 * the batch* — a batch that adds a track and then patches it has an inverse whose
 * patch was read after the add — and the whole list is reversed, because undoing a
 * sequence means undoing its last step first.
 */
export function inverseOps(doc: EditDocument, ops: readonly EditOp[]): EditOp[] {
  const walking = structuredClone(doc);
  const inverses: EditOp[] = [];
  for (const op of ops) {
    inverses.push(inverseOp(walking, op));
    applyOpInPlace(walking, op);
  }
  inverses.reverse();
  return inverses;
}
