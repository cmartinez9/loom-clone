/**
 * The edit journal — architecture report §2.7 and §7.6.
 *
 * The property that matters: **an editor crash costs at most 250 ms of edits.**
 * That is only true if a journal being appended to when the process died still
 * replays everything that was fully written, and if replay refuses to guess about
 * anything that was not.
 */

import { describe, expect, it } from 'vitest';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from './helpers/temp.ts';
import { fixtureEdit } from './helpers/fixtures.ts';
import { JournalWriter, readJournal } from '../src/fs/journal-file.ts';
import { parseJournal, replayJournal } from '../src/journal/replay.ts';
import { applyOps, OpApplyError } from '../src/journal/apply.ts';
import { isEditOp, type EditOp } from '../src/journal/ops.ts';
import type { EditDocument } from '../src/types/edit.ts';

const KEY_OP: EditOp = {
  op: 'key.set',
  trackId: 't-zoom-manual',
  channel: 'amount',
  key: { t: 145, v: 1.8, ease: { kind: 'hold' } },
};

const ADD_OP: EditOp = {
  op: 'track.add',
  track: {
    id: 't-new',
    kind: 'transform',
    target: 'zoom',
    domain: 'source',
    origin: 'manual',
    blend: 'replace',
    blendMs: 0,
    activeRanges: [[0, 10]],
    enabled: true,
    channels: {},
  },
};

