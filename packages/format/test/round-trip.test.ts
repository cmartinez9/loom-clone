/**
 * **Phase 0 gate, half one: round-trip a fixture bundle through write → read → migrate.**
 *
 * Architecture report §8. Three properties, in order of how much they cost if
 * wrong:
 *
 * 1. **Write then read is lossless.** A bundle written by this build reads back
 *    deep-equal, through the real `createBundle`, `writeAtomic`, `readBundle` path
 *    that the app uses — not a hand-rolled test path.
 * 2. **An old bundle migrates on read.** The chain runs, the upgraded documents are
 *    written back atomically, and the previous version is left beside them as
 *    `<file>.v<n>.bak` (§2.7).
 * 3. **A bundle from the future is refused, not guessed at.** *"**Never** silently
 *    accept an unknown schema — refuse to open and say so."*
 *
 * Property 2 is exercised through a registry carrying test-registered steps rather
 * than production ones, because every family is at version 1 today and there is no
 * honest v0 to ship. The code path is the production one — `readBundle` →
 * `loadAndUpgradeDocument` → `migrateDocument` — so the first real migration
 * inherits a tested chain runner instead of an untested one.
 */

import { describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from './helpers/temp.ts';
import { fixtureEdit, fixtureProject, fixtureRecording, FIXTURE_ID } from './helpers/fixtures.ts';
import {
  BUNDLE,
  BUNDLE_DIRECTORIES,
  bundleDirName,
  currentSchemaId,
  isBundleDirName,
} from '../src/index.ts';
import {
  MigrationError,
  type MigrationRegistry,
  defaultRegistry,
} from '../src/migrate/registry.ts';
import { createBundle, readBundle, listBundles, bundlePaths } from '../src/fs/bundle.ts';
import { writeJsonAtomic } from '../src/fs/write-atomic.ts';

/** Write a complete fixture bundle through the real creation path. */
async function writeFixtureBundle(root: string): Promise<string> {
  const created = await createBundle(root, {
    id: FIXTURE_ID,
    name: 'Untitled',
    appVersion: '0.1.0',
    createdAt: new Date('2026-08-04T14:32:11.482Z'),
  });
  await writeJsonAtomic(created.paths.project, fixtureProject());
  await writeJsonAtomic(created.paths.recording, fixtureRecording());
  await writeJsonAtomic(created.paths.edit, fixtureEdit());
  return created.paths.dir;
}

describe('bundle round trip', () => {
  it('creates the §2.1 layout exactly', async () => {
    await withTempDir(async (root) => {
      const created = await createBundle(root, {
        id: FIXTURE_ID,
        name: 'Untitled',
        appVersion: '0.1.0',
        createdAt: new Date('2026-08-04T14:32:11.482Z'),
      });

      // The directory name is `<local timestamp> <name>.loomrec`.
      const name = created.paths.dir.split('/').pop()!;
      expect(isBundleDirName(name)).toBe(true);
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} Untitled\.loomrec$/);

      const entries = await readdir(created.paths.dir);
      for (const directory of BUNDLE_DIRECTORIES) {
        // Nested entries like `thumbs/strip` are checked via their parent.
        expect(entries).toContain(directory.split('/')[0]);
      }
      expect(entries).toContain(BUNDLE.project);
      expect(entries).toContain(BUNDLE.edit);
      expect(await readdir(join(created.paths.dir, BUNDLE.thumbsDir))).toContain('strip');
      expect(await readdir(join(created.paths.dir, BUNDLE.cursorsDir))).toContain('index.json');
    });
  });

  it('writes and reads back deep-equal', async () => {
    await withTempDir(async (root) => {
      const dir = await writeFixtureBundle(root);
      const opened = await readBundle(dir, { upgrade: false });

      expect(opened.project).toEqual(fixtureProject());
      expect(opened.recording).toEqual(fixtureRecording());
      expect(opened.edit).toEqual(fixtureEdit());
      expect(opened.replay.applied).toBe(0);
      expect(opened.journalTorn).toBe(false);
      expect(opened.journalProblems).toEqual([]);
      expect(opened.journalRejected).toBeNull();
    });
  });

  it('opens degraded, not never, when the journal schema is from the future', async () => {
    await withTempDir(async (root) => {
      const dir = await writeFixtureBundle(root);
      const paths = bundlePaths(dir);
      // A journal a newer build wrote. Its entries may mean anything, so none of
      // them may be replayed — but refusing the bundle outright would make the
      // user's footage permanently unopenable, which is the worse failure.
      await writeFile(
        paths.journal,
        '{"schema":"loom.journal/99"}\n' +
          `{"revision":${String(fixtureEdit().revision + 1)},` +
          '"at":"2026-08-04T14:41:03.117Z","op":{"op":"clips.set","clips":[]}}\n',
      );

      const opened = await readBundle(dir, { upgrade: false });

      expect(opened.edit).toEqual(fixtureEdit());
      expect(opened.replay.applied).toBe(0);
      expect(opened.journalRejected?.recoveredRevision).toBe(fixtureEdit().revision);
      expect(opened.journalRejected?.reason).toContain('refusing to open');
    });
  });

  it('summarizes into the library list', async () => {
    await withTempDir(async (root) => {
      await writeFixtureBundle(root);
      const [summary] = await listBundles(root);

      expect(summary?.id).toBe(FIXTURE_ID);
      expect(summary?.name).toBe('Untitled');
      expect(summary?.state).toBe('editable');
      expect(summary?.unreadable).toBeUndefined();
      // Longest track end across every part: webcam part 2 ends at 149.204 + 163.229.
      expect(summary?.durationSec).toBeCloseTo(312.433, 3);
    });
  });

  it('reads a bundle without a recording.json (mid-recording)', async () => {
    await withTempDir(async (root) => {
      const created = await createBundle(root, {
        id: FIXTURE_ID,
        name: 'In progress',
        appVersion: '0.1.0',
      });
      const opened = await readBundle(created.paths.dir, { upgrade: false });
      expect(opened.recording).toBeNull();
      expect(opened.project.state).toBe('recording');
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * A registry with a real two-step chain for `loom.edit`: 1 → 2 → 3.
 *
 * Step 1 adds a field; step 2 renames it. Between them they exercise everything a
 * production migration will ever do — add, transform, and chain.
 */
function chainedRegistry(): MigrationRegistry {
  return defaultRegistry().with(
    'loom.edit',
    new Map([
      [
        1,
        (doc) => {
          doc['colorSpaceV2'] = 'srgb';
          return doc;
        },
      ],
      [
        2,
        (doc) => {
          doc['colorSpace'] = doc['colorSpaceV2'];
          delete doc['colorSpaceV2'];
          return doc;
        },
      ],
    ]),
    3,
  );
}

describe('migration on read', () => {
  it('runs the chain, writes the result atomically, and leaves a .bak', async () => {
    await withTempDir(async (root) => {
      const dir = await writeFixtureBundle(root);
      const paths = bundlePaths(dir);
      const registry = chainedRegistry();

      const opened = await readBundle(dir, { upgrade: true, registry });

      // The chain ran end to end.
      expect(opened.edit.schema).toBe('loom.edit/3');
      expect((opened.edit as unknown as Record<string, unknown>)['colorSpace']).toBe('srgb');
      expect((opened.edit as unknown as Record<string, unknown>)['colorSpaceV2']).toBeUndefined();

      // The upgraded document is on disk, not just in memory.
      const onDisk = JSON.parse(await readFile(paths.edit, 'utf8')) as Record<string, unknown>;
      expect(onDisk['schema']).toBe('loom.edit/3');
      expect(onDisk['colorSpace']).toBe('srgb');

      // …and the version it came from is beside it, per §2.7.
      const backup = JSON.parse(await readFile(`${paths.edit}.v1.bak`, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(backup['schema']).toBe('loom.edit/1');
      expect(backup['colorSpace']).toBeUndefined();

      // Reading again is a no-op: the document is already current.
      const again = await readBundle(dir, { upgrade: true, registry });
      expect(again.edit.schema).toBe('loom.edit/3');
      const entries = await readdir(dir);
      expect(entries.filter((e) => e.endsWith('.bak'))).toEqual(['edit.json.v1.bak']);
    });
  });

  it('leaves the file alone when only reading', async () => {
    await withTempDir(async (root) => {
      const dir = await writeFixtureBundle(root);
      const paths = bundlePaths(dir);
      const before = await readFile(paths.edit, 'utf8');

      const opened = await readBundle(dir, { upgrade: false, registry: chainedRegistry() });
      expect(opened.edit.schema).toBe('loom.edit/3');

      expect(await readFile(paths.edit, 'utf8')).toBe(before);
      expect(await readdir(dir)).not.toContain('edit.json.v1.bak');
    });
  });

  it('refuses a document written by a newer build', async () => {
    await withTempDir(async (root) => {
      const dir = await writeFixtureBundle(root);
      const paths = bundlePaths(dir);
      await writeFile(
        paths.edit,
        JSON.stringify({ ...fixtureEdit(), schema: 'loom.edit/99' }, null, 2),
      );

      await expect(readBundle(dir, { upgrade: true })).rejects.toMatchObject({
        name: 'MigrationError',
        code: 'from-the-future',
      });
    });
  });

  it('refuses an unrecognised schema rather than guessing', async () => {
    await withTempDir(async (root) => {
      const dir = await writeFixtureBundle(root);
      const paths = bundlePaths(dir);
      await writeFile(paths.edit, JSON.stringify({ ...fixtureEdit(), schema: 'sublime.edit/1' }));

      const error = await readBundle(dir, { upgrade: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe('unknown-schema');
      expect((error as MigrationError).message).toContain('refusing to open');
    });
  });

  it('refuses when the chain has a hole', async () => {
    await withTempDir(async (root) => {
      const dir = await writeFixtureBundle(root);
      // Target version 3, but only the 2 -> 3 step exists.
      const registry = defaultRegistry().with('loom.edit', new Map([[2, (doc) => doc]]), 3);

      await expect(readBundle(dir, { upgrade: true, registry })).rejects.toMatchObject({
        code: 'no-path',
      });
    });
  });

  it('refuses a project.json that is really a recording.json', async () => {
    await withTempDir(async (root) => {
      const dir = await writeFixtureBundle(root);
      await writeFile(bundlePaths(dir).project, JSON.stringify(fixtureRecording()));

      await expect(readBundle(dir, { upgrade: false })).rejects.toMatchObject({
        code: 'family-mismatch',
      });
    });
  });
});

describe('bundle naming', () => {
  it('never collides with an existing bundle', async () => {
    await withTempDir(async (root) => {
      const at = new Date('2026-08-04T14:32:11.482Z');
      const a = await createBundle(root, {
        id: 'A',
        name: 'Same',
        appVersion: '0.1.0',
        createdAt: at,
      });
      const b = await createBundle(root, {
        id: 'B',
        name: 'Same',
        appVersion: '0.1.0',
        createdAt: at,
      });
      expect(a.paths.dir).not.toBe(b.paths.dir);
      expect(b.paths.dir).toContain('(2).loomrec');
    });
  });

  it('sanitizes a name that would break a directory', () => {
    expect(bundleDirName(new Date('2026-08-04T14:32:11.482Z'), 'a/b:c')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} a b c\.loomrec$/,
    );
    expect(bundleDirName(new Date('2026-08-04T14:32:11.482Z'), '   ')).toContain('Untitled');
  });

  it('tags every document with the current schema', () => {
    expect(fixtureProject().schema).toBe(currentSchemaId('loom.project'));
    expect(fixtureRecording().schema).toBe(currentSchemaId('loom.recording'));
    expect(fixtureEdit().schema).toBe(currentSchemaId('loom.edit'));
  });
});
