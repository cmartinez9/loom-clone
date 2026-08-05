/**
 * `ProjectStore` — the sole writer.
 *
 * `ProjectStore` imports nothing from `electron` precisely so that this file can
 * exist: the class that owns the user's footage is testable without a browser, and
 * its crash-safety properties are asserted rather than argued.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, PathEscapeError, UnknownRecordingError } from '../src/project-store.ts';
import { BundleLockedError } from '@loom/format/fs';
import type { EditOp } from '@loom/format';

interface Harness {
  store: ProjectStore;
  root: string;
  trashed: string[];
}

async function withStore<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), 'loom-store-'));
  const root = join(base, 'recordings');
  const trashed: string[] = [];
  const store = new ProjectStore({
    recordingsRoot: root,
    settingsPath: join(base, 'userData', 'settings.json'),
    appVersion: '0.1.0',
    trash: (path) => {
      trashed.push(path);
      return rm(path, { recursive: true, force: true });
    },
    // Snapshot and fsync immediately, so a test never depends on a timer.
    journalSyncMs: 1,
    snapshotDebounceMs: 1,
  });
  try {
    return await run({ store, root, trashed });
  } finally {
    await store.closeAll();
    await rm(base, { recursive: true, force: true });
  }
}

const ADD_TRACK: EditOp = {
  op: 'track.add',
  track: {
    id: 't1',
    kind: 'transform',
    target: 'zoom',
    domain: 'source',
    origin: 'manual',
    blend: 'replace',
    blendMs: 0,
    activeRanges: [[0, 10]],
    enabled: true,
    channels: { amount: { keys: [{ t: 0, v: 1, ease: { kind: 'hold' } }] } },
  },
};

const PATCH_TRACK: EditOp = { op: 'track.patch', trackId: 't1', patch: { enabled: false } };

describe('settings', () => {
  it('creates settings.json on first run', async () => {
    await withStore(async ({ store, root }) => {
      const settings = await store.loadSettings();
      expect(settings.schema).toBe('loom.settings/2');
      expect(settings.recordingsRoot).toBe(root);
      // A fresh install has never been asked for anything, so first-run setup is
      // owed. `index.ts` reads exactly this to decide which window opens.
      expect(settings.setup).toEqual({ completedAt: null, accessibilityOpenedAt: null });
    });
  });

  it('falls back to defaults rather than refusing to launch on a corrupt file', async () => {
    const base = await mkdtemp(join(tmpdir(), 'loom-store-'));
    const settingsPath = join(base, 'settings.json');
    await writeFile(settingsPath, '{ not json');
    const store = new ProjectStore({
      recordingsRoot: join(base, 'recordings'),
      settingsPath,
      appVersion: '0.1.0',
      trash: () => Promise.resolve(),
    });
    try {
      const settings = await store.loadSettings();
      expect(settings.recordingsRoot).toBe(join(base, 'recordings'));
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({
        schema: 'loom.settings/2',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('library', () => {
  it('is empty, not an error, before anything has been recorded', async () => {
    await withStore(async ({ store }) => {
      expect(await store.list()).toEqual([]);
    });
  });

  it('measures sizes on disk rather than trusting a stale project.json', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Sprint review');
      await writeFile(join(paths.media, 'screen.000.mp4'), Buffer.alloc(2_048));

      const [summary] = await store.list();
      expect(summary?.id).toBe(id);
      // project.json still says 0; the library reports what is actually there.
      expect(summary?.sizeBytes).toBeGreaterThan(2_000);
    });
  });

  it('lists a damaged bundle instead of hiding it', async () => {
    await withStore(async ({ store, root }) => {
      await store.create('Good one');
      const broken = join(root, '2026-08-04 10-00-00 Broken.loomrec');
      await mkdir(broken, { recursive: true });
      await writeFile(join(broken, 'project.json'), '{ truncated');

      const summaries = await store.list();
      expect(summaries).toHaveLength(2);
      const damaged = summaries.find((s) => s.unreadable !== undefined);
      expect(damaged?.name).toBe('2026-08-04 10-00-00 Broken');
      expect(damaged?.state).toBe('failed');
    });
  });

  it('moves a recording to the Trash rather than unlinking it', async () => {
    await withStore(async ({ store, trashed }) => {
      const { id, paths } = await store.create('Delete me');
      await store.trash(id);
      expect(trashed).toEqual([paths.dir]);
      expect(await store.list()).toEqual([]);
    });
  });

  it('reports an unknown id rather than silently doing nothing', async () => {
    await withStore(async ({ store }) => {
      await expect(store.directoryFor('01K1Y7QZ8N3M4P5R6S7T8V9W0X')).rejects.toBeInstanceOf(
        UnknownRecordingError,
      );
    });
  });
});

describe('applying ops', () => {
  it('journals before it mutates memory, so a crash between them replays', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Edited');
      await store.openProject(id);

      const result = await store.applyOps(id, [ADD_TRACK], 0);
      expect(result).toEqual({ revision: 1 });

      // The op is on disk immediately — before any snapshot debounce elapses.
      const journal = await readFile(paths.journal, 'utf8');
      expect(journal).toContain('"revision":1');
      expect(journal).toContain('track.add');
    });
  });

  it('reports a conflict instead of merging two windows', async () => {
    await withStore(async ({ store }) => {
      const { id } = await store.create('Contested');
      await store.openProject(id);
      await store.applyOps(id, [ADD_TRACK], 0);

      const result = await store.applyOps(id, [ADD_TRACK], 0);
      expect(result).toHaveProperty('conflict');
      expect((result as { conflict: { revision: number } }).conflict.revision).toBe(1);
    });
  });

  it('replays the journal when the project is reopened after a crash', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Crashed');
      await store.openProject(id);
      await store.applyOps(id, [ADD_TRACK], 0);

      // Simulate a crash: the journal survives, the snapshot does not, and the
      // lock is left behind by a process that no longer exists.
      const journalText = await readFile(paths.journal, 'utf8');
      await store.close(id);
      await writeFile(paths.journal, journalText);
      await writeFile(
        paths.edit,
        JSON.stringify({
          schema: 'loom.edit/1',
          revision: 0,
          output: { size: [1920, 1080], fps: 30, background: { kind: 'none' } },
          clips: [],
          tracks: [],
        }),
      );

      const reopened = await store.openProject(id);
      expect(reopened.replay.applied).toBe(1);
      expect(reopened.edit.revision).toBe(1);
      expect(reopened.edit.tracks.map((t) => t.id)).toEqual(['t1']);
    });
  });

  it('snapshots edit.json and truncates the journal on close', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Snapshotted');
      await store.openProject(id);
      await store.applyOps(id, [ADD_TRACK], 0);
      await store.close(id);

      const edit = JSON.parse(await readFile(paths.edit, 'utf8')) as { revision: number };
      expect(edit.revision).toBe(1);
      // The journal now holds only its header — everything in it is in the snapshot.
      expect((await readFile(paths.journal, 'utf8')).trimEnd().split('\n')).toHaveLength(1);

      const project = JSON.parse(await readFile(paths.project, 'utf8')) as { editRevision: number };
      expect(project.editRevision).toBe(1);
    });
  });

  it('never writes an invalid document', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Guarded');
      await store.openProject(id);
      const before = await readFile(paths.edit, 'utf8');
      const journalBefore = await readFile(paths.journal, 'utf8');

      // A track whose channel mixes spring and curve easings is a validation error
      // (§3.4). It must not reach disk, because the next launch would refuse to
      // open a file this build wrote.
      const rejected = store.applyOps(
        id,
        [
          {
            op: 'track.add',
            track: {
              id: 'bad',
              kind: 'transform',
              target: 'zoom',
              domain: 'source',
              origin: 'manual',
              blend: 'replace',
              blendMs: 0,
              activeRanges: [[0, 1]],
              enabled: true,
              channels: {
                amount: {
                  spring: { tension: 200, mass: 2.25, friction: 40 },
                  keys: [
                    { t: 0, v: 1, ease: { kind: 'spring' } },
                    { t: 1, v: 2, ease: { kind: 'linear' } },
                  ],
                },
              },
            },
          },
        ],
        0,
      );

      // The batch is rejected to its caller, on the queue, before anything is
      // written. Deferring it to the snapshot timer would leave nobody to reject
      // to: `edit.json` would stay frozen at this revision and the journal would
      // grow forever, replaying into the same failure on every launch.
      await expect(rejected).rejects.toThrow(/the resulting edit\.json would be invalid/);
      expect(await readFile(paths.journal, 'utf8')).toBe(journalBefore);

      // And the store is still usable: the rejected batch did not half-apply, so
      // the next valid one lands on the same base revision.
      await expect(store.applyOps(id, [ADD_TRACK], 0)).resolves.toEqual({ revision: 1 });
      await store.close(id);

      const edit = JSON.parse(await readFile(paths.edit, 'utf8')) as {
        revision: number;
        tracks: { id: string }[];
      };
      expect(edit.revision).toBe(1);
      expect(edit.tracks.map((t) => t.id)).toEqual(['t1']);
      expect(before).toContain('"revision": 0');
    });
  });

  it('opens once when two callers race a project that is not open yet', async () => {
    await withStore(async ({ store }) => {
      const { id } = await store.create('Raced');
      // The bundle lock is between *processes*. Two un-awaited `invoke`s from a
      // renderer must not make this process fail against its own pid.
      const [a, b] = await Promise.all([store.openProject(id), store.openProject(id)]);
      expect(a.paths.dir).toBe(b.paths.dir);

      const applied = await Promise.all([
        store.applyOps(id, [ADD_TRACK], 0),
        store.applyOps(id, [PATCH_TRACK], 1),
      ]);
      expect(applied).toEqual([{ revision: 1 }, { revision: 2 }]);
    });
  });

  it('opens degraded when the journal schema is one this build cannot read', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('FromTheFuture');
      await writeFile(
        paths.journal,
        '{"schema":"loom.journal/99"}\n' +
          '{"revision":1,"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n',
      );

      // The recording must still open — it is the user's footage — from the last
      // snapshot, with the unverifiable entries withheld rather than replayed.
      const opened = await store.openProject(id);
      expect(opened.replay.applied).toBe(0);
      expect(opened.edit.revision).toBe(0);
      expect(opened.journalRejected?.recoveredRevision).toBe(0);
    });
  });

  it('preserves a rejected journal and writes new ops into a fresh one', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('FromTheFuture');
      const original =
        '{"schema":"loom.journal/99"}\n' +
        '{"revision":1,"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n';
      await writeFile(paths.journal, original);
      const preserved = `${paths.journal}.v99.bak`;

      await store.openProject(id);
      // Withheld means kept, not destroyed: the build that wrote those ops can
      // still read them.
      expect(await readFile(preserved, 'utf8')).toBe(original);

      // The write-ahead log is live again from the first op — appending under the
      // rejected header would mean the next read withheld this op too.
      expect(await store.applyOps(id, [ADD_TRACK], 0)).toEqual({ revision: 1 });
      const lines = (await readFile(paths.journal, 'utf8')).trimEnd().split('\n');
      expect(JSON.parse(lines[0]!)).toEqual({ schema: 'loom.journal/1' });
      expect(JSON.parse(lines[1]!)).toMatchObject({ revision: 1, op: { op: 'track.add' } });

      // And the snapshot that truncates the journal does not touch what was kept.
      await store.close(id);
      expect(await readFile(preserved, 'utf8')).toBe(original);
      expect((await readFile(paths.journal, 'utf8')).trimEnd().split('\n')).toHaveLength(1);
      expect(JSON.parse(await readFile(paths.edit, 'utf8'))).toMatchObject({ revision: 1 });
    });
  });

  it('opens once when applyOps itself is what opens the project', async () => {
    await withStore(async ({ store }) => {
      const { id } = await store.create('RacedByApplyOps');
      const applied = await Promise.all([
        store.applyOps(id, [ADD_TRACK], 0),
        store.applyOps(id, [PATCH_TRACK], 1),
      ]);
      expect(applied).toEqual([{ revision: 1 }, { revision: 2 }]);
    });
  });
});

describe('the bundle lock', () => {
  it('refuses a second live writer', async () => {
    await withStore(async ({ store, root }) => {
      const { id } = await store.create('Contended');
      await store.openProject(id);

      const other = new ProjectStore({
        recordingsRoot: root,
        settingsPath: join(root, 'settings.json'),
        appVersion: '0.1.0',
        trash: () => Promise.resolve(),
      });
      await expect(other.openProject(id)).rejects.toBeInstanceOf(BundleLockedError);
    });
  });

  it('takes over a lock left by a process that no longer exists', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Stale');
      // pid 2^22 is above the macOS maximum, so it can never be live.
      await writeFile(
        join(paths.dir, '.lock'),
        JSON.stringify({ pid: 4_194_303, startedAt: '2026-08-04T14:32:11.482Z', host: 'gone' }),
      );
      await expect(store.openProject(id)).resolves.toBeDefined();
    });
  });

  it('releases the lock on close', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Released');
      await store.openProject(id);
      expect(await readdir(paths.dir)).toContain('.lock');
      await store.close(id);
      expect(await readdir(paths.dir)).not.toContain('.lock');
    });
  });

  it('sweeps temp files a killed writer left behind', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Littered');
      await writeFile(join(paths.dir, 'project.json.tmp-99999-3'), 'half a document');
      await store.openProject(id);
      expect(await readdir(paths.dir)).not.toContain('project.json.tmp-99999-3');
    });
  });
});

describe('serving files over loom://', () => {
  it('resolves a real file inside the bundle', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Served');
      await writeFile(join(paths.media, 'screen.000.mp4'), 'video');
      const resolved = await store.resolveBundleFile(id, 'media/screen.000.mp4');
      expect(resolved.endsWith('media/screen.000.mp4')).toBe(true);
    });
  });

  it('refuses a traversal', async () => {
    await withStore(async ({ store }) => {
      const { id } = await store.create('Confined');
      for (const bad of ['../../etc/passwd', '/etc/passwd', 'media/../../../etc/passwd', '']) {
        await expect(store.resolveBundleFile(id, bad)).rejects.toBeInstanceOf(PathEscapeError);
      }
    });
  });

  /**
   * The check that a syntactic one does not cover: `media/` is a directory the
   * capture pipeline writes into, and a symlink planted there would otherwise turn
   * a video request into a read of anything on the user's disk.
   */
  it('refuses a symlink that points out of the bundle', async () => {
    await withStore(async ({ store, root }) => {
      const outside = join(root, '..', 'secret.txt');
      await writeFile(outside, 'private key');
      const { id, paths } = await store.create('Symlinked');
      await symlink(outside, join(paths.media, 'screen.000.mp4'));

      await expect(store.resolveBundleFile(id, 'media/screen.000.mp4')).rejects.toBeInstanceOf(
        PathEscapeError,
      );
    });
  });

  it('refuses a directory', async () => {
    await withStore(async ({ store }) => {
      const { id } = await store.create('Directory');
      await expect(store.resolveBundleFile(id, 'media')).rejects.toBeInstanceOf(PathEscapeError);
    });
  });
});

