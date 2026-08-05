/**
 * The edit operation log. Architecture report §2.7.
 *
 * > The editor holds the `EditDocument` in memory and sends *ops*, not documents.
 * > Main appends each op to `edit.journal.ndjson` (batched `fsync` at 250 ms) and
 * > writes a full `edit.json` snapshot on a 2-second debounce, truncating the
 * > journal after. On load: read `edit.json`, replay any journal entries with
 * > `revision > edit.json.revision`. Undo/redo is the inverse-op stack in the
 * > editor; crash-safety is the journal in main. One mechanism, two properties.
 *
 * **One op per journal line, and one revision per op.** The report's `applyOps`
 * returns a single `{ revision }`, which is the revision after the last op in the
 * batch. Giving every op its own revision is what makes "replay entries with
 * `revision > edit.json.revision`" exact rather than approximate, and it costs
 * nothing: the journal is truncated every two seconds.
 */

import type { Clip, Keyframe, Span, Track } from '../types/edit.ts';
import type { IsoTimestamp, Seconds } from '../types/common.ts';
import type { SchemaId } from '../schema.ts';

/**
 * The keys a patch may take *off* a track: the optional ones, and only those.
 *
 * Derived from `Track` rather than listed, so a field that stops being optional —
 * or a new one that starts out optional — is a compile error in
 * {@link REMOVABLE_TRACK_KEYS} rather than a removal the op vocabulary quietly
 * gained or lost.
 */
export type RemovableTrackKey = Exclude<
  { [K in keyof Track]-?: undefined extends Track[K] ? K : never }[keyof Track],
  'id' | 'kind'
>;

/** Exhaustive by construction: a missing key fails to satisfy the `Record`. */
const REMOVABLE: Record<RemovableTrackKey, true> = {
  generator: true,
  generatedFrom: true,
  spans: true,
  shapePreset: true,
  smoothing: true,
  clickSpring: true,
  hideWhenIdleSec: true,
};

export const REMOVABLE_TRACK_KEYS: readonly RemovableTrackKey[] = Object.keys(
  REMOVABLE,
) as RemovableTrackKey[];

export function isRemovableTrackKey(key: string): key is RemovableTrackKey {
  return Object.hasOwn(REMOVABLE, key);
}

/**
 * Fields of a track that a patch may change. `id` and `kind` are structural.
 *
 * **Removal is `remove`, a list of key names — never a key holding `undefined`.**
 * `JSON.stringify` drops an undefined-valued property, so a removal expressed that
 * way would apply in the editor's memory and reach `edit.journal.ndjson` as
 * `"patch":{}`: a crash before the next `edit.json` snapshot would replay the undo
 * as a no-op and the key the user removed would come back. `remove` is the same
 * instruction in memory and on disk, which is what makes the inverse of "add a
 * `generator` block" survive the journal it travels through.
 *
 * Only the *optional* fields are removable. A document without `domain` is not a
 * document — §3.2 has no inference to fall back on — so the values a patch may
 * carry have `undefined` excluded and {@link RemovableTrackKey} is the rest.
 */
export type TrackPatch = {
  [K in keyof Omit<Track, 'id' | 'kind'>]?: Exclude<Track[K], undefined>;
} & {
  /** Keys to delete. Applied after every assignment in the same patch. */
  remove?: RemovableTrackKey[];
};

export type EditOp =
  /**
   * `at` is the index to insert at; omitted means append.
   *
   * Track order **is** the stacking order — §3.5's *"tracks on the same `target`
   * stack, and the topmost track with an opinion wins"* — so an `add` that could
   * only append would make undoing the removal of a middle track silently change
   * which zoom wins. It is optional so that a journal line written without it, and
   * every ordinary "add a track" from the editor, still mean append.
   */
  | { op: 'track.add'; track: Track; at?: number }
  | { op: 'track.remove'; trackId: string }
  | { op: 'track.patch'; trackId: string; patch: TrackPatch }
  | { op: 'key.set'; trackId: string; channel: string; key: Keyframe }
  | { op: 'key.remove'; trackId: string; channel: string; t: Seconds }
  /** `at` places a *new* span; replacing an existing one keeps its position. */
  | { op: 'span.set'; trackId: string; span: Span; at?: number }
  | { op: 'span.remove'; trackId: string; spanId: string }
  | { op: 'clips.set'; clips: Clip[] };

export type EditOpKind = EditOp['op'];

export const EDIT_OP_KINDS: readonly EditOpKind[] = [
  'track.add',
  'track.remove',
  'track.patch',
  'key.set',
  'key.remove',
  'span.set',
  'span.remove',
  'clips.set',
];

/** The first line of `edit.journal.ndjson`, so the file carries a schema like every other. */
export interface JournalHeader {
  schema: SchemaId;
}

/** Every subsequent line. */
export interface JournalEntry {
  /** The document revision *after* this op is applied. Strictly increasing. */
  revision: number;
  at: IsoTimestamp;
  op: EditOp;
}

export function isEditOpKind(value: unknown): value is EditOpKind {
  return typeof value === 'string' && (EDIT_OP_KINDS as readonly string[]).includes(value);
}

/** An absent, or a non-negative integer, insertion index. */
function isOptionalIndex(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}

/**
 * Shape-check an op that came off disk or across IPC.
 *
 * Deliberately structural rather than deep: `track.add` carries a whole `Track`,
 * and the full document validator runs over the result of a replay anyway, which
 * is the check that actually matters.
 */
export function isEditOp(value: unknown): value is EditOp {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  if (!isEditOpKind(o['op'])) return false;
  switch (o['op']) {
    case 'track.add':
      return typeof o['track'] === 'object' && o['track'] !== null && isOptionalIndex(o['at']);
    case 'track.remove':
      return typeof o['trackId'] === 'string';
    case 'track.patch': {
      if (typeof o['trackId'] !== 'string') return false;
      const patch = o['patch'];
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return false;
      const remove = (patch as Record<string, unknown>)['remove'];
      // Which keys may go is `applyOpInPlace`'s refusal, with the op to name in it.
      // Here it is only the shape: a `remove` that is not a list of names is not an
      // op at all.
      return (
        remove === undefined ||
        (Array.isArray(remove) && remove.every((key) => typeof key === 'string'))
      );
    }
    case 'key.set':
      return (
        typeof o['trackId'] === 'string' &&
        typeof o['channel'] === 'string' &&
        typeof o['key'] === 'object' &&
        o['key'] !== null &&
        typeof (o['key'] as Record<string, unknown>)['t'] === 'number'
      );
    case 'key.remove':
      return (
        typeof o['trackId'] === 'string' &&
        typeof o['channel'] === 'string' &&
        typeof o['t'] === 'number' &&
        Number.isFinite(o['t'])
      );
    case 'span.set':
      return (
        typeof o['trackId'] === 'string' &&
        typeof o['span'] === 'object' &&
        o['span'] !== null &&
        typeof (o['span'] as Record<string, unknown>)['id'] === 'string' &&
        isOptionalIndex(o['at'])
      );
    case 'span.remove':
      return typeof o['trackId'] === 'string' && typeof o['spanId'] === 'string';
    case 'clips.set':
      return Array.isArray(o['clips']);
    default:
      return false;
  }
}
