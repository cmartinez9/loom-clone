/**
 * The child process for the kill test. Run by `kill-mid-write.test.ts`; not part
 * of the app.
 *
 *   node kill-writer.mjs --target <path> --mode atomic|naive --chunks <n> --chunk-delay-ms <n>
 *
 * It writes generation 1, 2, 3, … forever, each a large JSON document containing
 * its own generation number and a checksum, until the parent `SIGKILL`s it.
 *
 * **Why the chunked, delayed write.** A `SIGKILL` at a random instant might miss
 * the write window, and a test that only *sometimes* catches the writer mid-write
 * proves nothing. Writing the payload in `--chunks` pieces with a delay between
 * them makes the write window wide and deterministic, so the kill lands inside it
 * every time — for both modes. That is what makes `naive` a real control rather
 * than a hopeful one.
 *
 * `atomic` calls the **real** `writeAtomic` from `src/fs/write-atomic.ts`, pacing
 * it through its `WriteAtomicPacing` hook. That is the point: a harness that
 * re-implemented open-temp/write/fsync/rename/dir-fsync here would keep passing
 * after a regression in the writer the app actually uses. `naive` writes the same
 * chunks straight into the target, which is the bug this whole design exists to
 * prevent, and is the control that proves the kill really lands mid-write.
 */

import { open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeAtomic } from '../../src/fs/write-atomic.ts';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}

const target = arg('target');
const mode = arg('mode', 'atomic');
const chunks = Number(arg('chunks', '8'));
const chunkDelayMs = Number(arg('chunk-delay-ms', '4'));
const padBytes = Number(arg('pad-bytes', '400000'));

if (target === undefined) {
  console.error('kill-writer: --target is required');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A document big enough that writing it in pieces is realistic. */
function payload(generation) {
  const pad = 'x'.repeat(padBytes);
  const body = { schema: 'loom.project/1', generation, pad };
  body.checksum = createHash('sha256').update(`${generation}:${pad.length}`).digest('hex');
  return Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
}

function chunkBytes(bytes) {
  return Math.ceil(bytes.byteLength / chunks);
}

/** The production writer, paced so the kill lands inside its write window. */
async function writeAtomicChunked(bytes) {
  await writeAtomic(target, bytes, {
    chunkBytes: chunkBytes(bytes),
    betweenChunks: () => sleep(chunkDelayMs),
  });
}

async function writeNaiveChunked(bytes) {
  // Truncate-then-write, the obvious implementation and the one that loses data.
  const size = chunkBytes(bytes);
  const handle = await open(target, 'w', 0o644);
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      await handle.write(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
      await sleep(chunkDelayMs);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// A marker the parent waits for, so the kill lands on a running writer rather
// than on a process that has not started yet.
await writeFile(`${target}.ready`, 'ready');
process.stdout.write('ready\n');

for (let generation = 1; ; generation++) {
  const bytes = payload(generation);
  if (mode === 'atomic') await writeAtomicChunked(bytes);
  else await writeNaiveChunked(bytes);
  process.stdout.write(`wrote ${generation}\n`);
}
