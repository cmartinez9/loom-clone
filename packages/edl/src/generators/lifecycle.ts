/**
 * §3.5's second half: how a generated track is replaced, and how it stops being one.
 *
 * > The generator block records a fingerprint of its inputs … If the cursor log's hash
 * > no longer matches, the UI shows "regenerate" rather than silently serving stale
 * > motion.
 * >
 * > **"Bake"** is the escape hatch, not a mode: one command converts a generated track
 * > to `origin: 'manual'`, keeps the spec as `generatedFrom` provenance, and detaches
 * > it from regeneration. That is the whole story. There is no third state, no partial-
 * > override merge, and no "your edit was overwritten" bug — because the two never
 * > share storage.
 *
 * ## Why these are ops and not object surgery
 *
 * Everything here returns `EditOp[]`, the §2.7 vocabulary main journals. A
 * regeneration that mutated the document in place would be invisible to
 * `edit.journal.ndjson`, so an editor crash 200 ms later would come back with the old
 * track; and it would be invisible to `EditHistory`, so it could not be undone. Going
 * through the ops means a regeneration and a bake are crash-safe and undoable for the
 * same reason every other edit is, on exactly the same path.
 *
 * ## Track order is stacking order, so a replacement keeps its index
 *
 * `AGENTS.md` states it and `track.add` carries `at` for it: *"undoing the removal of
 * a middle track by appending leaves a valid document and a wrong picture"*. A
 * regeneration is a removal and an add, and the add names the index the removal took —
 * otherwise regenerating the cursor-follow track that sat under the user's manual zoom
 * would put it on top of it, and the manual keyframes would stop winning (§3.5).
 */

import type { EditDocument, EditOp, GeneratorSpec, Track } from '@loom/format';

/** Why a generated track's output no longer matches what it was generated from. */
export type StaleReason =
  /** The track has no `generator` block — it is manual, or it was baked. */
  | 'not-generated'
  /** An input the spec named is absent from the current fingerprints. */
  | 'input-missing'
  /** An input's digest differs from the one recorded. */
  | 'input-changed'
  /** A parameter differs from the one the caller would generate with now. */
  | 'params-changed';

export interface StalenessReport {
  stale: boolean;
  reasons: StaleReason[];
  /** Input names whose digest no longer matches, or which are gone. */
  changedInputs: string[];
  /** Parameter names whose value differs from the comparison set. */
  changedParams: string[];
}

const FRESH: StalenessReport = {
  stale: false,
  reasons: [],
  changedInputs: [],
  changedParams: [],
};

function sameParam(a: number | number[] | undefined, b: number | number[] | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => Object.is(value, b[i]));
  }
  return Object.is(a, b);
}

/**
 * Is this generated track still a faithful function of its inputs?
 *
 * `inputs` is the caller's current fingerprint set — `{ cursor: 'sha256:…', clicks:
 * 'sha256:…' }` — read off the files on disk. Only the inputs the *spec* named are
 * compared: an auto-zoom track is not stale because a cursor log it never read has
 * changed. `params` is optional and compares the settings the caller would generate
 * with now, which is what makes "you changed the rest box" show the same *regenerate*
 * affordance as "the log changed" rather than a silently different picture.
 */
export function generatedTrackStaleness(
  track: Track,
  inputs: Readonly<Record<string, string>>,
  params?: Readonly<Record<string, number | number[]>>,
): StalenessReport {
  const spec = track.generator;
  if (spec === undefined) {
    return { stale: true, reasons: ['not-generated'], changedInputs: [], changedParams: [] };
  }

  const reasons = new Set<StaleReason>();
  const changedInputs: string[] = [];
  for (const [name, digest] of Object.entries(spec.inputs)) {
    const current = inputs[name];
    if (current === undefined) {
      reasons.add('input-missing');
      changedInputs.push(name);
    } else if (current !== digest) {
      reasons.add('input-changed');
      changedInputs.push(name);
    }
  }

  const changedParams: string[] = [];
  if (params !== undefined) {
    const names = new Set([...Object.keys(spec.params), ...Object.keys(params)]);
    for (const name of names) {
      if (!sameParam(spec.params[name], params[name])) {
        reasons.add('params-changed');
        changedParams.push(name);
      }
    }
  }

  if (reasons.size === 0) return FRESH;
  return { stale: true, reasons: [...reasons], changedInputs, changedParams };
}

/** Every generated track on a target, in stacking order, with its document index. */
export function generatedTracks(
  doc: EditDocument,
  type?: GeneratorSpec['type'],
): { index: number; track: Track }[] {
  const out: { index: number; track: Track }[] = [];
  doc.tracks.forEach((track, index) => {
    if (track.origin !== 'generated' || track.generator === undefined) return;
    if (type !== undefined && track.generator.type !== type) return;
    out.push({ index, track });
  });
  return out;
}

/**
 * Replace a generated track with a freshly generated one, in place.
 *
 * *"Regeneration rewrites only the generated track. User edits survive by
 * construction, because they were never in that track."* — so this is exactly two ops
 * and touches nothing else. When there is no track of that generator type yet, it is
 * one `track.add`: at `at`, if the caller says where, and otherwise at the bottom of
 * the stack, which is where §3.5 puts a generated track (*"A **generated**
 * cursor-follow track sits at the bottom"*).
 */
export function regenerateOps(
  doc: EditDocument,
  replacement: Track,
  options: { type?: GeneratorSpec['type']; at?: number } = {},
): EditOp[] {
  const type = options.type ?? replacement.generator?.type;
  const existing = doc.tracks.findIndex(
    (track) =>
      track.id === replacement.id ||
      (track.origin === 'generated' && type !== undefined && track.generator?.type === type),
  );
  if (existing < 0) {
    const at = options.at ?? 0;
    return [{ op: 'track.add', track: replacement, at }];
  }
  return [
    { op: 'track.remove', trackId: doc.tracks[existing]?.id ?? replacement.id },
    { op: 'track.add', track: replacement, at: options.at ?? existing },
  ];
}

/**
 * §3.5's bake, as one op.
 *
 * `origin: 'manual'`, the spec moved to `generatedFrom`, the `generator` block
 * **removed** — and removed by name, in `patch.remove`, because a key set to
 * `undefined` is dropped by `JSON.stringify` and would reach `edit.journal.ndjson` as
 * `"patch":{}`. That is `AGENTS.md`'s "an undo has to survive `JSON.stringify`" in the
 * one place it was written for: the inverse of adding a `generator` block is a
 * document without one.
 */
export function bakeOps(track: Track): EditOp[] {
  const spec = track.generator;
  if (spec === undefined) return [];
  return [
    {
      op: 'track.patch',
      trackId: track.id,
      patch: { origin: 'manual', generatedFrom: spec, remove: ['generator'] },
    },
  ];
}

/** The baked track itself, for a caller that wants the object rather than the op. */
export function bakeTrack(track: Track): Track {
  const spec = track.generator;
  if (spec === undefined) return track;
  const { generator: _generator, ...rest } = track;
  return { ...rest, origin: 'manual', generatedFrom: spec };
}

/**
 * Is this track still attached to a generator?
 *
 * The one predicate the editor needs: a baked track has `generatedFrom` and no
 * `generator`, and must never be offered a *regenerate* — that is what "detached from
 * regeneration" means and it is the whole difference between the two states.
 */
export function isRegenerable(track: Track): boolean {
  return track.origin === 'generated' && track.generator !== undefined;
}
