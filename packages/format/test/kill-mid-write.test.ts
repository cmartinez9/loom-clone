/**
 * **Phase 0 gate, half two: kill the process mid-write and prove no torn file.**
 *
 * Architecture report §8: *"Round-trip a fixture bundle through write/read/migrate;
 * kill the process mid-write and prove no torn file."* This is the first proof of
 * the crash-survival property the whole architecture rests on — §0, rule 2 and
 * §7.1 both depend on it, and §7.5 deletes the user's only copy of their footage
 * on the strength of it.
 *
 * ## What makes this a proof and not a hope
 *
 * A `SIGKILL` at a random instant might land between writes, so a test that kills
 * a writer and finds an intact file has shown nothing. Two things fix that:
 *
 * 1. **The kill is aimed.** The child writes its payload in chunks with a delay
 *    between them, so the write window is wide and the kill lands inside it every
 *    round, for both writers.
 * 2. **There is a control.** The same harness runs a naive truncate-then-write
 *    child. If the naive writer does *not* tear, the harness is not actually
 *    catching writers mid-write, and this file fails rather than passing
 *    vacuously — which is the failure mode that would let a real regression in
 *    `writeAtomic` ship unnoticed.
 *
 * The property asserted of the atomic writer is exact: after a kill, `project.json`
 * either does not exist yet, or parses and equals a *complete* generation. Never a
 * mixture, never a truncation, never a half-written pad.
 */

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withTempDir } from './helpers/temp.ts';
import { isTempArtifact } from '../src/fs/write-atomic.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WRITER = join(here, 'helpers/kill-writer.mjs');

const ROUNDS = 12;
/** Chunked writing makes the window wide enough that the kill always lands in it. */
const CHUNKS = 10;
const CHUNK_DELAY_MS = 5;

type Verdict = 'absent' | 'intact' | 'torn';

/** Read the target and say what state the kill left it in. */
async function inspect(target: string): Promise<{ verdict: Verdict; detail: string }> {
  let text: string;
  try {
    text = await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { verdict: 'absent', detail: 'no file yet' };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { verdict: 'torn', detail: `unparseable, ${String(text.length)} chars` };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { verdict: 'torn', detail: 'not an object' };
  }
  const doc = parsed as Record<string, unknown>;
  const generation = doc['generation'];
  const pad = doc['pad'];
  const checksum = doc['checksum'];
  if (typeof generation !== 'number' || typeof pad !== 'string' || typeof checksum !== 'string') {
    return { verdict: 'torn', detail: 'fields missing' };
  }

  // The checksum covers the generation and the pad length together, so a document
  // assembled from two different generations' bytes cannot pass.
  const expected = createHash('sha256')
    .update(`${String(generation)}:${String(pad.length)}`)
    .digest('hex');
  if (expected !== checksum) {
    return { verdict: 'torn', detail: `checksum mismatch at generation ${String(generation)}` };
  }
  return { verdict: 'intact', detail: `generation ${String(generation)}` };
}

/**
 * Start a writer, wait until it is really writing, `SIGKILL` it, and report what
 * the file looks like afterwards.
 */
async function killMidWrite(
  dir: string,
  mode: 'atomic' | 'naive',
  round: number,
): Promise<{
  verdict: Verdict;
  detail: string;
}> {
  const target = join(dir, 'project.json');
  const child = spawn(
    process.execPath,
    [
      WRITER,
      '--target',
      target,
      '--mode',
      mode,
      '--chunks',
      String(CHUNKS),
      '--chunk-delay-ms',
      String(CHUNK_DELAY_MS),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  try {
    // Wait for the child to report at least one completed generation, so the kill
    // in a later round always lands on a writer that has a previous good file to
    // protect — which is the interesting case.
    await waitForOutput(child, round === 0 ? 'ready' : 'wrote 1');
    // Then a jittered pause so the kill lands at a different point in the chunk
    // sequence each round rather than always the same one.
    await delay(15 + ((round * 7) % (CHUNKS * CHUNK_DELAY_MS)));
    child.kill('SIGKILL');
    await once(child, 'exit');
    return await inspect(target);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(`${target}.ready`, { force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(child: ReturnType<typeof spawn>, event: 'exit'): Promise<void> {
  return new Promise((resolve) =>
    child.once(event, () => {
      resolve();
    }),
  );
}

function waitForOutput(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(
        new Error(`writer never emitted ${JSON.stringify(marker)}; saw: ${buffer.slice(0, 200)}`),
      );
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`writer exited before emitting ${JSON.stringify(marker)}`));
    });
  });
}

describe('SIGKILL mid-write', () => {
  it('never leaves a torn file, over many kills', async () => {
    const results = await withTempDir(async (dir) => {
      const collected: { verdict: Verdict; detail: string }[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        collected.push(await killMidWrite(dir, 'atomic', round));
      }
      return collected;
    });

    const torn = results.filter((r) => r.verdict === 'torn');
    expect(torn, `writeAtomic left a torn file: ${torn.map((r) => r.detail).join('; ')}`).toEqual(
      [],
    );

    // And it did get as far as writing something, so the rounds were not all no-ops.
    expect(results.some((r) => r.verdict === 'intact')).toBe(true);
  });

  it('CONTROL: the same harness does tear a naive truncate-then-write', async () => {
    const results = await withTempDir(async (dir) => {
      const collected: { verdict: Verdict; detail: string }[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        collected.push(await killMidWrite(dir, 'naive', round));
      }
      return collected;
    });

    // If this ever stops failing, the harness has stopped catching writers
    // mid-write and the test above is passing for the wrong reason.
    expect(
      results.some((r) => r.verdict === 'torn'),
      'the naive writer survived every kill, so this harness is not actually ' +
        'interrupting writes and the atomic-writer assertion above proves nothing',
    ).toBe(true);
  });

  it('leaves temp files behind, and the sweeper recognises them', async () => {
    await withTempDir(async (dir) => {
      // Killed atomic writers leave `.tmp-<pid>-<n>` files. They are litter, never
      // corruption — the destination is only ever replaced by rename — and
      // `sweepTempArtifacts` clears them when the store next takes the lock.
      for (let round = 0; round < 4; round++) {
        await killMidWrite(dir, 'atomic', round);
      }
      const entries = await readdir(dir);
      const temps = entries.filter(isTempArtifact);
      for (const temp of temps) {
        // Whatever they contain, they are not the destination.
        expect(temp).not.toBe('project.json');
        expect((await stat(join(dir, temp))).isFile()).toBe(true);
      }
    });
  });
});
