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

/** Fields of a track that a patch may change. `id` and `kind` are structural. */
export type TrackPatch = Partial<Omit<Track, 'id' | 'kind'>>;

export type EditOp =
  | { op: 'track.add'; track: Track }
  | { op: 'track.remove'; trackId: string }
  | { op: 'track.patch'; trackId: string; patch: TrackPatch }
  | { op: 'key.set'; trackId: string; channel: string; key: Keyframe }
  | { op: 'key.remove'; trackId: string; channel: string; t: Seconds }
  | { op: 'span.set'; trackId: string; span: Span }
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
      return typeof o['track'] === 'object' && o['track'] !== null;
    case 'track.remove':
      return typeof o['trackId'] === 'string';
    case 'track.patch':
      return (
        typeof o['trackId'] === 'string' &&
        typeof o['patch'] === 'object' &&
        o['patch'] !== null &&
        !Array.isArray(o['patch'])
      );
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
        typeof (o['span'] as Record<string, unknown>)['id'] === 'string'
      );
    case 'span.remove':
      return typeof o['trackId'] === 'string' && typeof o['spanId'] === 'string';
    case 'clips.set':
      return Array.isArray(o['clips']);
    default:
      return false;
  }
}
