/**
 * **The phase-13 disk gate: §7.2's rule, measured.**
 *
 * Architecture report §7.2 specifies five behaviours and one rule that governs all
 * of them:
 *
 * > **Never let a write fail.** Stopping at 1 GB with a good file beats hitting
 * > `ENOSPC` with a half-written fragment.
 *
 * So the acceptance criterion is not "the monitor fires". It is **a recording that
 * stops by itself and leaves a file that plays**, and that is what is asserted here:
 * the real `RecorderSession` writing real encoded frames through the real
 * `ProjectStore` into a real fragmented MP4, with the volume's answer driven down
 * past §7.2's thresholds, ending at `editable` with a file `/usr/bin/avconvert`
 * remuxes and a frame index that agrees with the frames that went in.
 *
 * **The disk is simulated and the recording is not.** Waiting for a real volume to
 * fill is not a test anybody runs twice, and a monitor that has never been watched
 * hitting its own threshold proves nothing — so the *measurement* is injected
 * (`RecorderSessionOptions.disk`, whose default is the shipping `store.diskSpace()`)
 * and everything downstream of it is the shipping path. Nothing else is faked: the
 * stop is the ordinary `stop()`, the finalize is the ordinary finalize, and the file
 * is checked with AVFoundation rather than with our own reader, exactly as
 * `capture-crash.test.ts` and `recorder-session.test.ts` do.
 *
 * **Eight controls, because each assertion here passes for a wrong reason without
 * one.**
 *
 * 1. A recording on a volume that never drops must *not* stop and must carry no
 *    `disk-full` — otherwise "it stopped" is a claim about the recorder rather than
 *    about the disk.
 * 2. That same recording's file must play, so the playability assertion is about
 *    the interrupted recording rather than about the fixture.
 * 3. A reader that throws on every poll must leave the recording running to its
 *    ordinary stop. §7.2's monitor is an accessory to the capture spine, and an
 *    instrument that fails must not be a new way to lose footage.
 * 4. The banner must have been *published* below 5 GB and absent above it, or the
 *    stop is the only thing anybody would ever see.
 * 5. A volume that *answers* must be read afresh on every poll, or the single
 *    underlying read the stalled scenario asserts is a guard that stopped reading
 *    rather than the stall it is meant to describe.
 * 6. A library with nothing in it must report `reference`, or `measured` is the
 *    label that path always carries.
 * 7. A library that answers must reach `measured`, or the `reference` a wedged walk
 *    reports is the wiring rather than the wedge.
 * 8. A preflight volume that answers must band `ok`, or the `unknown` a stalled one
 *    reports is what that function always says.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNEL,
  DISK_THRESHOLDS,
  diskRefusesStart,
  type DiskReading,
  type DiskSpace,
  type RecorderStatus,
} from '@loom/ipc';
import {
  validateFrameIndexDoc,
  validateRecordingDoc,
  type ProjectState,
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import { LIBRARY_RATE_DEADLINE_MS, readDiskForPreflight } from '../src/disk.ts';
import { ProjectStore } from '../src/project-store.ts';
import { RecorderSession } from '../src/recorder/session.ts';
import type { WindowRegistry, WindowRole } from '../src/windows.ts';
import {
  loadEncodedFixture,
  type FixtureFrame,
} from '../../../packages/mux/test/helpers/fixture.ts';

interface FakeContents {
  id: number;
  sent: { channel: string; payload?: unknown }[];
  isLoadingMainFrame(): boolean;
  send(channel: string, payload?: unknown): void;
}

interface FakeWindow {
  webContents: FakeContents;
  isDestroyed(): boolean;
}

type Listener = (event: unknown, payload?: unknown) => void;
type Handler = (event: unknown, payload?: unknown) => unknown;

const harness = vi.hoisted(() => ({
  listeners: new Map<string, Listener[]>(),
  handlers: new Map<string, Handler>(),
  windows: new Map<WindowRole, FakeWindow>(),
}));

vi.mock('electron', () => {
  const display = {
    id: 1,
    label: 'Built-in Liquid Retina XDR',
    size: { width: 1728, height: 1117 },
    scaleFactor: 2,
    colorSpace: 'display-p3',
  };
  return {
    BrowserWindow: {
      fromWebContents: (contents: { id: number }) =>
        [...harness.windows.values()].find((w) => w.webContents.id === contents.id) ?? null,
    },
    desktopCapturer: { getSources: () => Promise.resolve([]) },
    ipcMain: {
      on(channel: string, listener: Listener) {
        harness.listeners.set(channel, [...(harness.listeners.get(channel) ?? []), listener]);
      },
      handle(channel: string, handler: Handler) {
        harness.handlers.set(channel, handler);
      },
      removeHandler(channel: string) {
        harness.handlers.delete(channel);
      },
      removeAllListeners(channel: string) {
        harness.listeners.delete(channel);
      },
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

const GB = 1_000_000_000;
/** Fast enough that a whole scenario runs in under a second of test time. */
const POLL_MS = 5;