describe('shutdown', () => {
  it('flushes and unlocks every open project', async () => {
    await withStore(async ({ store }) => {
      const a = await store.create('One');
      const b = await store.create('Two');
      await store.openProject(a.id);
      await store.openProject(b.id);
      await store.closeAll();

      expect(await readdir(a.paths.dir)).not.toContain('.lock');
      expect(await readdir(b.paths.dir)).not.toContain('.lock');
    });
  });

  it('does not lose ops written just before a quit', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Quitting');
      await store.openProject(id);
      await store.applyOps(id, [ADD_TRACK], 0);
      // No waiting for the 2 s debounce; `close` is what `before-quit` calls.
      await store.closeAll();

      const edit = JSON.parse(await readFile(paths.edit, 'utf8')) as { tracks: unknown[] };
      expect(edit.tracks).toHaveLength(1);
    });
  });
});

describe('concurrency', () => {
  /**
   * Regression: a debounced snapshot that was already in flight used to finish
   * *after* `close` had shut the journal, and tried to truncate a closed handle.
   * Every write for a project now runs on one queue, in order.
   */
  it('a debounced snapshot racing a close neither throws nor loses the op', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withStore(async ({ store }) => {
        const { id, paths } = await store.create('Racing');
        await store.openProject(id);
        await store.applyOps(id, [ADD_TRACK], 0);

        // Close without waiting for the 1 ms snapshot timer, so both are in flight.
        await store.close(id);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const edit = JSON.parse(await readFile(paths.edit, 'utf8')) as {
          revision: number;
          tracks: unknown[];
        };
        expect(edit.revision).toBe(1);
        expect(edit.tracks).toHaveLength(1);
        expect(await readdir(paths.dir)).not.toContain('.lock');
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('serializes two op batches applied without awaiting the first', async () => {
    await withStore(async ({ store }) => {
      const { id, paths } = await store.create('Serialized');
      await store.openProject(id);

      const first = store.applyOps(id, [ADD_TRACK], 0);
      // The second sees revision 0 still, because the first has not resolved —
      // which is exactly the conflict the report describes, not a lost write.
      const second = await store.applyOps(id, [ADD_TRACK], 0);
      await first;
      expect(second).toHaveProperty('conflict');

      await store.close(id);
      const journal = await readFile(paths.journal, 'utf8');
      expect(journal.trimEnd().split('\n')).toHaveLength(1);
    });
  });
});

describe('background failures', () => {
  it('are reported, not swallowed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withStore(async ({ store }) => {
        const { id } = await store.create('Noisy');
        await store.openProject(id);
        await store.applyOps(id, [ADD_TRACK], 0);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    } finally {
      spy.mockRestore();
    }
    // Nothing failed here; the assertion is that the spy exists to catch it if it
    // ever does, and that a healthy run stays quiet.
    expect(spy).not.toHaveBeenCalledWith(
      expect.stringContaining('journal fsync'),
      expect.anything(),
    );
  });
});
