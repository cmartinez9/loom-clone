/**
 * **`SIGKILL` in the middle of deleting a recording's sources.**
 *
 * Phase 9's other constraint, and phase 0's crash discipline applied to the one
 * operation in this application that destroys the user's footage: *"a crash
 * mid-deletion must not leave a half-deleted recording that looks exported — the
 * library state and what is on disk must agree after a `SIGKILL` at any point."*
 *
 * Architecture report §7.5 states the mechanism: *"write `retention.sourcesDeletedAt`
 * **first**, then unlink `media/` and `events/`, then set `state: "exported"`. If we
 * crash mid-delete, the next launch sees a recording that has begun deletion and
 * finishes it, rather than one that looks editable but has half its media."*
 *
 * ## What makes this a proof rather than a hope
 *
 * 1. **The kill is aimed, not timed.** `helpers/retention-child.ts` drives the real
 *    `applyRetention` and stops dead at a named step through its pacing hook, so the
 *    `SIGKILL` lands *exactly* between step 1 and step 2, or inside the unlink loop,
 *    or between step 2 and step 3 — never near them. A timed kill would sometimes
 *    miss the window and pass having measured nothing.
 * 2. **The production path is what dies.** The child imports the same
 *    `ProjectStore` and the same `applyRetention` `apps/main/src/index.ts` does, and
 *    this file bundles it from source on every run — so a mutation that reorders the
 *    steps changes what gets killed.
 * 3. **The inspector has a control.** A hand-written `project.json` that says
 *    `exported` beside media that is still there must be *reported* as the forbidden
 *    state. Without that, "no run produced the forbidden state" and "this test cannot
 *    see the forbidden state" read identically.
 *
 * ## The one state the format itself refuses
 *
 * `validateProjectDoc` requires a `retention` record for `state: "exported"`, so the
 * store cannot even write the reversed order's first step: `setState(id, 'exported')`
 * on a recording with no retention record throws before the file is touched. That is
 * a second, independent guard on the same property, and it is asserted here rather
 * than assumed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ProjectDoc } from '@loom/format';
import { ProjectStore } from '../src/project-store.ts';
import { resumeInterruptedRetention } from '../src/export/retention.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD_SOURCE = join(here, 'helpers/retention-child.ts');

const scratch = await mkdtemp(join(tmpdir(), 'loom-retention-crash-'));
const childBundle = join(scratch, 'retention-child.cjs');

beforeAll(async () => {
  // From source, on every run, so a change — or a deliberate mutation — to the
  // production ordering is what gets killed. A pre-built artifact would let this
  // pass against yesterday's code.
  await build({
    entryPoints: [CHILD_SOURCE],
    outfile: childBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    logLevel: 'silent',
  });
}, 60_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** What one bundle looks like on disk, in the terms §7.5's table is written in. */
interface Snapshot {
  state: ProjectDoc['state'];
  hasRetention: boolean;
  media: string[];
  events: string[];
}

async function snapshot(bundleDir: string): Promise<Snapshot> {
  const doc = JSON.parse(await readFile(join(bundleDir, 'project.json'), 'utf8')) as ProjectDoc;
  return {
    state: doc.state,
    hasRetention: doc.retention !== undefined,
    media: (await readdir(join(bundleDir, 'media')).catch(() => [])).sort(),
    events: (await readdir(join(bundleDir, 'events')).catch(() => [])).sort(),
  };
}

/**
 * Every way a snapshot can be self-contradictory, named.
 *
 * Returns *all* of them rather than the first, so a run that is wrong in two ways
 * says so. Empty means the library and the disk agree.
 */
function contradictions(snap: Snapshot): string[] {
  const found: string[] = [];
  const sources = snap.media.length + snap.events.length;
  if (snap.state === 'exported' && sources > 0) {
    found.push(
      `the library says "exported" — the sources are gone and this recording is final — ` +
        `and ${sources} source files are still on disk`,
    );
  }
  if (snap.state === 'exported' && !snap.hasRetention) {
    found.push('the library says "exported" with no retention record to account for it');
  }
  if (snap.state !== 'exported' && !snap.hasRetention && sources === 0) {
    found.push(
      `the library says "${snap.state}" — an editable recording — its sources are gone, ` +
        'and nothing on disk says a deletion ever began',
    );
  }
  return found;
}

interface Killed {
  root: string;
  bundleDir: string;
  settingsPath: string;
  snapshot: Snapshot;
  killedBySignal: boolean;
}

/** Run the child, kill it at `stopAt`, and report what it left. */
async function killAt(stopAt: 'recorded' | 'entry' | 'deleted'): Promise<Killed> {
  const root = await mkdtemp(join(scratch, 'run-'));
  const recordingsRoot = join(root, 'recordings');
  const settingsPath = join(root, 'settings.json');
  const idFilePath = join(root, 'recording-id.txt');

  const child = spawn(
    process.execPath,
    [
      childBundle,
      '--root',
      recordingsRoot,
      '--settings',
      settingsPath,
      '--id-file',
      idFilePath,
      '--stop-at',
      stopAt,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  try {
    await waitForOutput(child, `stopped ${stopAt}`, stderr);
    child.kill('SIGKILL');
    const killedBySignal = await exited(child);
    const id = (await readFile(idFilePath, 'utf8')).trim();
    const bundleDir = await bundleDirFor(recordingsRoot, id);
    return { root, bundleDir, settingsPath, snapshot: await snapshot(bundleDir), killedBySignal };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function bundleDirFor(recordingsRoot: string, id: string): Promise<string> {
  for (const name of await readdir(recordingsRoot)) {
    const dir = join(recordingsRoot, name);
    const doc = await readFile(join(dir, 'project.json'), 'utf8').catch(() => null);
    if (doc !== null && (JSON.parse(doc) as ProjectDoc).id === id) return dir;
  }
  throw new Error(`no bundle for ${id} under ${recordingsRoot}`);
}

function waitForOutput(
  child: ReturnType<typeof spawn>,
  marker: string,
  stderr: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`the child never emitted ${JSON.stringify(marker)}; saw: ${buffer}`));
    }, 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(
        new Error(`the child exited before ${JSON.stringify(marker)}; saw: ${buffer} ${stderr}`),
      );
    });
  });
}