let nextContentsId = 0;
let scratch: string;
let store: ProjectStore;
let recorder: RecorderSession;
/** Whether {@link recorder} holds a session whose channels are still registered. */
let installed = false;

/**
 * The volume, under the test's hand.
 *
 * A queue of answers rather than a function of time: what §7.2 bands on is the
 * *reading*, so driving the readings directly makes each scenario a statement about
 * a sequence of measurements rather than about how fast the test's clock ran. The
 * last value is held, so a recording that keeps going keeps seeing it.
 */
class FakeVolume {
  private readonly queue: (DiskSpace | Error)[];
  private held: DiskSpace | Error;
  /** Every answer actually handed out, so a test can say how many polls happened. */
  readonly served: (DiskSpace | Error)[] = [];

  constructor(first: DiskSpace | Error, ...rest: (DiskSpace | Error)[]) {
    this.queue = [...rest];
    this.held = first;
  }

  read = (): Promise<DiskSpace> => {
    const next = this.queue.shift();
    if (next !== undefined) this.held = next;
    const answer = this.held;
    this.served.push(answer);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };

  /** Push one more answer onto the end of the queue, mid-recording. */
  push(...answers: (DiskSpace | Error)[]): void {
    this.queue.push(...answers);
  }
}

/**
 * A volume whose reads **never settle** until it is released.
 *
 * Not a rejection and not a slow answer: a promise nobody resolves, which is what a
 * `statfs` against a volume that has stopped answering looks like from here. It is
 * the state §7.2's monitor is most likely to meet — the disk it is watching is
 * watched *because* it is in trouble — and the one that used to switch the monitor
 * off for good, silently, with no reading published and no line in the log.
 */
class StalledVolume {
  /** Every underlying read that was actually issued, answered or not. */
  calls = 0;
  /** The most reads that were ever parked on this volume at one time. */
  peakOutstanding = 0;
  private answer: DiskSpace | null = null;
  private parked: ((space: DiskSpace) => void)[] = [];

  read = (): Promise<DiskSpace> => {
    this.calls += 1;
    const answer = this.answer;
    if (answer !== null) return Promise.resolve(answer);
    return new Promise<DiskSpace>((resolve) => {
      this.parked.push(resolve);
      this.peakOutstanding = Math.max(this.peakOutstanding, this.parked.length);
    });
  };

  /**
   * The volume answers. Every read from here on resolves — **including the ones
   * already parked**, which is what a stalled `statfs` does when the mount comes
   * back, and what makes §7.2's stop reachable from a read that was already waiting.
   */
  release(space: DiskSpace): void {
    this.answer = space;
    const parked = this.parked;
    this.parked = [];
    for (const resolve of parked) resolve(space);
  }
}

function free(bytes: number): DiskSpace {
  return { freeBytes: bytes, totalBytes: 500 * GB };
}

/** How many times the capture page has been told to stop. */
function stopCommands(contents: FakeContents): number {
  return contents.sent.filter(
    (m) =>
      m.channel === CHANNEL.captureCommand &&
      (m.payload as { kind?: string } | undefined)?.kind === 'stop',
  ).length;
}

const windows = {
  show(role: WindowRole): FakeWindow {
    const existing = harness.windows.get(role);
    if (existing !== undefined) return existing;
    nextContentsId += 1;
    const sent: { channel: string; payload?: unknown }[] = [];
    const window: FakeWindow = {
      webContents: {
        id: nextContentsId,
        sent,
        isLoadingMainFrame: () => false,
        send: (channel: string, payload?: unknown) => sent.push({ channel, payload }),
      },
      isDestroyed: () => false,
    };
    harness.windows.set(role, window);
    return window;
  },
  get: (role: WindowRole): FakeWindow | undefined => harness.windows.get(role),
  all: (): FakeWindow[] => [...harness.windows.values()],
  roleOf: (window: unknown): WindowRole | undefined =>
    [...harness.windows.entries()].find(([, w]) => w === window)?.[0],
} as unknown as WindowRegistry;

