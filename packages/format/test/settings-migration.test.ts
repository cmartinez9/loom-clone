/**
 * `loom.settings/1` → `/2`, which is the format's **first real migration**.
 *
 * Phase 0 built the migration machinery with no steps in it and said why: *"the
 * first real migration is a data change, not an architecture change, and it arrives
 * with tests that already exist."* Phase 2 is the first caller — first-run state had
 * to go somewhere versioned — so this is the test that finds out whether that claim
 * was true.
 *
 * The interesting assertion is not that the field appears. It is that
 * `completedAt` comes out **null**: a returning user has never been asked for
 * Camera, Microphone or Accessibility, because phases 0 and 1 asked for nothing. The
 * tempting migration — "they have used the app, mark setup done" — would silently
 * skip the one screen that explains why a local-only recorder wants four permissions
 * (architecture report §2.7; `data/loom-scope/decision-accessibility-clicks.md`).
 */

import { describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CURRENT_VERSION,
  defaultRegistry,
  migrateDocument,
  newSettingsDoc,
  validateSettingsDoc,
} from '../src/index.ts';
import { loadAndUpgradeDocument, writeJsonAtomic } from '../src/fs/index.ts';
import { withTempDir } from './helpers/temp.ts';

const V1 = { schema: 'loom.settings/1', recordingsRoot: '/Users/x/Movies/Loom Clone' };

describe('loom.settings 1 -> 2', () => {
  it('is the version this build writes', () => {
    expect(CURRENT_VERSION['loom.settings']).toBe(2);
    expect(newSettingsDoc('/tmp/x').schema).toBe('loom.settings/2');
  });

  it('gives an existing install a setup block that says nothing has happened yet', () => {
    const outcome = migrateDocument(defaultRegistry(), 'loom.settings', V1);
    expect(outcome.migrated).toBe(true);
    expect(outcome.fromVersion).toBe(1);
    expect(outcome.toVersion).toBe(2);
    expect(outcome.doc['schema']).toBe('loom.settings/2');
    // Not "completed": phases 0 and 1 never asked for a permission, so a returning
    // user is owed first-run setup exactly as much as a fresh install is.
    expect(outcome.doc['setup']).toEqual({ completedAt: null, accessibilityOpenedAt: null });
  });

  it('keeps the recordings root the user chose', () => {
    const outcome = migrateDocument(defaultRegistry(), 'loom.settings', V1);
    expect(outcome.doc['recordingsRoot']).toBe(V1.recordingsRoot);
  });

  it('produces a document the validator accepts', () => {
    const outcome = migrateDocument(defaultRegistry(), 'loom.settings', V1);
    expect(validateSettingsDoc(outcome.doc).ok).toBe(true);
  });

  it('does not touch a document that is already current', () => {
    const outcome = migrateDocument(defaultRegistry(), 'loom.settings', newSettingsDoc('/tmp/x'));
    expect(outcome.migrated).toBe(false);
  });

  it('still refuses a version from the future', () => {
    // The migration existing must not have softened the rule that an unknown schema
    // is refused rather than guessed at (§2.7).
    expect(() =>
      migrateDocument(defaultRegistry(), 'loom.settings', { ...V1, schema: 'loom.settings/99' }),
    ).toThrow(/newer version/i);
  });
});

describe('the validator', () => {
  it('rejects a v2 document with no setup block', () => {
    // No "old file, be lenient" branch: that branch is how a format stops being one.
    const result = validateSettingsDoc({ schema: 'loom.settings/2', recordingsRoot: '/tmp/x' });
    expect(result.ok).toBe(false);
  });

  it('accepts nulls, because "has not happened" is a real state', () => {
    expect(
      validateSettingsDoc({
        schema: 'loom.settings/2',
        recordingsRoot: '/tmp/x',
        setup: { completedAt: null, accessibilityOpenedAt: null },
      }).ok,
    ).toBe(true);
  });

  it('rejects a timestamp that is not one', () => {
    expect(
      validateSettingsDoc({
        schema: 'loom.settings/2',
        recordingsRoot: '/tmp/x',
        setup: { completedAt: 'yesterday', accessibilityOpenedAt: null },
      }).ok,
    ).toBe(false);
  });
});

describe('upgrading the file on disk', () => {
  it('rewrites settings.json and leaves the v1 copy beside it', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'settings.json');
      await writeJsonAtomic(path, V1);

      const loaded = await loadAndUpgradeDocument(path, 'loom.settings', validateSettingsDoc);
      expect(loaded.migrated).toBe(true);

      // The file itself is now current — not migrated afresh on every launch.
      const onDisk: unknown = JSON.parse(await readFile(path, 'utf8'));
      expect(onDisk).toMatchObject({ schema: 'loom.settings/2' });

      // §2.7: "leaves `edit.json.v1.bak` behind". The user's old file is recoverable.
      const backups = (await readdir(dir)).filter((f) => f.endsWith('.bak'));
      expect(backups).toHaveLength(1);
      expect(JSON.parse(await readFile(join(dir, backups[0] ?? ''), 'utf8'))).toEqual(V1);
    });
  });

  it('leaves a current file alone, with no backup', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'settings.json');
      await writeFile(path, JSON.stringify(newSettingsDoc(dir)));
      const loaded = await loadAndUpgradeDocument(path, 'loom.settings', validateSettingsDoc);
      expect(loaded.migrated).toBe(false);
      expect((await readdir(dir)).filter((f) => f.endsWith('.bak'))).toHaveLength(0);
    });
  });
});