function exited(child: ReturnType<typeof spawn>): Promise<boolean> {
  return new Promise((resolve) => {
    child.once('exit', (_code, signal) => {
      resolve(signal === 'SIGKILL');
    });
  });
}

/** A second launch, over the bundle the killed child left behind. */
async function relaunch(killed: Killed): Promise<Snapshot> {
  const store = new ProjectStore({
    recordingsRoot: join(killed.root, 'recordings'),
    settingsPath: killed.settingsPath,
    appVersion: '0.0.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
  try {
    const outcomes = await resumeInterruptedRetention(store);
    expect(outcomes.every((outcome) => outcome.finished)).toBe(true);
  } finally {
    await store.closeAll();
  }
  return snapshot(killed.bundleDir);
}

const KILL_POINTS = ['recorded', 'entry', 'deleted'] as const;

describe('SIGKILL mid-deletion', () => {
  it.each(KILL_POINTS.map((point) => [point] as const))(
    'leaves a recoverable bundle when the process dies after %s',
    async (point) => {
      const killed = await killAt(point);
      expect(killed.killedBySignal).toBe(true);

      // The invariant, at the instant of death: whatever is on disk, the library
      // does not describe it wrongly.
      expect(contradictions(killed.snapshot)).toEqual([]);
      // ...and the deletion is *discoverable*, which is what step 1 buys. Without
      // the record, a bundle killed inside the unlink loop is an editable recording
      // with holes in it and nothing to say so.
      expect(killed.snapshot.hasRetention).toBe(true);
      expect(killed.snapshot.state).toBe('editable');

      // The next launch finishes it, rather than leaving it half-way for ever.
      const after = await relaunch(killed);
      expect(contradictions(after)).toEqual([]);
      expect(after.state).toBe('exported');
      expect(after.media).toEqual([]);
      expect(after.events).toEqual([]);
    },
    120_000,
  );

  it('kills the child in the middle of the unlink loop, not before or after it', async () => {
    // Otherwise "a kill inside step 2 is survivable" is a claim about a kill that
    // never happened there. The child seeds 24 media files and stops after the first
    // one is unlinked, so a snapshot with all of them or none of them means the
    // pacing hook is not doing what this test believes it is.
    const killed = await killAt('entry');
    expect(killed.snapshot.media.length).toBeGreaterThan(0);
    expect(killed.snapshot.media.length).toBeLessThan(24);
  }, 120_000);

  it('CONTROL: the same inspector reports a bundle that looks exported with its media intact', () => {
    // The control for the three runs above. A `contradictions` that returned `[]` for
    // everything would make all of them pass, and this is the state the whole
    // ordering exists to prevent — constructed here by hand, because the store
    // refuses to produce it (see the test below).
    const forbidden: Snapshot = {
      state: 'exported',
      hasRetention: false,
      media: ['screen.000.mp4'],
      events: [],
    };
    const found = contradictions(forbidden);
    expect(found).toHaveLength(2);
    expect(found.join(' ')).toMatch(/still on disk/);
    expect(found.join(' ')).toMatch(/no retention record/);

    // And the other forbidden shape: sources gone with nothing saying they went.
    expect(
      contradictions({ state: 'editable', hasRetention: false, media: [], events: [] }),
    ).toHaveLength(1);
    // ...while the two legitimate shapes are silent.
    expect(
      contradictions({ state: 'editable', hasRetention: true, media: ['a'], events: [] }),
    ).toEqual([]);
    expect(
      contradictions({ state: 'exported', hasRetention: true, media: [], events: [] }),
    ).toEqual([]);
  });

  it('the format refuses to write "exported" without a retention record', async () => {
    // The second, independent guard: even a caller that ran §7.5's steps backwards
    // could not persist the forbidden state, because `validateProjectDoc` rejects the
    // document before `writeAtomic` sees it.
    const root = await mkdtemp(join(scratch, 'guard-'));
    const store = new ProjectStore({
      recordingsRoot: join(root, 'recordings'),
      settingsPath: join(root, 'settings.json'),
      appVersion: '0.0.0-test',
      trash: () => Promise.resolve(),
    });
    await store.loadSettings();
    const created = await store.create('Guarded');
    await store.openProject(created.id);
    try {
      await expect(store.setState(created.id, 'exported')).rejects.toThrow(/retention/);
      const doc = JSON.parse(
        await readFile(join(created.paths.dir, 'project.json'), 'utf8'),
      ) as ProjectDoc;
      expect(doc.state).not.toBe('exported');
    } finally {
      await store.closeAll();
    }
  }, 30_000);
});