function captureContents(): FakeContents {
  const capture = harness.windows.get('capture');
  if (capture === undefined) throw new Error('the capture window was never asked for');
  return capture.webContents;
}

function emit(channel: string, sender: FakeContents, payload?: unknown): void {
  for (const listener of harness.listeners.get(channel) ?? []) listener({ sender }, payload);
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function untilState(id: RecordingId, state: ProjectState): Promise<void> {
  await until(
    () => stateOf(id) === state,
    `${id} to reach ${state} (it is ${stateOf(id) ?? 'unknown'})`,
  );
}

let lastStates = new Map<RecordingId, ProjectState>();

function stateOf(id: RecordingId): ProjectState | undefined {
  return lastStates.get(id);
}

/** Poll the store's list into `lastStates`, so `until` can read it synchronously. */
function watchStates(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void store
      .list()
      .then((summaries) => {
        lastStates = new Map(summaries.map((s) => [s.id, s.state]));
      })
      .catch(() => undefined);
  }, 5);
  timer.unref?.();
  return timer;
}

function metaMessage(): unknown {
  return {
    track: 'screen',
    part: 0,
    decoderConfig: {
      codec: 'avc1.64000d',
      codedWidth: fixture.width,
      codedHeight: fixture.height,
      description: fixture.avcC,
    },
  };
}

function chunkMessage(frame: FixtureFrame): unknown {
  return {
    track: 'screen',
    part: 0,
    kind: frame.isKey ? 'key' : 'delta',
    timestampUs: frame.timestampUs,
    durationUs: null,
    data: frame.data,
  };
}

function endedMessage(frames: FixtureFrame[]): unknown {
  const last = frames[frames.length - 1]!;
  return {
    reason: 'stopped',
    endedAtUs: last.timestampUs + Math.round(1_000_000 / fixture.fps),
    framesEncoded: frames.length,
    framesDropped: 0,
    epochOffsetUs: 0,
  };
}

/** Every status main published to the HUD, in order. */
function statuses(contents: FakeContents): RecorderStatus[] {
  return contents.sent
    .filter((message) => message.channel === CHANNEL.recorderStatus)
    .map((message) => message.payload as RecorderStatus);
}

async function readRecordingDoc(id: RecordingId): Promise<RecordingDoc> {
  const dir = await store.directoryFor(id);
  const raw: unknown = JSON.parse(await readFile(join(dir, 'recording.json'), 'utf8'));
  const validated = validateRecordingDoc(raw);
  expect(validated.ok ? null : validated.issues).toBeNull();
  if (!validated.ok) throw new Error('recording.json did not validate');
  return validated.value;
}

/**
 * Prove the media plays, using AVFoundation rather than our own reader.
 *
 * The same standard `recorder-session.test.ts` and `capture-crash.test.ts` hold a
 * file to, for the same reason: our own scanner agreeing with our own writer would
 * prove only that they agree. `PresetPassthrough` remuxes without re-encoding, so it
 * exercises the demuxer and every sample table without spending a decode.
 */
