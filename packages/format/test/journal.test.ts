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

  it('shape-checks ops that came off disk', () => {
    expect(isEditOp(KEY_OP)).toBe(true);
    expect(isEditOp({ op: 'key.set', trackId: 't', channel: 'a' })).toBe(false);
    expect(isEditOp({ op: 'nope' })).toBe(false);
    expect(isEditOp(null)).toBe(false);
    expect(isEditOp({ op: 'clips.set', clips: 'all of them' })).toBe(false);
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
});
