/**
 * `ProjectStore`'s event-log and cursor-bitmap writes — the phase-5 half of the sole
 * writer.
 *
 * `@loom/sampler` spawns a child process and produces tens of thousands of lines a
 * minute, and it has no filesystem at all: everything it captures reaches the disk
 * through these methods, on the same per-project queue as `edit.json`. That is what
 * keeps report §0 rule 2 — *main is the only writer* — a structural property rather
 * than a thing to remember while adding a feature.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLE, type CursorIndexDoc } from '@loom/format';
import { ProjectStore, UnknownRecordingError } from '../src/project-store.ts';

interface Harness {
  store: ProjectStore;
  id: string;
  dir: string;
}

async function withRecording<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), 'loom-store-events-'));
  const store = new ProjectStore({
    recordingsRoot: join(base, 'recordings'),
    settingsPath: join(base, 'userData', 'settings.json'),
    appVersion: '0.1.0',
    trash: (path) => rm(path, { recursive: true, force: true }),
    journalSyncMs: 1,
    snapshotDebounceMs: 1,
  });
  try {
    await store.loadSettings();
    const { id, paths } = await store.create('Events');
    return await run({ store, id, dir: paths.dir });
  } finally {
    await store.closeAll();
    await rm(base, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const CURSOR_INDEX = (sha: string): CursorIndexDoc => ({
  schema: 'loom.cursors/1',
  images: { [sha]: { file: `cursors/${sha}.png`, hotspot: [10, 8], shape: 'arrow' } },
});

const SHA = 'a'.repeat(64);

describe('event logs', () => {
  it('appends NDJSON and opens the project on demand', async () => {
    await withRecording(async ({ store, id, dir }) => {
      await store.appendEventLog(id, 'cursor', '{"t":0.0163,"x":0.5,"y":0.5,"c":"a","m":0}\n');
      await store.appendEventLog(id, 'cursor', '{"t":0.0246,"x":0.5,"y":0.5,"c":"a","m":0}\n');
      await store.syncEventLog(id, 'cursor');

      expect(store.eventLogLineCount(id, 'cursor')).toBe(2);
      const text = await readFile(join(dir, BUNDLE.cursorLog), 'utf8');
      expect(text.split('\n').filter((line) => line.length > 0)).toHaveLength(2);
    });
  });

  it('does not create a log that was never written to', async () => {
    await withRecording(async ({ store, id, dir }) => {
      await store.appendEventLog(id, 'cursor', '{"t":0}\n');
      // The phase-5 gate, at the storage layer: writing the cursor log must not bring
      // `clicks.ndjson` into existence as a side effect.
      expect(await exists(join(dir, BUNDLE.clickLog))).toBe(false);
      expect(store.eventLogLineCount(id, 'clicks')).toBeNull();
    });
  });

  it('creates an empty log only when asked', async () => {
    await withRecording(async ({ store, id, dir }) => {
      await store.createEventLog(id, 'clicks');
      expect(await exists(join(dir, BUNDLE.clickLog))).toBe(true);
      expect(await readFile(join(dir, BUNDLE.clickLog), 'utf8')).toBe('');
      expect(store.eventLogLineCount(id, 'clicks')).toBe(0);
    });
  });

  it('keeps concurrent appends in order', async () => {
    await withRecording(async ({ store, id, dir }) => {
      // Fired without awaiting, as the sampler's flush timer does. The per-project
      // queue is what makes the file's order match the caller's; a log whose lines
      // are not in time order is not something a later phase can bisect.
      await Promise.all(
        Array.from({ length: 50 }, (_unused, index) =>
          store.appendEventLog(id, 'cursor', `{"t":${index / 120}}\n`),
        ),
      );
      const lines = (await readFile(join(dir, BUNDLE.cursorLog), 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { t: number }).t);
      expect(lines).toEqual(Array.from({ length: 50 }, (_unused, index) => index / 120));
    });
  });

  it('flushes and releases its handles on close', async () => {
    await withRecording(async ({ store, id, dir }) => {
      await store.appendEventLog(id, 'cursor', '{"t":1}\n');
      await store.close(id);

      expect(store.eventLogLineCount(id, 'cursor')).toBeNull();
      expect(await readFile(join(dir, BUNDLE.cursorLog), 'utf8')).toBe('{"t":1}\n');
      // The bundle lock is gone, which it would not be if a handle were still open
      // inside the bundle.
      expect(await exists(join(dir, BUNDLE.lock))).toBe(false);
    });
  });

  it('refuses an unknown recording', async () => {
    await withRecording(async ({ store }) => {
      await expect(store.appendEventLog('nope', 'cursor', '{"t":1}\n')).rejects.toBeInstanceOf(
        UnknownRecordingError,
      );
    });
  });
});

describe('cursor bitmaps', () => {
  it('writes a content-addressed PNG and its index', async () => {
    await withRecording(async ({ store, id, dir }) => {
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      await store.writeCursorImage(id, SHA, png);
      await store.writeCursorIndex(id, CURSOR_INDEX(SHA));

      expect(await readFile(join(dir, 'cursors', `${SHA}.png`))).toEqual(png);
      const index = JSON.parse(await readFile(join(dir, BUNDLE.cursorIndex), 'utf8')) as {
        images: Record<string, { shape: string }>;
      };
      expect(index.images[SHA]?.shape).toBe('arrow');
    });
  });

  it('refuses an id that is not a lowercase hex sha256', async () => {
    await withRecording(async ({ store, id }) => {
      // The id comes from a child process and becomes a path. `cursorImagePath` is
      // the gate, and it throws rather than writing outside `cursors/`.
      await expect(store.writeCursorImage(id, '../escape', new Uint8Array())).rejects.toThrow(
        'sha256',
      );
    });
  });

  it('refuses an invalid cursors/index.json rather than writing one', async () => {
    await withRecording(async ({ store, id, dir }) => {
      const before = await readFile(join(dir, BUNDLE.cursorIndex), 'utf8');
      await expect(
        store.writeCursorIndex(id, { schema: 'loom.cursors/1', images: { x: {} } } as never),
      ).rejects.toThrow('invalid');
      // A file this build wrote and the next launch refuses to open is the thing
      // validation-before-write exists to prevent.
      expect(await readFile(join(dir, BUNDLE.cursorIndex), 'utf8')).toBe(before);
    });
  });
});