describe('applying ops', () => {
  it('advances the revision once per op', () => {
    const before = fixtureEdit();
    const after = applyOps(before, [KEY_OP, ADD_OP]);
    expect(after.revision).toBe(before.revision + 2);
    // The input is untouched — a batch is applied to a copy.
    expect(before.tracks).toHaveLength(6);
    expect(after.tracks).toHaveLength(7);
  });

  it('keeps keyframes sorted by t with unique t', () => {
    const doc = applyOps(fixtureEdit(), [
      KEY_OP,
      { ...KEY_OP, key: { t: 140.5, v: 1.1, ease: { kind: 'linear' } } },
      { ...KEY_OP, key: { t: 145, v: 9.9, ease: { kind: 'hold' } } },
    ]);
    const keys = doc.tracks.find((t) => t.id === 't-zoom-manual')?.channels['amount']?.keys ?? [];
    const times = keys.map((k) => k.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    // The later set replaced the earlier one at the same t rather than duplicating.
    expect(keys.find((k) => k.t === 145)?.v).toBe(9.9);
  });

  it('rejects a batch without half-applying it', () => {
    const before = fixtureEdit();
    expect(() =>
      applyOps(before, [KEY_OP, { op: 'track.remove', trackId: 'does-not-exist' }]),
    ).toThrow(OpApplyError);
    // Nothing landed: the caller's document is exactly as it was.
    expect(before).toEqual(fixtureEdit());
  });

  it('refuses to let a patch change a track id or kind', () => {
    const doc = applyOps(fixtureEdit(), [
      {
        op: 'track.patch',
        trackId: 't-bubble',
        patch: { id: 'hijacked', kind: 'audio', enabled: false } as never,
      },
    ]);
    const track = doc.tracks.find((t) => t.id === 't-bubble');
    expect(track?.kind).toBe('transform');
    expect(track?.enabled).toBe(false);
    expect(doc.tracks.some((t) => t.id === 'hijacked')).toBe(false);
  });

  it('inserts a track at an index when one is given, and appends when it is not', () => {
    // Track order is stacking order (architecture report §3.5), so `at` exists so
    // that undoing the removal of a middle track puts it back in the middle. A
    // journal line written without it still means append.
    const before = fixtureEdit();
    const appended = applyOps(before, [ADD_OP]);
    expect(appended.tracks.at(-1)?.id).toBe('t-new');

    const inserted = applyOps(before, [{ ...ADD_OP, at: 1 }]);
    expect(inserted.tracks[1]?.id).toBe('t-new');
    expect(inserted.tracks.map((t) => t.id)).toEqual([
      before.tracks[0]?.id,
      't-new',
      ...before.tracks.slice(1).map((t) => t.id),
    ]);
  });

  it('refuses an out-of-range insertion index rather than appending quietly', () => {
    const before = fixtureEdit();
    expect(() => applyOps(before, [{ ...ADD_OP, at: 99 }])).toThrow(OpApplyError);
    expect(() => applyOps(before, [{ ...ADD_OP, at: 1.5 }])).toThrow(OpApplyError);
  });

  it('removes a key from a track when a patch names it in `remove`', () => {
    // What makes a patch invertible: the inverse of "add a generator block" is
    // "there was no generator block", and a property holding `undefined` is a
    // different document from one without the property until it is serialized.
    const withGenerator = applyOps(fixtureEdit(), [
      {
        op: 'track.patch',
        trackId: 't-zoom-manual',
        patch: { shapePreset: 'circle' },
      },
    ]);
    expect(
      'shapePreset' in (withGenerator.tracks.find((t) => t.id === 't-zoom-manual') ?? {}),
    ).toBe(true);

    const removeOp: EditOp = {
      op: 'track.patch',
      trackId: 't-zoom-manual',
      patch: { remove: ['shapePreset'] },
    };
    const removed = applyOps(withGenerator, [removeOp]);
    const track = removed.tracks.find((t) => t.id === 't-zoom-manual');
    expect(track).toBeDefined();
    expect(track === undefined ? true : 'shapePreset' in track).toBe(false);

    // The whole point of the representation: the instruction is still there after a
    // trip through the journal's bytes, so a crash before the next `edit.json`
    // snapshot replays the removal rather than losing it.
    const line: unknown = JSON.parse(JSON.stringify(removeOp));
    expect(isEditOp(line)).toBe(true);
    const replayed = applyOps(withGenerator, [line as EditOp]);
    expect('shapePreset' in (replayed.tracks.find((t) => t.id === 't-zoom-manual') ?? {})).toBe(
      false,
    );
  });

  it('refuses a patch that says undefined, and one that removes a required key', () => {
    // `JSON.stringify` drops an undefined-valued property, so a patch that removed
    // by that route would apply in memory and replay as a no-op. And `remove` can
    // only take the optional fields: a track without `domain` is one `compile`
    // refuses (§3.2) after the editor has already applied the op.
    const doc = fixtureEdit();
    const patchOp = (patch: unknown): EditOp =>
      ({ op: 'track.patch', trackId: 't-zoom-manual', patch }) as unknown as EditOp;
    expect(() => applyOps(doc, [patchOp({ blendMs: undefined })])).toThrow(OpApplyError);
    expect(() => applyOps(doc, [patchOp({ remove: ['domain'] })])).toThrow(OpApplyError);
    expect(() => applyOps(doc, [patchOp({ remove: 'spans' })])).toThrow(OpApplyError);
  });

  it('places a new span at an index, and keeps an existing one where it was', () => {
    const spanA = { id: 's-a', start: 1, end: 2, type: 'arrow' };
    const spanB = { id: 's-b', start: 3, end: 4, type: 'rect' };
    const doc = applyOps(fixtureEdit(), [
      { op: 'span.set', trackId: 't-ann', span: spanA },
      { op: 'span.set', trackId: 't-ann', span: spanB, at: 0 },
      // Replacing keeps the position — array order is z-order for annotations.
      { op: 'span.set', trackId: 't-ann', span: { ...spanA, type: 'ellipse' }, at: 0 },
    ]);
    const spans = doc.tracks.find((t) => t.id === 't-ann')?.spans ?? [];
    expect(spans.map((s) => s.id)).toEqual(['s-b', 'a1', 's-a']);
    expect(spans.find((s) => s.id === 's-a')?.type).toBe('ellipse');
  });

  it('refuses an out-of-range span index, exactly as `track.add` does', () => {
    // Span order is z-order, so an `at` that fell off the end would put the
    // annotation on top of everything instead of where the user had it.
    const span = { id: 's-a', start: 1, end: 2, type: 'arrow' };
    const doc = fixtureEdit();
    expect(() => applyOps(doc, [{ op: 'span.set', trackId: 't-ann', span, at: 99 }])).toThrow(
      OpApplyError,
    );
    expect(() => applyOps(doc, [{ op: 'span.set', trackId: 't-ann', span, at: 1.5 }])).toThrow(
      OpApplyError,
    );
  });

  it('shape-checks ops that came off disk', () => {
    expect(isEditOp(KEY_OP)).toBe(true);
    expect(isEditOp({ op: 'key.set', trackId: 't', channel: 'a' })).toBe(false);
    expect(isEditOp({ op: 'nope' })).toBe(false);
    expect(isEditOp(null)).toBe(false);
    expect(isEditOp({ op: 'clips.set', clips: 'all of them' })).toBe(false);
    expect(isEditOp({ ...ADD_OP, at: 2 })).toBe(true);
    expect(isEditOp({ ...ADD_OP, at: -1 })).toBe(false);
    expect(isEditOp({ ...ADD_OP, at: 'first' })).toBe(false);
  });
});

describe('journal file', () => {
  it('writes a schema header and one line per op', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      const writer = new JournalWriter(path);
      await writer.open();
      const revision = await writer.append([KEY_OP, ADD_OP], 47);
      await writer.sync();
      await writer.close();

      expect(revision).toBe(49);
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
      expect(JSON.parse(lines[0]!)).toEqual({ schema: 'loom.journal/1' });
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[1]!)).toMatchObject({ revision: 48, op: { op: 'key.set' } });
      expect(JSON.parse(lines[2]!)).toMatchObject({ revision: 49 });
    });
  });

  it('truncates back to the header after a snapshot', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      const writer = new JournalWriter(path);
      await writer.open();
      await writer.append([KEY_OP], 47);
      await writer.truncate();
      await writer.append([ADD_OP], 48);
      await writer.close();

      const parsed = await readJournal(path);
      expect(parsed.header).toEqual({ schema: 'loom.journal/1' });
      expect(parsed.entries.map((e) => e.revision)).toEqual([49]);
    });
  });

  it('treats a missing journal as an empty one', async () => {
    await withTempDir(async (dir) => {
      const parsed = await readJournal(join(dir, 'nothing.ndjson'));
      expect(parsed).toEqual({
        header: null,
        entries: [],
        torn: false,
        problems: [],
        headerRejected: false,
      });
    });
  });
});

