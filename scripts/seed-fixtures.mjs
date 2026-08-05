/**
 * Seed a recordings root with example bundles, for looking at the library window
 * with something in it.
 *
 *   node scripts/seed-fixtures.mjs [root]
 *
 * Development-only, and it goes through the real `createBundle` and `writeAtomic`
 * rather than hand-writing JSON — so if it produces a bundle the app refuses to
 * open, that is a bug worth knowing about.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBundle } from '@loom/format/fs';
import { currentSchemaId, isoTimestamp, ulid } from '@loom/format';

const root = process.argv[2] ?? join(homedir(), 'Movies', 'Loom Clone');

/** A plausible `recording.json` for a finished screen-plus-mic capture. */
function recordingDoc({ durationSec, frameCount }) {
  return {
    schema: currentSchemaId('loom.recording'),
    clock: { kind: 'videoframe-timestamp-us', t0Us: 0 },
    display: {
      id: 1,
      name: 'Built-in Liquid Retina XDR',
      logicalSize: [1728, 1117],
      pixelSize: [3456, 2234],
      scaleFactor: 2,
      colorSpace: 'display-p3',
    },
    tracks: {
      screen: {
        kind: 'video',
        parts: [
          {
            file: 'media/screen.000.mp4',
            index: 'media/screen.000.index.json',
            codec: 'avc1.640034',
            size: [3456, 2234],
            startTimeSec: 0,
            durationSec,
            frameCount,
            rate: { mode: 'variable', nominalFps: 30, observedFps: 19.5 },
            endedEarly: false,
          },
        ],
      },
      mic: {
        kind: 'audio',
        deviceId: 'BuiltInMic',
        deviceName: 'MacBook Pro Microphone',
        parts: [
          {
            file: 'media/mic.000.m4a',
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            channels: 1,
            startTimeSec: 0.0213,
            durationSec: durationSec - 0.02,
            measuredSampleRate: 48000.37,
            gaps: [],
            endedEarly: false,
          },
        ],
      },
    },
    events: {
      cursor: { file: 'events/cursor.ndjson', hz: 120, sampleCount: Math.round(durationSec * 120) },
      clicks: { file: 'events/clicks.ndjson', available: true, source: 'cgeventtap' },
      cursorImages: 'cursors/index.json',
    },
    capture: {
      app: '0.1.0',
      os: '26.5.1',
      permissions: {
        screen: 'granted',
        camera: 'granted',
        microphone: 'granted',
        accessibility: true,
      },
      requestedFps: 30,
      resolutionClamp: '4k',
      droppedFrames: { screen: 0 },
    },
    integrity: { finalizedAt: isoTimestamp(), recoveredFromCrash: false, truncatedToSec: null },
  };
}

const EXAMPLES = [
  { name: 'Sprint review — auth refactor', state: 'editable', durationSec: 252.4, minutesAgo: 35 },
  { name: 'Bug repro for #418', state: 'exported', durationSec: 96.2, minutesAgo: 60 * 26 },
  {
    name: 'Onboarding walkthrough',
    state: 'needs-recovery',
    durationSec: 1041.8,
    minutesAgo: 60 * 50,
  },
];

await mkdir(root, { recursive: true });

for (const example of EXAMPLES) {
  const createdAt = new Date(Date.now() - example.minutesAgo * 60_000);
  const { paths, project } = await createBundle(root, {
    id: ulid(createdAt.getTime()),
    name: example.name,
    appVersion: '0.1.0',
    createdAt,
  });

  await writeFile(
    paths.recording,
    `${JSON.stringify(
      recordingDoc({
        durationSec: example.durationSec,
        frameCount: Math.round(example.durationSec * 19.5),
      }),
      null,
      2,
    )}\n`,
  );

  const next = {
    ...project,
    state: example.state,
    editRevision: 12,
    sizeBytes: Math.round((example.durationSec * 76e6) / 60),
    ...(example.state === 'exported'
      ? {
          exports: [
            {
              id: ulid(createdAt.getTime() + 60_000),
              path: join(root, 'Exports', 'bug-repro-418.mp4'),
              completedAt: isoTimestamp(new Date(createdAt.getTime() + 300_000)),
              settings: { width: 1920, height: 1240, fps: 30, bitrate: 12_000_000 },
              verified: {
                exists: true,
                bytes: 184_221_004,
                durationSec: example.durationSec,
                lastFrameDecodable: true,
                sha256: '9f2c'.repeat(16),
              },
              sourcesKept: false,
            },
          ],
          retention: {
            sourcesDeletedAt: isoTimestamp(new Date(createdAt.getTime() + 302_000)),
            reason: 'export-verified',
          },
        }
      : {}),
  };
  await writeFile(paths.project, `${JSON.stringify(next, null, 2)}\n`);

  // A little real weight on disk, so the library's size column is not all zeroes.
  await writeFile(join(paths.media, 'screen.000.mp4'), Buffer.alloc(1_500_000));
  await writeFile(
    join(paths.events, 'cursor.ndjson'),
    '{"t":0.0163,"x":0.52,"y":0.44,"c":"arrow","m":0}\n',
  );

  console.log(`seeded ${paths.dir}`);
}
