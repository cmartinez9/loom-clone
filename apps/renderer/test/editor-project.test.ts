/**
 * The editor's half of §2.7: ops go to main, undo sends the inverse ops down the
 * same path, and a conflict reloads rather than merges.
 *
 * What this pins that reading the code does not: that a batch is never sent with a
 * `baseRevision` main will refuse, and that the two things which look like edits
 * and are not — a drag in progress, and an op that changes nothing — never reach
 * the wire. Both would be silent: an extra revision is invisible until the undo
 * that does nothing, and a self-conflict looks exactly like the two-window case
 * §2.7's conflict is actually for.
 */

import { describe, expect, it } from 'vitest';
import {
  applyOps,
  newEditDocument,
  type EditDocument,
  type EditOp,
  type RecordingDoc,
} from '@loom/format';
import { EditorProject } from '../src/editor/project.ts';

const DURATION = 12;

/** Just enough `recording.json` for `sourceDurationSec` to answer. */
const RECORDING = {
  tracks: {
    screen: {
      kind: 'video',
      parts: [{ startTimeSec: 0, durationSec: DURATION }],
    },
  },
} as unknown as RecordingDoc;

interface Sent {
  ops: EditOp[];
  baseRevision: number;
}

/**
 * A main that applies what it is given, exactly as `ProjectStore.applyOps` does —
 * including refusing a stale `baseRevision` with the authoritative document.
 */
function fakeMain(doc: EditDocument) {
  const sent: Sent[] = [];
  let authoritative = doc;
  let refuseNext = false;
  return {
    sent,
    get document(): EditDocument {
      return authoritative;
    },
    refuseOnce(): void {
      refuseNext = true;
    },
    api: {
      applyOps: (_id: string, ops: EditOp[], baseRevision: number) => {
        sent.push({ ops, baseRevision });
        if (refuseNext || authoritative.revision !== baseRevision) {
          refuseNext = false;
          return Promise.resolve({ conflict: structuredClone(authoritative) });
        }
        authoritative = applyOps(authoritative, ops);
        return Promise.resolve({ revision: authoritative.revision });
      },
    },
  };
}

function open(main: ReturnType<typeof fakeMain>, edit: EditDocument) {
  const troubles: string[] = [];
  const project = new EditorProject({
    id: 'rec',
    recording: RECORDING,
    edit,
    api: main.api,
    onChange: () => undefined,
    onTrouble: (message) => troubles.push(message),
  });
  return { project, troubles };
}

const trimOps = (start: number, end: number): EditOp[] => [
  { op: 'clips.set', clips: [{ id: 'trim', sourceStart: start, sourceEnd: end, speed: 1 }] },
];

