/**
 * The mutation proof for the phase 1 gate.
 *
 *   node scripts/mutation-check.mjs [--only <name>]
 *
 * A crash test that passes tells you nothing on its own — phase 0 shipped one that
 * exercised a *copy* of the writer it claimed to protect, so a regression in the
 * real one would have left it green. The only way to know a gate is measuring
 * something is to break the thing it measures and watch it fail.
 *
 * So: for each mutation below, this script edits the **production source on disk**,
 * runs the tests that are supposed to catch it, and requires them to fail. A
 * mutation that survives is reported as a hole in the gate and the script exits
 * non-zero. Sources are restored in a `finally`, and again on SIGINT, so an
 * interrupted run does not leave a broken writer behind.
 *
 * This is not part of `npm test`: it takes minutes and it deliberately breaks the
 * working tree while it runs. It is `npm run verify:mutation`, and its output
 * belongs in the phase's evidence.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GATE = 'apps/main/test/capture-crash.test.ts';
const MUX = 'packages/mux/test/media-part.test.ts';
const WRITER = 'packages/mux/test/fragment-writer.test.ts';
const LIFECYCLE = 'apps/main/test/capture-lifecycle.test.ts';

/**
 * Each mutation is a one-line edit that breaks exactly one of the properties the
 * gate rests on, plus the tests that must notice.
 */
const MUTATIONS = [
  {
    name: 'fragments-buffered-until-stop',
    breaks:
      'fragments are produced as frames arrive. This makes the writer hold every ' +
      'frame until the recording stops, which is the configuration architecture ' +
      'report §12.2 measured at zero recovered frames.',
    file: 'packages/mux/src/fragment-writer.ts',
    find: '    return this.emit(previous, measured > 0 ? measured : 1);',
    replace: '    return null;',
    mustFail: [GATE, LIFECYCLE],
  },
  {
    name: 'no-initialisation-segment',
    breaks:
      'the ftyp + empty moov is written before the first frame. Without it the ' +
      'file is a pile of fragments no demuxer will open, which is the "moov at the ' +
      'end" failure that loses the whole recording.',
    file: 'packages/mux/src/fs/media-part-writer.ts',
    find: '      await part.writeAll(handle, init);',
    replace: '      await part.writeAll(handle, init.subarray(0, 0));',
    mustFail: [GATE, MUX],
  },
  {
    name: 'index-offsets-point-at-the-moof',
    breaks:
      'every frame index entry points at the sample data. Off by one box header, ' +
      'the sidecar phase 6 seeks with lands on the fragment header instead of the ' +
      'frame — a file that still plays and an editor that cannot decode it.',
    file: 'packages/mux/src/fragment-writer.ts',
    find: '      offsetBytes: this.fileBytes + (bytes.byteLength - sample.data.byteLength),',
    replace: '      offsetBytes: this.fileBytes,',
    // Not the crash gate: recovery rebuilds the index by scanning the file, so it
    // is blind to a writer that computes offsets wrongly. The sidecar a *clean*
    // stop writes is the one at risk, and these two read it.
    mustFail: [MUX, LIFECYCLE],
  },
  {
    name: 'last-frame-does-not-reach-the-stop',
    breaks:
      'the last frame stands for the still screen that follows it. A screen track ' +
      'stops producing frames when the screen stops changing, so without this a ' +
      'four second recording of a static screen reports as a fraction of a second.',
    file: 'packages/mux/src/fragment-writer.ts',
    find: '    if (measured !== null && measured > 0) return this.emit(last, measured);',
    replace: '    if (measured !== null && measured < 0) return this.emit(last, measured);',
    mustFail: [WRITER],
  },
  {
    name: 'torn-tail-left-in-place',
    breaks:
      'recovery truncates a fragment that was mid-write. Leaving it welds the next ' +
      'write onto a partial box, so the damage outlives the crash that caused it.',
    file: 'packages/mux/src/fs/recover.ts',
    find: '      await handle.truncate(at);',
    replace: '      await handle.sync();',
    mustFail: [MUX, LIFECYCLE],
  },
];

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const selected = only === null ? MUTATIONS : MUTATIONS.filter((m) => m.name === only);
if (selected.length === 0) {
  console.error(`no mutation named ${only}; known: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(2);
}

/** Original bytes of every file we touch, so an interrupt cannot leave one broken. */
const originals = new Map();

function restoreAll() {
  for (const [path, text] of originals) writeFileSync(path, text);
  originals.clear();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

function runTests(files) {
  const result = spawnSync('npx', ['vitest', 'run', ...files], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  return { failed: result.status !== 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const results = [];
try {
  for (const mutation of selected) {
    const path = resolve(root, mutation.file);
    const original = readFileSync(path, 'utf8');
    const occurrences = original.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      console.error(
        `mutation ${mutation.name}: expected exactly one occurrence of its target in ` +
          `${mutation.file}, found ${occurrences}. The source moved; update the mutation.`,
      );
      results.push({ name: mutation.name, verdict: 'stale' });
      continue;
    }

    originals.set(path, original);
    writeFileSync(path, original.replace(mutation.find, mutation.replace));
    console.log(`\n── ${mutation.name}`);
    console.log(`   breaks: ${mutation.breaks}`);

    const caughtBy = [];
    const survived = [];
    for (const file of mutation.mustFail) {
      const { failed } = runTests([file]);
      (failed ? caughtBy : survived).push(file);
      console.log(`   ${failed ? 'caught by' : 'SURVIVED '} ${file}`);
    }

    writeFileSync(path, original);
    originals.delete(path);
    results.push({
      name: mutation.name,
      verdict: survived.length === 0 ? 'caught' : 'survived',
      caughtBy,
      survived,
    });
  }
} finally {
  restoreAll();
}

console.log('\n── summary');
for (const result of results) {
  console.log(`   ${result.verdict.padEnd(9)} ${result.name}`);
}

const holes = results.filter((r) => r.verdict !== 'caught');
if (holes.length > 0) {
  console.error(
    `\n${holes.length} mutation(s) were not caught. The gate does not measure what it claims.`,
  );
  process.exit(1);
}
console.log(`\nall ${results.length} mutations were caught.`);
