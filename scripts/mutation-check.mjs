/**
 * The mutation proof for the capture gates: phase 1's crash gate, phase 3's A/V
 * sync gate and phase 4's camera-unplug gate.
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
/** The phase 3 gate: flash/tone sync at 1 minute and at 20 minutes. */
const SYNC = 'apps/main/test/av-sync.test.ts';
const SYNC_UNIT = 'packages/format/test/sync.test.ts';
const AUDIO_MUX = 'packages/mux/test/audio-part.test.ts';
/** The phase 4 gate: unplug the camera, keep the screen, two parts placed right. */
const PHASE4 = 'test/phase4-gate.test.ts';
const RECORDER = 'apps/main/test/recorder-session.test.ts';

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
    find: '    await handle.truncate(endsAt);',
    replace: '    await handle.sync();',
    mustFail: [MUX, LIFECYCLE],
  },
  {
    name: 'audio-rate-taken-as-nominal',
    breaks:
      'measuredSampleRate is measured rather than assumed. A device that reports ' +
      '48000 Hz does not run at 48000.000 Hz, and taking its word for it is the ' +
      'drift architecture report §5.5 and §10.1 both name — invisible at one ' +
      'minute, 60 ms at twenty.',
    file: 'packages/format/src/sync/audio-meter.ts',
    find: '    const measured = spanUs > 0 && measurable > 0 ? measurable / (spanUs / 1_000_000) : null;',
    replace: '    const measured = null;',
    mustFail: [SYNC, SYNC_UNIT],
  },
  {
    name: 'encoder-priming-not-trimmed',
    breaks:
      "the edit list that trims the AAC encoder's 2112 priming samples. Two " +
      'demuxers then give two different answers about where the audio starts, 44 ms ' +
      'apart — twice the phase 3 sync budget. Not the sync gate: AVFoundation, which ' +
      'is what decodes the tone there, applies the trim whether the file asks for it ' +
      'or not. The audio-part test is where it shows, against both decoders.',
    file: 'packages/mux/src/boxes.ts',
    find: '    ...(delaySamples > 0 ? [editList(delaySamples)] : []),',
    replace: '    ...[],',
    mustFail: [AUDIO_MUX],
  },
  {
    name: 'audio-gaps-closed-instead-of-reproduced',
    breaks:
      'a gap in the captured audio is reproduced as silence of exactly its length ' +
      '(§5.4 mechanism 5). Closing it shortens the track by the gap and ' +
      'desynchronises everything after it — permanently, and invisibly at first.',
    file: 'packages/format/src/sync/align.ts',
    find: '    startSec = gap.atSec + Math.max(0, gap.durationSec);',
    replace: '    startSec = gap.atSec;',
    mustFail: [SYNC, SYNC_UNIT],
  },
  {
    name: 'second-part-placed-at-the-origin',
    breaks:
      'every part of a video track carries its own startTimeSec (§2.3, §5.4 ' +
      'mechanism 2). Collapsing it to zero puts webcam.001.mp4 on top of ' +
      'webcam.000.mp4 for the length of the recording — two files, both playable, ' +
      'and a camera that plays over the wrong part of the screen.',
    file: 'apps/main/src/recorder/session.ts',
    find: '                : videoPartStartSec({',
    replace: '                : 0 * videoPartStartSec({',
    mustFail: [PHASE4],
  },
  {
    name: 'part-start-not-snapped-to-the-reference',
    breaks:
      'sub-buffer offsets are snapped onto the reference track (§5.4 mechanism 3). ' +
      'Without it a camera that opened 10 ms after the screen is recorded as ' +
      'starting 10 ms late, and every consumer resamples to honour noise.',
    file: 'packages/format/src/sync/align.ts',
    find: '  return snapNearby(\n    raw,\n    options.referenceStartSec,',
    replace: '  return snapNearby(\n    raw,\n    null,',
    mustFail: [PHASE4],
  },
  {
    name: 'camera-never-reacquired',
    breaks:
      'a camera that comes back opens the next part (§7.4 step 4). Without it the ' +
      'unplug is permanent: the recording keeps its screen and its audio, and ' +
      'silently has no camera for everything after the moment the cable moved.',
    file: 'apps/renderer/src/capture/webcam.ts',
    find: "      void this.loseCurrentPart('device-lost', { reacquire: true });",
    replace: "      void this.loseCurrentPart('device-lost', { reacquire: false });",
    mustFail: [PHASE4],
  },
  {
    name: 'lost-part-never-announced',
    breaks:
      'a part that closed while the recording carried on is announced, so main ' +
      'finalizes that file and lets the next part open. Swallowing it leaves the ' +
      'first part open forever: main refuses the reconnect as a part it already ' +
      'has, and the camera is written into one file with the unplug concatenated ' +
      'out of it.',
    file: 'apps/renderer/src/capture/webcam.ts',
    find: '    this.sink.partEnded(this.reportFor(acquisition, true, reason));',
    replace: '    void reason;',
    mustFail: [PHASE4],
  },
  {
    name: 'held-frames-dropped-while-a-part-opens',
    breaks:
      'frames that arrive while a part is being created are held and written the ' +
      'moment it opens. Discarding them costs the initial keyframe and everything ' +
      'up to the next one — a second of footage per part, with no error anywhere.',
    file: 'apps/main/src/recorder/session.ts',
    find: '      if (chunk.part === state.part) this.appendChunk(active, state, chunk);',
    replace: '      if (chunk.part !== state.part) this.appendChunk(active, state, chunk);',
    mustFail: [PHASE4, RECORDER],
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
