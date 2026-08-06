/**
 * The child process the retention crash gate kills. Run by
 * `apps/main/test/retention-crash.test.ts`.
 *
 *   node retention-child.js --root <dir> --settings <path> --id-file <path>
 *                          --stop-at recorded|entry|deleted|none [--sources 24]
 *
 * It drives **the production deletion path** — the real `ProjectStore`, the real
 * `applyRetention`, the real `deleteBundleSources`, the real `writeAtomic` — over a
 * real bundle with real files in `media/` and `events/`, and then stops dead at a
 * named point so the parent's `SIGKILL` lands exactly there.
 *
 * Nothing about the ordering is re-implemented here, and that is the whole point:
 * §7.5's *"write `sourcesDeletedAt` first, then unlink, then set `state`"* is a
 * property of `applyRetention`, so a harness that wrote the three steps out itself
 * would keep passing after they were reordered — and reordering them is the
 * regression that leaves a recording looking editable with half its media gone.
 *
 * ## What it does not exercise, deliberately
 *
 * The `ExportRecord` it builds is synthetic: five checks passed, a plausible hash.
 * Whether a *real* export earns that record is `phase9-retention.test.ts`'s question
 * and it answers it against ten real failure modes. This file's question is what the
 * disk looks like when the process dies in the middle of acting on one.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectStore } from '../../src/project-store.ts';
import { applyRetention } from '../../src/export/retention.ts';
import type { ExportRecord } from '@loom/format';

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? fallback : process.argv[at + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const root = arg('root');
const settingsPath = arg('settings');
const idFilePath = arg('id-file');
/** Which of §7.5's steps to stop dead after. `none` runs the whole thing. */
const stopAt = arg('stop-at', 'none');
/** How many files to put in `media/`, so a kill can land inside the unlink loop. */
const sourceCount = Number(arg('sources', '24'));

/** A record that every one of §7.5's five checks passed. See the header. */
function verifiedRecord(path: string): ExportRecord {
  return {
    id: 'crash-job',
    path,
    completedAt: new Date().toISOString(),
    settings: { width: 1920, height: 1080, fps: 30, bitrate: 12_000_000 },
    verified: {
      exists: true,
      bytes: 1_234_567,
      durationSec: 10,
      lastFrameDecodable: true,
      sha256: 'f'.repeat(64),
    },
    sourcesKept: false,
  };
}

async function main(): Promise<void> {
  const store = new ProjectStore({
    recordingsRoot: root,
    settingsPath,
    appVersion: '0.0.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
  const created = await store.create('Crash');
  writeFileSync(idFilePath, created.id, 'utf8');

  // Real bytes in the two directories §7.5 names, and enough of them that "kill it
  // part-way through the unlink loop" is a real place to be rather than a race.
  mkdirSync(join(created.paths.dir, 'media'), { recursive: true });
  mkdirSync(join(created.paths.dir, 'events'), { recursive: true });
  for (let i = 0; i < sourceCount; i++) {
    writeFileSync(
      join(created.paths.dir, 'media', `screen.${String(i).padStart(3, '0')}.mp4`),
      Buffer.alloc(2048, i & 0xff),
    );
  }
  writeFileSync(join(created.paths.dir, 'events', 'cursor.ndjson'), '{"t":0,"x":0.5,"y":0.5}\n');
  writeFileSync(join(created.paths.dir, 'events', 'clicks.ndjson'), '{"t":1,"button":0}\n');

  await store.openProject(created.id);
  const record = verifiedRecord(join(root, 'Crash.mp4'));
  await store.recordExport(created.id, record);
  // `editable` is where a finished, verified export leaves a recording, and it is
  // what the parent expects to find if the kill lands before step 3.
  await store.setState(created.id, 'editable');

  process.stdout.write('ready\n');

  const outcome = await applyRetention(store, created.id, record, {
    betweenSteps: async (step) => {
      process.stdout.write(`step ${step}\n`);
      if (step !== stopAt) return;
      // Stop dead. The parent is watching stdout and kills on this line, so the
      // `SIGKILL` lands exactly here rather than somewhere near here.
      process.stdout.write(`stopped ${step}\n`);
      await new Promise(() => {
        /* until the parent kills us */
      });
    },
  });

  process.stdout.write(`finished ${JSON.stringify(outcome)}\n`);
  await store.closeAll();
}

void main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error('[retention-child]', error);
    process.exit(1);
  },
);