function playsUnderAVFoundation(mediaPath: string, outPath: string): { ok: boolean; log: string } {
  const result = spawnSync(
    '/usr/bin/avconvert',
    ['--source', mediaPath, '--output', outPath, '--preset', 'PresetPassthrough'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return {
    ok: result.status === 0,
    log: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/**
 * Drive a real recording through the recorder until the frames are on disk.
 *
 * Deliberately *not* stopped here — every scenario below differs in how it ends, and
 * that ending is the thing under test.
 */
async function recordFrames(count: number): Promise<{
  id: RecordingId;
  contents: FakeContents;
  frames: FixtureFrame[];
}> {
  const id = await recorder.start({ fps: fixture.fps });
  const contents = captureContents();
  const frames = fixture.frames.slice(0, count);
  emit(CHANNEL.captureMeta, contents, metaMessage());
  for (const frame of frames) emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
  // The writer holds one sample, so `count` chunks is `count - 1` frames on disk.
  await until(
    () => store.mediaFrameCount(id, 'screen') >= frames.length - 1,
    'the fixture frames to reach the disk',
  );
  return { id, contents, frames };
}

let stateWatcher: NodeJS.Timeout | null = null;

beforeEach(async () => {
  harness.listeners.clear();
  harness.handlers.clear();
  harness.windows.clear();
  lastStates = new Map();
  installed = false;
  scratch = await mkdtemp(join(tmpdir(), 'loom-phase13-disk-'));
  store = new ProjectStore({
    recordingsRoot: join(scratch, 'recordings'),
    settingsPath: join(scratch, 'settings.json'),
    appVersion: '0.1.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
  stateWatcher = watchStates();
});

afterEach(async () => {
  if (stateWatcher !== null) clearInterval(stateWatcher);
  if (installed) recorder.uninstall();
  await store.closeAll().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Build the recorder against one reader. Called per scenario, before `start`.
 *
 * A scenario that builds a second one — the capacity estimate needs a library with a
 * finished recording in it, which means recording one first — takes the previous
 * session's IPC listeners down with it. Two live sessions on one `captureChunk`
 * channel is a second recorder receiving the first's frames.
 */
function useReader(read: () => Promise<DiskSpace>): void {
  if (installed) recorder.uninstall();
  installed = true;
  recorder = new RecorderSession({
    store,
    windows,
    appVersion: '0.1.0-test',
    osVersion: '14.0.0',
    stopTimeoutMs: 2_000,
    // Slower than the polls, so the disk readings — not the timer — are what move
    // the status the assertions read.
    statusIntervalMs: 10_000,
    disk: read,
    diskIntervalMs: POLL_MS,
  });
  recorder.install();
}

/** Build the recorder against one volume. Called per scenario, before `start`. */
function useVolume(volume: FakeVolume): void {
  useReader(volume.read);
}

describe("§7.2's disk monitor, on a volume that fills", () => {
  it('stops the recording cleanly and leaves a file that plays', async () => {
    // Comfortable, then inside §7.2's banner band, then under its stop floor. The
    // recording is real all the way through; only the volume's answer is driven.
    const volume = new FakeVolume(free(40 * GB));
    useVolume(volume);

    const { id, contents, frames } = await recordFrames(40);

    // 1. The banner band. §7.2: "< 5 GB → non-modal banner, keep recording."
    volume.push(free(4 * GB));
    await until(
      () => statuses(contents).some((s) => s.disk?.level === 'low'),
      'the low-disk banner to be published',
    );
    expect(recorder.status().phase).toBe('recording');

    // 2. The floor. §7.2: "< 1 GB → stop cleanly, finalize."
    volume.push(free(0.4 * GB));
    // The monitor stops through the ordinary `stop()`, so the capture page is told
    // to stop exactly as it would be by the user's button — and answers the same way.
    await until(
      () =>
        contents.sent.some(
          (m) =>
            m.channel === CHANNEL.captureCommand &&
            (m.payload as { kind?: string } | undefined)?.kind === 'stop',
        ),
      'the capture page to be told to stop',
    );
    emit(CHANNEL.captureEnded, contents, endedMessage(frames));

    // 3. The recording finished, and finished *well*: `editable`, not `failed`.
    //
    // Two waits, not one, and the second is not belt-and-braces: `finalize` writes
    // `editable` several statements before it sets the phase and publishes, so a
    // watcher polling the store can see the state land first. Waiting on only that
    // one reads the phase inside the window between them — a busy host fails on the
    // gap rather than on the property.
    await untilState(id, 'editable');
    await until(() => recorder.status().phase === 'idle', 'the recorder to return to idle');
    expect(recorder.status().phase).toBe('idle');

    // 4. §7.2's "tell the user exactly what happened and how long was saved".
    const notice = recorder.status().diskStop;
    expect(notice).not.toBeNull();
    expect(notice?.recordingId).toBe(id);
    // Measured off the reference track, not asserted as a constant: what matters is
    // that it is the length of the media that survived rather than zero.
    expect(notice?.recordedSec).toBeGreaterThan(0);
    expect(notice?.freeBytes).toBe(0.4 * GB);

    // 5. `PartEndReason`'s `disk-full`, which until phase 13 nothing produced.
    const doc = await readRecordingDoc(id);
    const part = doc.tracks.screen?.parts[0];
    expect(part?.endedEarly).toBe(true);
    expect(part?.endReason).toBe('disk-full');

    // 6. **The rule itself.** A good file, not a half-written fragment — checked by
    //    AVFoundation, and cross-checked against the frames that went in.
    const dir = await store.directoryFor(id);
    const media = join(dir, 'media/screen.000.mp4');
    const played = playsUnderAVFoundation(media, join(scratch, 'played.mov'));
    expect(played.ok, played.log).toBe(true);

    const index = validateFrameIndexDoc(
      JSON.parse(await readFile(join(dir, 'media/screen.000.index.json'), 'utf8')),
    );
    expect(index.ok ? null : index.issues).toBeNull();
    if (!index.ok) return;
    // Every frame, not `- 1`: the writer holds one sample while recording and the
    // finalize flushes it against the end report's `endedAtUs`. That the *last*
    // frame is in the file is exactly what §7.2's clean stop buys over a truncation.
    expect(index.value.pts.length).toBe(frames.length);
    expect(part?.frameCount).toBe(frames.length);
  });
});

describe('the controls', () => {
  it('does not stop, and writes no disk-full, on a volume that stays comfortable', async () => {
    // Without this, "the recording stopped" above is a claim about the recorder
    // rather than about the disk.
    const volume = new FakeVolume(free(40 * GB));
    useVolume(volume);

    const { id, contents, frames } = await recordFrames(40);
    await until(() => volume.served.length >= 5, 'the monitor to have polled several times');
    expect(recorder.status().phase).toBe('recording');
    expect(recorder.status().diskStop).toBeNull();
    // ...and the banner never appeared, which is the other half of the control: the
    // low reading above is about 4 GB and not about the monitor publishing anything.
    expect(statuses(contents).every((s) => s.disk?.level !== 'low')).toBe(true);

    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, endedMessage(frames));
    await stopping;
    await untilState(id, 'editable');

    const doc = await readRecordingDoc(id);
    const part = doc.tracks.screen?.parts[0];
    expect(part?.endedEarly).toBe(false);
    expect(part?.endReason).toBeUndefined();

    // And this file plays too, so the playability assertion in the gate is about
    // the interrupted recording rather than about the fixture.
    const dir = await store.directoryFor(id);
    const played = playsUnderAVFoundation(
      join(dir, 'media/screen.000.mp4'),
      join(scratch, 'control.mov'),
    );
    expect(played.ok, played.log).toBe(true);
  });

  it('keeps recording when the volume cannot be read at all', async () => {
    // §7.2's monitor is an accessory to the capture spine. An instrument that fails
    // must cost its own reading and nothing else — never a recording.
    const volume = new FakeVolume(new Error('statfs: EIO'));
    useVolume(volume);

    const { id, contents, frames } = await recordFrames(40);
    await until(() => volume.served.length >= 5, 'the monitor to have failed several times');
    expect(recorder.status().phase).toBe('recording');
    expect(recorder.status().diskStop).toBeNull();
    // The reading it publishes is `unknown` rather than a fabricated zero, which is
    // what stops every predicate downstream from acting on it.
    const published = statuses(contents).filter((s) => s.disk !== null);
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((s) => s.disk?.level === 'unknown')).toBe(true);
    expect(published.every((s) => s.disk?.space === null)).toBe(true);

    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, endedMessage(frames));
    await stopping;
    await untilState(id, 'editable');
    expect((await readRecordingDoc(id)).tracks.screen?.parts[0]?.endedEarly).toBe(false);
  });

  it('stops only once, however many polls land below the floor', async () => {
    // The latch. A second stop would run a second finalize over a bundle that has
    // already been closed.
    const volume = new FakeVolume(free(40 * GB));
    useVolume(volume);
    const { id, contents, frames } = await recordFrames(40);

    volume.push(free(0.2 * GB));
    await until(
      () =>
        contents.sent.some(
          (m) =>
            m.channel === CHANNEL.captureCommand &&
            (m.payload as { kind?: string } | undefined)?.kind === 'stop',
        ),
      'the capture page to be told to stop',
    );
    const stops = contents.sent.filter(
      (m) =>
        m.channel === CHANNEL.captureCommand &&
        (m.payload as { kind?: string } | undefined)?.kind === 'stop',
    ).length;
    emit(CHANNEL.captureEnded, contents, endedMessage(frames));
    await untilState(id, 'editable');

    expect(stops).toBe(1);
    // And the monitor stopped watching, so no further poll can arrive against a
    // recording that no longer exists.
    const after = volume.served.length;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
    expect(volume.served.length).toBe(after);
  });
});

describe('a read that never answers', () => {
  /**
   * The readings the recorder actually published, one per completed poll.
   *
   * By identity rather than by count of statuses: `publish()` also fires on a phase
   * change and re-sends whatever `lastDisk` holds, and counting those would make "the
   * monitor kept polling" true of a monitor that had stopped. Each poll classifies a
   * fresh `DiskReading` object, and nothing here serializes, so a new object is a new
   * poll.
   */
  function readings(contents: FakeContents): DiskReading[] {
    const distinct: DiskReading[] = [];
    for (const status of statuses(contents)) {
      if (status.disk !== null && status.disk !== distinct[distinct.length - 1]) {
        distinct.push(status.disk);
      }
    }
    return distinct;
  }

  /**
   * The two properties that must hold together, and which a future change must not be
   * able to trade against each other.
   *
   * A monitor that has stopped polling is indistinguishable from a volume with
   * nothing to report — that is what made the original defect silent — so (a) is that
   * polls keep completing and readings keep reaching the HUD. But a poll that answers
   * its own deadline abandons the `fs` request underneath it, and nothing in Node can
   * retire one, so (b) is that those do not pile up on the threadpool `ProjectStore`'s
   * media writes share.
   */
  async function expectStillWatching(
    volume: StalledVolume,
    contents: FakeContents,
    level: 'unknown' | 'ok',
  ): Promise<void> {
    await until(() => readings(contents).length >= 4, 'the monitor to keep publishing readings');
    expect(readings(contents).every((reading) => reading.level === level)).toBe(true);
    expect(volume.peakOutstanding).toBeLessThanOrEqual(1);
    expect(recorder.status().phase).toBe('recording');
    expect(recorder.status().diskStop).toBeNull();
  }

  /** §7.2's stop, from the moment the volume finally answers below the floor. */
  async function expectStopAtTheFloor(
    volume: StalledVolume,
    id: RecordingId,
    contents: FakeContents,
    frames: FixtureFrame[],
  ): Promise<void> {
    volume.release(free(0.4 * GB));
    await until(() => stopCommands(contents) > 0, 'the capture page to be told to stop');
    emit(CHANNEL.captureEnded, contents, endedMessage(frames));
    await untilState(id, 'editable');
    await until(() => recorder.status().phase === 'idle', 'the recorder to return to idle');

    const part = (await readRecordingDoc(id)).tracks.screen?.parts[0];
    expect(part?.endedEarly).toBe(true);
    expect(part?.endReason).toBe('disk-full');
  }

  it('keeps polling, keeps publishing, and still stops below the floor', async () => {
    // The defect: `poll` guarded re-entry with a flag it released only when the read
    // settled, so one read that never did left every later tick returning
    // immediately — no reading, no banner, no log line, and §7.2's clean stop
    // unreachable on a disk that is filling. A safety net that switches itself off
    // under the one condition it exists for is worse than none, because the user is
    // told nothing and believes they are covered.
    const volume = new StalledVolume();
    useReader(volume.read);
    const { id, contents, frames } = await recordFrames(40);
    await expectStillWatching(volume, contents, 'unknown');
    // The read-level half, stated exactly: one request went to the volume and every
    // later poll joined it rather than parking another beside it.
    expect(volume.calls).toBe(1);
    await expectStopAtTheFloor(volume, id, contents, frames);
  });

  it('does the same on a volume that answers — the control the stall is measured against', async () => {
    // Every assertion above is also true of an ordinary volume, so on its own the
    // run says nothing about either guard. This is that ordinary volume, driven
    // through the identical helpers: what is left over — readings banded `unknown`
    // while the reads hung, and one underlying read instead of many — is the finding.
    const volume = new StalledVolume();
    volume.release(free(40 * GB));
    useReader(volume.read);
    const { id, contents, frames } = await recordFrames(40);
    await expectStillWatching(volume, contents, 'ok');
    // And the control for the line above: a volume that answers is read afresh every
    // poll, so `calls === 1` there is the stall and not a guard that stopped reading.
    expect(volume.calls).toBeGreaterThan(1);
    await expectStopAtTheFloor(volume, id, contents, frames);
  });
});

describe("the capacity estimate's provenance", () => {
  it("uses the user's own library before this recording can answer for itself", async () => {
    // §7.2's estimate is measured or it is a sentence about somebody else's screen —
    // §5.6 measured a 35× spread. A recording under `MEASURED_RATE_FLOOR_SEC` has
    // nothing of its own to divide, and what answers instead is this user's finished
    // recordings rather than the research constant.
    useVolume(new FakeVolume(free(40 * GB)));
    const first = await recordFrames(40);
    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, first.contents, endedMessage(first.frames));
    await stopping;
    await untilState(first.id, 'editable');

    // A second recording, whose own bytes cannot answer yet: 40 frames at 30 fps is
    // 1.3 s, well under `MEASURED_RATE_FLOOR_SEC`.
    useVolume(new FakeVolume(free(40 * GB)));
    const second = await recordFrames(40);
    await until(
      () => recorder.status().disk?.rate.source === 'measured',
      "the estimate to be answered from the user's own library",
    );
    const rate = recorder.status().disk?.rate;
    expect(rate?.source).toBe('measured');
    expect(rate?.sampleCount).toBeGreaterThan(0);
    expect(rate?.bytesPerSec).toBeGreaterThan(0);

    const stoppingSecond = recorder.stop();
    emit(CHANNEL.captureEnded, second.contents, endedMessage(second.frames));
    await stoppingSecond;
    await untilState(second.id, 'editable');
  });

  it('says `reference` on a library with nothing in it — the first run, and only it', async () => {
    // The control. Without it "measured" above could be the label this path always
    // carries rather than the answer this library gave.
    useVolume(new FakeVolume(free(40 * GB)));
    const { id, contents, frames } = await recordFrames(40);
    await until(() => recorder.status().disk !== null, 'the monitor to publish a reading');
    expect(recorder.status().disk?.rate.source).toBe('reference');
    expect(recorder.status().disk?.rate.sampleCount).toBe(0);

    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, endedMessage(frames));
    await stopping;
    await untilState(id, 'editable');
  });

  it('starts the recording anyway when the library walk never answers', async () => {
    // The estimate's measurement is `store.list()` — `readdir` and `stat` over every
    // bundle — and on the volume this whole feature is about those hang exactly as
    // `statfs` does. Awaiting one on the start path is a Record button that never
    // comes back, with no recording and nothing on screen saying why: strictly worse
    // than the constant it was replacing. What a wedged library may cost is the
    // *provenance* of a number and nothing else.
    //
    // Its control is the test two above: the same path, with a library that answers,
    // reaches `measured` — so `reference` here is the hang rather than the wiring.
    useVolume(new FakeVolume(free(40 * GB)));
    const list = vi.spyOn(store, 'list').mockImplementation(() => new Promise(() => undefined));
    try {
      const startedAt = Date.now();
      const { id, contents, frames } = await recordFrames(40);
      // Bounded against the walk's *own* deadline rather than against a number picked
      // here. A start that waits for the walk cannot come back before
      // `LIBRARY_RATE_DEADLINE_MS`; one that does not lands in tens of milliseconds.
      // Half the deadline sits between the two with two orders of magnitude of room
      // on the side this host can affect.
      expect(Date.now() - startedAt).toBeLessThan(LIBRARY_RATE_DEADLINE_MS / 2);
      expect(recorder.status().phase).toBe('recording');
      expect(recorder.status().disk?.rate.source).toBe('reference');

      const stopping = recorder.stop();
      emit(CHANNEL.captureEnded, contents, endedMessage(frames));
      await stopping;
      list.mockRestore();
      await untilState(id, 'editable');
    } finally {
      list.mockRestore();
    }
  });
});

describe('the preflight reading a window awaits', () => {
  /**
   * `readDiskForPreflight` is `recorder.preflight`'s half of the answer, and it is
   * the one path here where somebody is *waiting* on the other side of IPC. A
   * `statfs` with no bound on it is therefore not a missing reading but a reply that
   * never arrives: `refreshPermissions()` never returns — its `try`/`catch` covers
   * throws, not hangs — and the library awaits it ahead of `refreshRecovery()`, so
   * §7.1's recovery banner and §7.2's capacity line both fail to render with nothing
   * in the log. Same sentence as the stalled poll, one process further out.
   */
  it(
    'comes back as `unknown` rather than not coming back',
    async () => {
      const space = vi
        .spyOn(store, 'diskSpace')
        .mockImplementation(() => new Promise(() => undefined));
      try {
        const startedAt = Date.now();
        const reading = await readDiskForPreflight(store);
        // The volume read has a deadline of its own, well under the library walk's —
        // so landing inside the walk's bound says the `statfs` was stopped by its own
        // rather than by anything downstream of it. An unbounded one never lands.
        expect(Date.now() - startedAt).toBeLessThan(LIBRARY_RATE_DEADLINE_MS);
        expect(reading.level).toBe('unknown');
        expect(reading.space).toBeNull();
        expect(reading.capacitySec).toBeNull();
        // And `unknown` refuses nothing, so a volume we could not measure does not
        // become a volume we refuse to record on.
        expect(diskRefusesStart(reading)).toBe(false);
      } finally {
        space.mockRestore();
      }
    },
    LIBRARY_RATE_DEADLINE_MS + 5_000,
  );

  it('reads a volume that answers — the control the stall is measured against', async () => {
    // Without this, "the reading came back `unknown`" is a claim about this function
    // always saying `unknown` rather than about the volume that would not answer.
    const space = vi
      .spyOn(store, 'diskSpace')
      .mockResolvedValue({ freeBytes: 40 * GB, totalBytes: 500 * GB });
    try {
      const reading = await readDiskForPreflight(store);
      expect(reading.level).toBe('ok');
      expect(reading.space?.freeBytes).toBe(40 * GB);
      expect(reading.capacitySec).not.toBeNull();
    } finally {
      space.mockRestore();
    }
  });

  it('issues one underlying read while a stalled one is outstanding', async () => {
    // The second guard, on this path too: a deadline abandons a read and cannot
    // retire it, so two windows refreshing against a wedged volume must not park two
    // requests on the threadpool `ProjectStore`'s media writes share.
    const space = vi
      .spyOn(store, 'diskSpace')
      .mockImplementation(() => new Promise(() => undefined));
    try {
      const both = await Promise.all([readDiskForPreflight(store), readDiskForPreflight(store)]);
      expect(both.every((reading) => reading.level === 'unknown')).toBe(true);
      expect(space).toHaveBeenCalledTimes(1);
    } finally {
      space.mockRestore();
    }
  });
});

describe("§7.2's preflight", () => {
  it('refuses to start below 3 GB, and leaves no bundle behind', async () => {
    useVolume(new FakeVolume(free(2.1 * GB)));
    await expect(recorder.start({ fps: fixture.fps })).rejects.toThrow(/2\.1 GB free/);
    // Refused before `store.create`, so a refusal costs nothing on disk.
    expect(await store.list()).toEqual([]);
    expect(recorder.status().phase).toBe('idle');
  });

  it('allows a start inside the banner band', async () => {
    // §7.2 read literally: the floor is 3 GB and the banner is 5 GB, so 4 GB starts
    // and warns. A refusal here would make the banner unreachable at the start of a
    // recording — the control that keeps the refusal above about 3 GB specifically.
    const volume = new FakeVolume(free(4 * GB));
    useVolume(volume);
    const { id, contents, frames } = await recordFrames(20);
    await until(
      () => statuses(contents).some((s) => s.disk?.level === 'low'),
      'the low-disk banner to be published',
    );
    expect(recorder.status().phase).toBe('recording');

    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, endedMessage(frames));
    await stopping;
    await untilState(id, 'editable');
  });

  it('starts when the volume cannot be read', async () => {
    // Same accessory rule, at the other end of the lifecycle: an unreadable volume
    // must not be the thing that stops somebody recording.
    useVolume(new FakeVolume(new Error('statfs: EIO')));
    const id = await recorder.start({ fps: fixture.fps });
    expect(recorder.status().phase).toBe('recording');
    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, captureContents(), {
      reason: 'stopped',
      endedAtUs: 0,
      framesEncoded: 0,
      framesDropped: 0,
      epochOffsetUs: 0,
    });
    await stopping;
    // No frames, so this one legitimately fails — the assertion is that it got as
    // far as recording at all, which the line above already made.
    expect(id).toBeTruthy();
  });
});

describe('the thresholds this gate drove', () => {
  it("are §7.2's, so the scenarios above are about the report", () => {
    // The scenarios pick 40 GB / 4 GB / 0.4 GB and 2.1 GB because of these. Stated
    // here so a change to the constants makes this file's arithmetic visibly wrong
    // rather than quietly meaningless.
    expect(DISK_THRESHOLDS.bannerBytes).toBe(5 * GB);
    expect(DISK_THRESHOLDS.stopBytes).toBe(1 * GB);
    expect(DISK_THRESHOLDS.refuseStartBytes).toBe(3 * GB);
  });
});
