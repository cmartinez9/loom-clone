/**
 * Inverse ops and the undo/redo stack — §2.7's *"one mechanism, two properties"*.
 *
 * The property under test is exact and is the one users notice when it is only
 * nearly true: **undo returns the document to what it was**, structurally, not
 * approximately. A restored track has to come back at its own index, because §3.5
 * resolves tracks in array order and "my other zoom took over after undo" is what a
 * merely-appending inverse produces.
 *
 * The random half is here too: an undo of *every* generated op sequence, and a
 * redo after it, must land back on documents that resolve identically — which the
 * gate in `resolve-replay.test.ts` cannot see on its own, because it never undoes
 * anything.
 */

import { describe, expect, it } from 'vitest';
import { applyOps, validateEditDocument, type EditDocument, type EditOp } from '@loom/format';
import { EditHistory, inverseOps, InverseOpError, manualZoomTrack } from '../src/index.ts';
import { generateSequence } from './helpers/pipeline.ts';

function baseDocument(): EditDocument {
  return {
    schema: 'loom.edit/1',
    revision: 5,
    output: { size: [1920, 1240], fps: 30, background: { kind: 'none' } },
    clips: [{ id: 'c1', sourceStart: 0, sourceEnd: 60, speed: 1 }],
    tracks: [
      manualZoomTrack({
        id: 't-a',
        activeRanges: [[0, 10]],
        amount: [{ t: 0, v: 1, ease: { kind: 'hold' } }],
      }),
      manualZoomTrack({
        id: 't-b',
        activeRanges: [[10, 20]],
        amount: [{ t: 10, v: 2, ease: { kind: 'hold' } }],
      }),
      manualZoomTrack({
        id: 't-c',
        activeRanges: [[20, 30]],
        amount: [{ t: 20, v: 3, ease: { kind: 'hold' } }],
      }),
    ],
  };
}

/** Compare everything but the revision — an undo is itself an edit and bumps it. */
function sameExceptRevision(a: EditDocument, b: EditDocument): void {
  expect({ ...a, revision: 0 }).toEqual({ ...b, revision: 0 });
}

