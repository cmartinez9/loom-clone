/**
 * **§7.1 step 5 reaching a person, and the numbers it says being the repair's own.**
 *
 * > *"Show the user: 'Recovered 4:52 of a 4:58 recording.' Never silently discard,
 * > never silently pretend it was clean."*
 *
 * Crash recovery has run at launch since phase 1 and reported to a `console.log` the
 * user does not have. That is the *"silently pretend it was clean"* half of §7.1's
 * sentence arrived at by omission: the recording is repaired, appears in the library
 * looking exactly like every other recording, and nothing anywhere says a crash
 * happened.
 *
 * What is asserted here is the path that closes it, end to end and over a real
 * bundle: a recording left in `state: "recording"` with real encoded frames in it,
 * repaired by the shipping `RecorderSession.recoverOnLaunch`, held for the library
 * to pull, and rendered into sentences whose every figure came out of the repair
 * rather than out of a constant.
 *
 * The last of those is the one with history behind it. This project's crash
 * guarantee is **frame-level** — the fragment writer holds one sample, so what a
 * `SIGKILL` costs is what the dead process still held — and a stale sentence
 * claiming a fixed loss window has already had to be corrected here once. So the
 * copy is checked against the numbers this particular repair measured, and
 * `packages/ipc/test/disk.test.ts` separately requires it to state no window at all.
 *
 * The *repair* is `apps/main/test/capture-lifecycle.test.ts`'s and
 * `capture-crash.test.ts`'s subject and is not re-litigated here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECOVERY_COPY } from '@loom/ipc';
import type { RecordingId } from '@loom/format';
import { ProjectStore } from '../src/project-store.ts';
import { provisionalRecordingDoc, withVideoPart } from '../src/recorder/recording-doc.ts';
import { RecorderSession } from '../src/recorder/session.ts';
import type { WindowRegistry } from '../src/windows.ts';
import { loadEncodedFixture } from '../../../packages/mux/test/helpers/fixture.ts';

vi.mock('electron', () => {
  const display = {
    id: 1,
    label: 'Built-in Liquid Retina XDR',
    size: { width: 1728, height: 1117 },
    scaleFactor: 2,
    colorSpace: 'display-p3',
  };
  return {
    BrowserWindow: { fromWebContents: () => null },
    desktopCapturer: { getSources: () => Promise.resolve([]) },
    ipcMain: {
      on: () => undefined,
      handle: () => undefined,
      removeHandler: () => undefined,
      removeAllListeners: () => undefined,
    },
    screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
    session: { defaultSession: { setDisplayMediaRequestHandler: () => undefined } },
    app: { isPackaged: false },
    shell: { openExternal: () => Promise.resolve() },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      isTrustedAccessibilityClient: () => false,
    },
  };
});

const fixture = loadEncodedFixture();

let scratch: string;
let store: ProjectStore;
let recorder: RecorderSession;

const windows = {
  show: () => undefined,
  get: () => undefined,
  all: () => [],
  roleOf: () => undefined,
} as unknown as WindowRegistry;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'loom-recovery-notice-'));
  store = new ProjectStore({
    recordingsRoot: join(scratch, 'recordings'),
    settingsPath: join(scratch, 'settings.json'),
    appVersion: '0.1.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
  recorder = new RecorderSession({
    store,
    windows,
    appVersion: '0.1.0-test',
    osVersion: '14.0.0',
  });
});

afterEach(async () => {
  await store.closeAll().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
});

/**
 * A bundle exactly as a crash mid-recording leaves one: `state: "recording"`, real
 * fragments on disk, and no finalize.
 *
 * The frames are the committed H.264 fixture rather than invented bytes, because
 * recovery rebuilds the index by *scanning* what survived — a bundle full of
 * plausible nonsense would recover zero frames and the sentence under test would be
 * the failure one.
 */
