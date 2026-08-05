/**
 * The child process the crash gate kills. Run by `apps/main/test/capture-crash.test.ts`.
 *
 *   node capture-child.js --root <dir> --settings <path> --progress <path>
 *                        --id-file <path> --mode real|buffered [--interval-ms 5]
 *
 * It drives **the production capture path** — the real `ProjectStore`, the real
 * `MediaPartWriter`, the real `FragmentWriter`, the real `writeAtomic` — with real
 * H.264 frames from the committed fixture, at a steady cadence, until the parent
 * `SIGKILL`s it. Nothing about the write path is re-implemented here.
 *
 * That is the whole point. Phase 0's gate originally exercised a copy of the
 * atomic writer, which meant a regression in the writer the app actually uses
 * would have left the gate green. This child imports the same modules
 * `apps/main/src/index.ts` does, and the test bundles it from source on every run,
 * so a mutation to the production writer changes what is killed.
 *
 * ## `--mode buffered`
 *
 * The control. It holds each sample in memory and hands the whole lot to the store
 * only when recording stops — which is the classic fragmented-MP4 bug the
 * architecture report measured at **zero** recovered frames (§12.2: "the fragments
 * sit in the writer's buffer and a SIGKILL takes all of them"). Everything else,
 * including the store and the writer, is identical. If the gate cannot tell these
 * two apart, the gate is measuring nothing.
 */

import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs';
import { ProjectStore } from '../../src/project-store.ts';
import { provisionalRecordingDoc, withScreenTrack } from '../../src/recorder/recording-doc.ts';
import { loadEncodedFixture } from '../../../../packages/mux/test/helpers/fixture.ts';
import type { EncodedSample } from '@loom/mux';

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? fallback : process.argv[at + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const root = arg('root');
const settingsPath = arg('settings');
const progressPath = arg('progress');
const idFilePath = arg('id-file');
/** Handed in by the parent: this bundle is CommonJS and has no `import.meta.url`. */
const fixturePath = arg('fixture');
const mode = arg('mode', 'real');
const intervalMs = Number(arg('interval-ms', '5'));
/** A backstop so a parent that never kills us does not run forever. */
const maxFrames = Number(arg('max-frames', '3000'));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main(): Promise<void> {
  const fixture = loadEncodedFixture(fixturePath);
  const store = new ProjectStore({
    recordingsRoot: root,
    settingsPath,
    appVersion: '0.1.0-crash-gate',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();

  const { id } = await store.create('Untitled');
  await store.openProject(id);
  await store.setState(id, 'recording');

  const file = store.mediaRelativePath('screen', 0);
  await store.writeRecordingDoc(
    id,
    withScreenTrack(
      provisionalRecordingDoc({
        display: {
          id: 1,
          name: 'Crash Gate Display',
          logicalSize: [fixture.width, fixture.height],
          pixelSize: [fixture.width, fixture.height],
          scaleFactor: 1,
          colorSpace: 'srgb',
        },
        requestedFps: fixture.fps,
        capture: {
          app: '0.1.0-crash-gate',
          os: process.platform,
          permissions: {
            screen: 'granted',
            camera: 'not-determined',
            microphone: 'not-determined',
            accessibility: false,
          },
          resolutionClamp: '3840px',
        },
      }),
      {
        file,
        index: file.replace(/\.mp4$/, '.index.json'),
        codec: 'avc1.64000d',
        size: [fixture.width, fixture.height],
        requestedFps: fixture.fps,
      },
    ),
  );

  await store.beginMediaPart(id, {
    track: 'screen',
    part: 0,
    width: fixture.width,
    height: fixture.height,
    avcC: fixture.avcC,
    nominalFps: fixture.fps,
    colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
  });

  writeFileSync(idFilePath, id, 'utf8');
  // Opened once and appended synchronously: `write(2)` hands the bytes to the
  // kernel, and the kernel survives our `SIGKILL`. A buffered log would under-
  // report what we fed the writer, which would flatter the result.
  const progress = openSync(progressPath, 'a');
  process.stdout.write('ready\n');

  const loopUs = fixture.frames.length * Math.round(1_000_000 / fixture.fps);
  const buffered: EncodedSample[] = [];

  for (let i = 0; i < maxFrames; i++) {
    const frame = fixture.frames[i % fixture.frames.length];
    if (frame === undefined) break;
    const sample: EncodedSample = {
      data: frame.data,
      isKey: frame.isKey,
      timestampUs: frame.timestampUs + Math.floor(i / fixture.frames.length) * loopUs,
      durationUs: null,
    };

    // Recorded *before* the append, so the count is what we handed the writer,
    // never less. Recovering 95% of that is then a claim about the writer rather
    // than about how much of our own bookkeeping survived.
    appendFileSync(progress, `${String(i)}\n`);
    if (mode === 'buffered') buffered.push(sample);
    else await store.appendMediaChunk(id, 'screen', sample);

    await sleep(intervalMs);
  }

  // Only reached if the parent never killed us. The buffered mode's flush lives
  // here, which is exactly its bug: everything is on disk only once recording is
  // over.
  for (const sample of buffered) await store.appendMediaChunk(id, 'screen', sample);
  await store.finalizeMediaPart(id, 'screen');
  await store.close(id);
  closeSync(progress);
  process.stdout.write('finished\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`capture-child failed: ${String(error)}\n`);
  process.exit(1);
});