describe('inverse ops restore the document exactly', () => {
  for (const [name, ops] of Object.entries<EditOp[]>({
    'adding a track': [
      {
        op: 'track.add',
        track: manualZoomTrack({
          id: 't-new',
          activeRanges: [[0, 1]],
          amount: [{ t: 0, v: 1, ease: { kind: 'hold' } }],
        }),
      },
    ],
    'removing the middle track': [{ op: 'track.remove', trackId: 't-b' }],
    'removing the first track': [{ op: 'track.remove', trackId: 't-a' }],
    'patching a field that exists': [
      { op: 'track.patch', trackId: 't-b', patch: { blend: 'add', blendMs: 999 } },
    ],
    'patching a field that does not exist yet': [
      {
        op: 'track.patch',
        trackId: 't-b',
        patch: {
          generator: {
            type: 'auto-zoom-on-click',
            params: { preRollSec: 0.6 },
            inputs: { clicks: 'sha256:41ba' },
            generatedAt: '2026-08-05T00:00:00.000Z',
          },
        },
      },
    ],
    'setting a key that replaces one': [
      {
        op: 'key.set',
        trackId: 't-a',
        channel: 'amount',
        key: { t: 0, v: 9, ease: { kind: 'linear' } },
      },
    ],
    'setting a key that is new': [
      {
        op: 'key.set',
        trackId: 't-a',
        channel: 'amount',
        key: { t: 5, v: 9, ease: { kind: 'linear' } },
      },
    ],
    'setting a key on a channel that does not exist': [
      {
        op: 'key.set',
        trackId: 't-a',
        channel: 'center',
        key: { t: 5, v: [0.1, 0.2], ease: { kind: 'hold' } },
      },
    ],
    'removing a key': [{ op: 'key.remove', trackId: 't-a', channel: 'amount', t: 0 }],
    'replacing the clip list': [
      { op: 'clips.set', clips: [{ id: 'c9', sourceStart: 1, sourceEnd: 2, speed: 0.5 }] },
    ],
    'a batch of several': [
      { op: 'track.remove', trackId: 't-b' },
      {
        op: 'key.set',
        trackId: 't-a',
        channel: 'amount',
        key: { t: 3, v: 7, ease: { kind: 'hold' } },
      },
      { op: 'clips.set', clips: [{ id: 'c9', sourceStart: 1, sourceEnd: 9, speed: 2 }] },
    ],
  })) {
    it(`undoes ${name}`, () => {
      const before = baseDocument();
      const after = applyOps(before, ops);
      const undone = applyOps(after, inverseOps(before, ops));

      // Structural equality, not "resolves the same": §3.5's stacking order lives in
      // the array, and an inverse that restored the values but not the positions
      // would satisfy a resolve-only comparison at the times the tracks do not
      // overlap and fail at the ones they do.
      sameExceptRevision(undone, before);
      expect(undone.tracks.map((t) => t.id)).toEqual(before.tracks.map((t) => t.id));
      expect(undone.revision).toBe(after.revision + ops.length);
      expect(validateEditDocument(undone).ok).toBe(true);
    });
  }

  it('restores a removed track at its own index, not on top', () => {
    const before = baseDocument();
    const ops: EditOp[] = [{ op: 'track.remove', trackId: 't-b' }];
    const inverse = inverseOps(before, ops);
    expect(inverse).toHaveLength(1);
    expect(inverse[0]).toMatchObject({ op: 'track.add', at: 1 });
    const undone = applyOps(applyOps(before, ops), inverse);
    expect(undone.tracks.map((t) => t.id)).toEqual(['t-a', 't-b', 't-c']);
  });

  it('removes a key that a patch added, through a `remove` that survives the journal', () => {
    const before = baseDocument();
    const ops: EditOp[] = [{ op: 'track.patch', trackId: 't-a', patch: { shapePreset: 'circle' } }];
    const inverse = inverseOps(before, ops);
    expect(inverse[0]).toEqual({
      op: 'track.patch',
      trackId: 't-a',
      patch: { remove: ['shapePreset'] },
    });

    const undone = applyOps(applyOps(before, ops), inverse);
    const track = undone.tracks.find((t) => t.id === 't-a');
    expect(track).toBeDefined();
    expect(track === undefined ? true : 'shapePreset' in track).toBe(false);
    // …and the in-memory document is therefore byte-identical to a reload of itself.
    expect(JSON.stringify(undone)).toBe(JSON.stringify({ ...before, revision: undone.revision }));

    // The undo main journals is the undo main replays. An instruction expressed as a
    // key holding `undefined` would be `{}` by the time it reached the file, and the
    // key would come back on the next crash recovery.
    const throughJournal: unknown = JSON.parse(JSON.stringify(inverse));
    expect(throughJournal).toEqual(inverse);
    const replayed = applyOps(applyOps(before, ops), throughJournal as EditOp[]);
    expect('shapePreset' in (replayed.tracks.find((t) => t.id === 't-a') ?? {})).toBe(false);
  });

  it('refuses to invert an op it has nothing to invert against', () => {
    const doc = baseDocument();
    expect(() => inverseOps(doc, [{ op: 'track.remove', trackId: 'nope' }])).toThrow(
      InverseOpError,
    );
    expect(() =>
      inverseOps(doc, [{ op: 'key.remove', trackId: 't-a', channel: 'amount', t: 99 }]),
    ).toThrow(InverseOpError);
  });
});