/** Let the send queue drain. Sends are deliberately not awaited by `commit`. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('an edit reaches main once, at the revision main is on', () => {
  it('sends the ops it applied, against the document before them', async () => {
    const main = fakeMain(newEditDocument());
    const { project } = open(main, structuredClone(main.document));

    project.commit(trimOps(1, 5), 'Trim');
    await settle();

    expect(main.sent).toEqual([{ ops: trimOps(1, 5), baseRevision: 0 }]);
    expect(main.document.clips).toEqual([{ id: 'trim', sourceStart: 1, sourceEnd: 5, speed: 1 }]);
    expect(project.saveState).toBe('saved');
  });

  it('never sends two batches against the same revision', async () => {
    // Two `commit`s back to back, with no await between them. Unserialized, both
    // would be computed against revision 0 and the second would come back as a
    // conflict of the editor with itself.
    const main = fakeMain(newEditDocument());
    const { project, troubles } = open(main, structuredClone(main.document));

    project.commit(trimOps(1, 5), 'Trim');
    project.commit(trimOps(2, 6), 'Trim');
    await settle();

    expect(main.sent.map((send) => send.baseRevision)).toEqual([0, 1]);
    expect(troubles).toEqual([]);
    expect(project.compiled.durationSec).toBeCloseTo(4, 9);
  });

  it('drops an empty batch before it can cost a revision', async () => {
    const main = fakeMain(newEditDocument());
    const { project } = open(main, structuredClone(main.document));
    project.commit([], 'Nothing');
    await settle();
    expect(main.sent).toEqual([]);
    expect(project.canUndo).toBe(false);
  });

  it('reports a write that failed, then repairs itself on the next edit', async () => {
    // A failed send leaves the editor one revision ahead of disk with no op that
    // could reconcile it. §2.7's conflict path is the repair: main refuses the next
    // batch and hands back what it holds. This is that whole sequence.
    const main = fakeMain(newEditDocument());
    const troubles: string[] = [];
    let fail = true;
    const failing = new EditorProject({
      id: 'rec',
      recording: RECORDING,
      edit: structuredClone(main.document),
      api: {
        applyOps: (id: string, ops: EditOp[], base: number) =>
          fail ? Promise.reject(new Error('disk is gone')) : main.api.applyOps(id, ops, base),
      },
      onChange: () => undefined,
      onTrouble: (message) => troubles.push(message),
    });

    failing.commit(trimOps(1, 5), 'Trim');
    await settle();
    expect(failing.saveState).toBe('failed');
    expect(troubles[0]).toContain('disk is gone');

    fail = false;
    failing.commit(trimOps(1, 6), 'Trim');
    await settle();

    // Main never saw the first edit, so its revision is still 0 and the second
    // batch's baseRevision of 1 is refused.
    expect(main.document.clips).toEqual([]);
    expect(failing.committed.clips).toEqual([]);
    // ...and the reload names the right cause. "Another window changed this" would
    // send somebody looking for a second editor that does not exist.
    expect(troubles[1]).toContain('could not be saved');
    expect(troubles[1]).not.toContain('Another window');
    // What is on screen is now what is on disk, which is the whole claim.
    expect(failing.saveState).toBe('saved');
  });
});

describe('undo and redo', () => {
  it('send the inverse ops, on the same path, at the right revision', async () => {
    const main = fakeMain(newEditDocument());
    const { project } = open(main, structuredClone(main.document));

    project.commit(trimOps(3, 9), 'Trim');
    await settle();
    expect(project.canUndo).toBe(true);

    project.undo();
    await settle();
    expect(main.sent).toHaveLength(2);
    expect(main.sent[1]?.baseRevision).toBe(1);
    // The document main holds is back to what it was, and it got there by an op —
    // not by being handed a document. That is what makes an undo journalled.
    expect(main.document.clips).toEqual([]);
    expect(project.canRedo).toBe(true);

    project.redo();
    await settle();
    expect(main.document.clips).toEqual([{ id: 'trim', sourceStart: 3, sourceEnd: 9, speed: 1 }]);
  });

  it('recompile the timeline each time, so the preview follows the undo', async () => {
    const main = fakeMain(newEditDocument());
    const { project } = open(main, structuredClone(main.document));

    expect(project.compiled.durationSec).toBeCloseTo(DURATION, 9);
    project.commit(trimOps(3, 9), 'Trim');
    expect(project.compiled.durationSec).toBeCloseTo(6, 9);
    project.undo();
    expect(project.compiled.durationSec).toBeCloseTo(DURATION, 9);
    await settle();
  });

  it('answer false rather than sending anything when there is nothing to undo', async () => {
    const main = fakeMain(newEditDocument());
    const { project } = open(main, structuredClone(main.document));
    expect(project.undo()).toBe(false);
    expect(project.redo()).toBe(false);
    await settle();
    expect(main.sent).toEqual([]);
  });
});

describe('a provisional document — a handle mid-drag', () => {
  it('changes what is shown and reaches neither the history nor main', async () => {
    const main = fakeMain(newEditDocument());
    const { project } = open(main, structuredClone(main.document));

    project.preview({
      ...project.committed,
      clips: [{ id: 'trim', sourceStart: 2, sourceEnd: 4, speed: 1 }],
    });
    expect(project.document.clips).toHaveLength(1);
    expect(project.committed.clips).toEqual([]);
    expect(project.canUndo).toBe(false);
    await settle();
    expect(main.sent).toEqual([]);
  });

  it('is thrown away by cancelPreview', async () => {
    const main = fakeMain(newEditDocument());
    const { project } = open(main, structuredClone(main.document));
    project.preview({
      ...project.committed,
      clips: [{ id: 'trim', sourceStart: 2, sourceEnd: 4, speed: 1 }],
    });
    project.cancelPreview();
    expect(project.document.clips).toEqual([]);
    await settle();
  });
});

describe('a conflict', () => {
  it('reloads the authoritative document and drops the stacks', async () => {
    const main = fakeMain(newEditDocument());
    const { project, troubles } = open(main, structuredClone(main.document));

    // Somebody else got there first.
    await main.api.applyOps('rec', trimOps(0, 2), 0);
    main.sent.length = 0;

    project.commit(trimOps(3, 9), 'Trim');
    await settle();

    expect(troubles[0]).toContain('Another window');
    expect(project.committed.clips).toEqual([
      { id: 'trim', sourceStart: 0, sourceEnd: 2, speed: 1 },
    ]);
    // An inverse computed against a document that no longer exists would undo to a
    // state that never did, so the stacks go with the reload.
    expect(project.canUndo).toBe(false);
    expect(project.canRedo).toBe(false);
    expect(project.compiled.durationSec).toBeCloseTo(2, 9);
  });
});