async function crashedBundle(name: string, frames: number): Promise<RecordingId> {
  const { id } = await store.create(name);
  await store.openProject(id);
  await store.setState(id, 'recording');
  const file = store.mediaRelativePath('screen', 0);
  await store.writeRecordingDoc(
    id,
    withVideoPart(
      provisionalRecordingDoc({
        display: {
          id: 1,
          name: 'Built-in Liquid Retina XDR',
          logicalSize: [1728, 1117],
          pixelSize: [3456, 2234],
          scaleFactor: 2,
          colorSpace: 'display-p3',
        },
        requestedFps: fixture.fps,
        capture: {
          app: '0.1.0-test',
          os: '26.5.1',
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
        track: 'screen',
        file,
        index: file.replace(/\.mp4$/, '.index.json'),
        codec: 'avc1.64000d',
        size: [fixture.width, fixture.height],
        requestedFps: fixture.fps,
        rateMode: 'variable',
        startTimeSec: 0,
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
  for (const frame of fixture.frames.slice(0, frames)) {
    await store.appendMediaChunk(id, 'screen', {
      data: frame.data,
      isKey: frame.isKey,
      timestampUs: frame.timestampUs,
      durationUs: null,
    });
  }
  // The crash: the process goes, the handles go with it, nothing is finalized. The
  // store is asked to let go without writing anything more.
  await store.closeAll();
  return id;
}

describe('a launch that found a crashed recording', () => {
  it('keeps what the repair measured, for a window that is not open yet', async () => {
    const id = await crashedBundle('Untitled 3', 40);

    // Nothing to say before the pass runs, which is what makes the pull safe to make
    // on every library load.
    expect(recorder.recoveryReports()).toEqual([]);

    const reports = await recorder.recoverOnLaunch();
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.recordingId).toBe(id);
    expect(report.recovered).toBe(true);

    // Held, and identical to what the pass returned. §7.1's repair runs before any
    // window exists, so a library that opens later has to be able to *ask*.
    expect(recorder.recoveryReports()).toEqual(reports);

    // And handing it out does not hand out the list itself.
    recorder.recoveryReports().push({ ...report, name: 'not this' });
    expect(recorder.recoveryReports()).toEqual(reports);
  });

  it("says §7.1's sentence out of that repair's own numbers", async () => {
    await crashedBundle('Untitled 3', 40);
    const report = (await recorder.recoverOnLaunch())[0]!;

    // The repair measured these by scanning the fragments that survived. Nothing
    // below is a constant this test chose.
    expect(report.frameCount).toBeGreaterThan(0);
    expect(report.recoveredSec).toBeGreaterThan(0);

    const sentence = RECOVERY_COPY.recovered(report);
    expect(sentence).toContain('“Untitled 3”');
    expect(sentence).toContain(`${report.frameCount.toLocaleString('en-US')} frames`);
    expect(sentence).toContain('editable in your library');
    // The regression this file exists for: no fixed loss window, because the
    // guarantee is frame-level and is measured per recording.
    expect(sentence).not.toMatch(/up to|at most|one second|1 second/i);
  });

  it('leaves an ordinary launch with nothing to say', async () => {
    // The control. Without it, "the banner appears" is a claim about the library
    // rendering rather than about a crash having happened — and a recovery notice on
    // every launch is the fastest way to teach a user to ignore one.
    const { id } = await store.create('Untitled');
    await store.openProject(id);
    await store.setState(id, 'editable');
    await store.close(id);

    expect(await recorder.recoverOnLaunch()).toEqual([]);
    expect(recorder.recoveryReports()).toEqual([]);
  });

  it("forgets the last launch's findings when the pass runs again", async () => {
    await crashedBundle('Untitled 3', 40);
    expect(await recorder.recoverOnLaunch()).toHaveLength(1);
    // A second pass finds nothing — the first one repaired it — and what is held has
    // to follow, or a window opened later is told about a crash that was already
    // dealt with.
    expect(await recorder.recoverOnLaunch()).toEqual([]);
    expect(recorder.recoveryReports()).toEqual([]);
  });

  it('reports a bundle it could not repair rather than hiding it', async () => {
    // §7.1's *"never silently discard"*: `recoverBundle` marks a bundle it cannot
    // read as `failed` and leaves it in the library, and the notice has to say so.
    const { id } = await store.create('Broken');
    await store.openProject(id);
    await store.setState(id, 'recording');
    await store.close(id);

    const report = (await recorder.recoverOnLaunch())[0]!;
    expect(report.recovered).toBe(false);
    expect(report.error).not.toBeNull();
    expect((await store.list()).find((s) => s.id === id)?.state).toBe('failed');

    const sentence = RECOVERY_COPY.failed(report);
    expect(sentence).toContain('“Broken”');
    expect(sentence).toContain(report.error ?? '');
    expect(sentence).toContain('still in your library');
  });
});