describe('replaying a journal', () => {
  const snapshot: EditDocument = fixtureEdit({ revision: 47 });

  function entriesFrom(ops: EditOp[], from = 47) {
    return ops.map((op, i) => ({ revision: from + i + 1, at: '2026-08-04T14:41:03.117Z', op }));
  }

  it('applies only entries past the snapshot', () => {
    const result = replayJournal(snapshot, [
      ...entriesFrom([ADD_OP], 45), // revision 46, already in the snapshot
      ...entriesFrom([KEY_OP]),
    ]);
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.doc.revision).toBe(48);
    expect(result.stoppedAt).toBeNull();
  });

  it('stops at a hole rather than reordering the user edits', () => {
    const result = replayJournal(snapshot, [
      { revision: 48, at: '2026-08-04T14:41:03.117Z', op: KEY_OP },
      // 49 was never written.
      { revision: 50, at: '2026-08-04T14:41:04.117Z', op: ADD_OP },
    ]);
    expect(result.applied).toBe(1);
    expect(result.doc.revision).toBe(48);
    expect(result.stoppedAt?.revision).toBe(50);
    expect(result.stoppedAt?.reason).toContain('not written');
  });

  it('stops, and keeps what landed, when an op cannot apply', () => {
    const result = replayJournal(snapshot, [
      { revision: 48, at: '2026-08-04T14:41:03.117Z', op: KEY_OP },
      {
        revision: 49,
        at: '2026-08-04T14:41:04.117Z',
        op: { op: 'track.remove', trackId: 'never-existed' },
      },
    ]);
    expect(result.applied).toBe(1);
    expect(result.stoppedAt?.revision).toBe(49);
    expect(result.stoppedAt?.reason).toContain('track.remove');
  });
});

describe('a journal torn by a crash', () => {
  it('discards the partial trailing line and keeps every complete one', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      const writer = new JournalWriter(path);
      await writer.open();
      await writer.append([KEY_OP, ADD_OP], 47);
      await writer.close();

      // What a SIGKILL during an append leaves: a line with no terminator.
      await appendFile(path, '{"revision":50,"at":"2026-08-04T14:41:05.117Z","op":{"op":"key.se');

      const parsed = await readJournal(path);
      expect(parsed.torn).toBe(true);
      expect(parsed.problems).toEqual([]);
      expect(parsed.entries.map((e) => e.revision)).toEqual([48, 49]);

      const result = replayJournal(fixtureEdit({ revision: 47 }), parsed.entries);
      expect(result.applied).toBe(2);
      expect(result.doc.revision).toBe(49);
    });
  });

  it('reports a complete-but-corrupt line as a problem, not as torn', () => {
    const text =
      '{"schema":"loom.journal/1"}\n' +
      '{"revision":48,"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n' +
      'not json at all\n';
    const parsed = parseJournal(text);
    expect(parsed.torn).toBe(false);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.problems).toEqual([{ line: 3, reason: 'not valid JSON' }]);
  });

  it('refuses a journal whose header is from an unknown schema', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      await writeFile(path, '{"schema":"loom.journal/99"}\n');
      const parsed = await readJournal(path);
      expect(parsed.header).toBeNull();
      expect(parsed.problems[0]?.reason).toContain('refusing to open');
      expect(parsed.headerRejected).toBe(true);
    });
  });

  it('does not replay entries under a header schema it does not understand', () => {
    // A journal written by a newer build. Its entries may mean anything; reading
    // them as v1 ops is exactly the guessing §2.7 forbids.
    const text =
      '{"schema":"loom.journal/99"}\n' +
      '{"revision":48,"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n';
    const parsed = parseJournal(text);
    expect(parsed.headerRejected).toBe(true);
    expect(parsed.entries).toEqual([]);
  });

  it('refuses when the header line itself is not JSON', () => {
    const text =
      'not json at all\n' +
      '{"revision":48,"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n';
    const parsed = parseJournal(text);
    expect(parsed.headerRejected).toBe(true);
    expect(parsed.entries).toEqual([]);
  });

  it('does not call a journal torn mid-header a rejected one', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      // A crash while writing the very first line: no complete header, and no
      // entries to lose either.
      await writeFile(path, '{"schema":"loom.jour');
      const parsed = await readJournal(path);
      expect(parsed.torn).toBe(true);
      expect(parsed.headerRejected).toBe(false);
    });
  });

  it('checks the schema of the first line with anything on it, not line index 0', () => {
    // A leading blank line must not carry the header past the schema check and let
    // the entries below it replay unverified.
    const text =
      '\n' +
      '{"schema":"loom.journal/99"}\n' +
      '{"revision":48,"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n';
    const parsed = parseJournal(text);
    expect(parsed.headerRejected).toBe(true);
    expect(parsed.entries).toEqual([]);
  });

  it('still reads a healthy journal that starts with a blank line', () => {
    const text =
      '\n' +
      '{"schema":"loom.journal/1"}\n' +
      '{"revision":48,"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n';
    const parsed = parseJournal(text);
    expect(parsed.headerRejected).toBe(false);
    expect(parsed.header).toEqual({ schema: 'loom.journal/1' });
    expect(parsed.entries.map((e) => e.revision)).toEqual([48]);
  });
});

