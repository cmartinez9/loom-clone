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
 * `atomic` writes those chunks into a temp file and renames; `naive` writes them
 * straight into the target, which is exactly the bug this whole design exists to
 * prevent.
 */

import { open, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

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

/** Write `bytes` to an open handle in pieces, pausing between them. */
async function writeInChunks(handle, bytes) {
  const size = Math.ceil(bytes.byteLength / chunks);
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    await handle.write(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
    await sleep(chunkDelayMs);
  }
}

async function writeAtomicChunked(bytes) {
  const tmp = `${target}.tmp-${process.pid}-0`;
  const handle = await open(tmp, 'w', 0o644);
  try {
    await writeInChunks(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
  const dir = await open(dirname(target), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function writeNaiveChunked(bytes) {
  // Truncate-then-write, the obvious implementation and the one that loses data.
  const handle = await open(target, 'w', 0o644);
  try {
    await writeInChunks(handle, bytes);
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