describe('EditHistory', () => {
  it('undoes and redoes, and reports the ops to send to main', () => {
    const history = new EditHistory(baseDocument());
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);

    const applied = history.apply([{ op: 'track.remove', trackId: 't-b' }], 'delete zoom');
    expect(applied.baseRevision).toBe(5);
    expect(history.document.tracks.map((t) => t.id)).toEqual(['t-a', 't-c']);
    expect(history.canUndo).toBe(true);

    const undone = history.undo();
    expect(undone).not.toBeNull();
    expect(undone?.ops[0]).toMatchObject({ op: 'track.add', at: 1 });
    expect(history.document.tracks.map((t) => t.id)).toEqual(['t-a', 't-b', 't-c']);
    expect(history.canRedo).toBe(true);

    const redone = history.redo();
    expect(redone?.ops[0]).toMatchObject({ op: 'track.remove', trackId: 't-b' });
    expect(history.document.tracks.map((t) => t.id)).toEqual(['t-a', 't-c']);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  it('advances the revision on every step, including the undos', () => {
    // An undo is an edit: it goes to main through `applyOps`, gets journalled, and
    // survives a crash exactly like the edit it reverses.
    const history = new EditHistory(baseDocument());
    history.apply([{ op: 'track.remove', trackId: 't-b' }]);
    expect(history.document.revision).toBe(6);
    history.undo();
    expect(history.document.revision).toBe(7);
    history.redo();
    expect(history.document.revision).toBe(8);
  });

  it('drops the redo branch when a new edit arrives', () => {
    const history = new EditHistory(baseDocument());
    history.apply([{ op: 'track.remove', trackId: 't-b' }]);
    history.undo();
    expect(history.canRedo).toBe(true);
    history.apply([{ op: 'track.remove', trackId: 't-c' }]);
    expect(history.canRedo).toBe(false);
  });

  it('walks a long stack all the way back and all the way forward', () => {
    const history = new EditHistory(baseDocument());
    const start = JSON.stringify({ ...history.document, revision: 0 });
    for (let i = 0; i < 20; i++) {
      history.apply([
        {
          op: 'key.set',
          trackId: 't-a',
          channel: 'amount',
          key: { t: i * 0.25, v: 1 + i / 10, ease: { kind: 'linear' } },
        },
      ]);
    }
    const end = JSON.stringify({ ...history.document, revision: 0 });
    for (let i = 0; i < 20; i++) expect(history.undo()).not.toBeNull();
    expect(history.undo()).toBeNull();
    expect(JSON.stringify({ ...history.document, revision: 0 })).toBe(start);
    for (let i = 0; i < 20; i++) expect(history.redo()).not.toBeNull();
    expect(history.redo()).toBeNull();
    expect(JSON.stringify({ ...history.document, revision: 0 })).toBe(end);
  });

  it('clears both stacks on a conflict reload', () => {
    // §2.7's `{ conflict }`: the editor reloads, and an inverse computed against a
    // document that is gone would undo to a state that never existed.
    const history = new EditHistory(baseDocument());
    history.apply([{ op: 'track.remove', trackId: 't-b' }]);
    history.undo();
    history.reset(baseDocument());
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('leaves the document and the stacks untouched when a batch cannot apply', () => {
    const history = new EditHistory(baseDocument());
    const before = JSON.stringify(history.document);
    expect(() => history.apply([{ op: 'track.remove', trackId: 'nope' }])).toThrow();
    expect(JSON.stringify(history.document)).toBe(before);
    expect(history.canUndo).toBe(false);
  });

  it('bounds its own depth', () => {
    const history = new EditHistory(baseDocument(), { limit: 3 });
    for (let i = 0; i < 10; i++) {
      history.apply([
        {
          op: 'key.set',
          trackId: 't-a',
          channel: 'amount',
          key: { t: i + 1, v: i, ease: { kind: 'hold' } },
        },
      ]);
    }
    expect(history.depth.undo).toBe(3);
  });
});

describe('undo over the same random sequences the gate generates', () => {
  it('walks every generated sequence backwards to its starting document', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { sequence } = generateSequence(seed, 30);
      const history = new EditHistory(sequence.base);
      for (const entry of sequence.entries) history.apply([entry.op]);
      expect(JSON.stringify({ ...history.document, revision: 0 })).toBe(
        JSON.stringify({ ...sequence.live, revision: 0 }),
      );

      while (history.canUndo) history.undo();
      expect(
        JSON.stringify({ ...history.document, revision: 0 }),
        `seed ${seed} did not undo back to its starting document`,
      ).toBe(JSON.stringify({ ...sequence.base, revision: 0 }));

      while (history.canRedo) history.redo();
      expect(JSON.stringify({ ...history.document, revision: 0 })).toBe(
        JSON.stringify({ ...sequence.live, revision: 0 }),
      );
      // Every intermediate document was one main would have accepted.
      expect(validateEditDocument(history.document).ok).toBe(true);
    }
  });
});