describe('reopening a journal a crash left mid-append', () => {
  it('repairs the torn tail so the next entry is not welded onto it', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      const first = new JournalWriter(path);
      await first.open();
      await first.append([KEY_OP, ADD_OP], 47);
      await first.close();
      await appendFile(path, '{"revision":50,"at":"2026-08-04T14:41:05.117Z","op":{"op":"key.se');

      const second = new JournalWriter(path);
      await second.open();
      await second.append([KEY_OP], 49);
      await second.close();

      const parsed = await readJournal(path);
      // Without the repair the new entry welds onto the torn one and both are
      // discarded as a single unparseable line — losing an op that was fully and
      // durably written.
      expect(parsed.problems).toEqual([]);
      expect(parsed.torn).toBe(false);
      expect(parsed.entries.map((e) => e.revision)).toEqual([48, 49, 50]);
    });
  });

  it('starts again from a header when the crash tore the header itself', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      await writeFile(path, '{"schema":"loom.jour');

      const writer = new JournalWriter(path);
      await writer.open();
      await writer.append([KEY_OP], 0);
      await writer.close();

      const parsed = await readJournal(path);
      // Welding onto the partial header would make line 1 unparseable, which now
      // means `headerRejected` — a recording nothing could ever open again.
      expect(parsed.headerRejected).toBe(false);
      expect(parsed.header).toEqual({ schema: 'loom.journal/1' });
      expect(parsed.entries.map((e) => e.revision)).toEqual([1]);
    });
  });

  it('preserves a journal whose header it refuses, and starts a fresh one', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      const original =
        '{"schema":"loom.journal/99"}\n' +
        '{"revision":11,"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n';
      await writeFile(path, original);

      const writer = new JournalWriter(path);
      await writer.open({ headerRejected: true });
      await writer.append([KEY_OP], 10);
      await writer.close();

      // The newer build's bytes survive under the same `.bak` convention a
      // migration uses, rather than being appended to and then truncated away.
      expect(await readFile(`${path}.v99.bak`, 'utf8')).toBe(original);

      // And this build's write-ahead log is live from the very first op.
      const parsed = await readJournal(path);
      expect(parsed.headerRejected).toBe(false);
      expect(parsed.header).toEqual({ schema: 'loom.journal/1' });
      expect(parsed.entries.map((e) => e.revision)).toEqual([11]);
    });
  });

  it('names the preserved file for a header carrying no version at all', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      await writeFile(path, 'not json at all\n');

      const writer = new JournalWriter(path);
      await writer.open({ headerRejected: true });
      await writer.close();

      expect(await readFile(`${path}.unreadable.bak`, 'utf8')).toBe('not json at all\n');
      expect((await readJournal(path)).header).toEqual({ schema: 'loom.journal/1' });
    });
  });

  it('leaves a journal that already ends on a line boundary alone', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'edit.journal.ndjson');
      const first = new JournalWriter(path);
      await first.open();
      await first.append([KEY_OP], 47);
      await first.close();
      const before = await readFile(path, 'utf8');

      const second = new JournalWriter(path);
      await second.open();
      await second.close();

      expect(await readFile(path, 'utf8')).toBe(before);
    });
  });
});
