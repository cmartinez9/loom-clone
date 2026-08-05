/**
 * `RecorderSession` against a real `ProjectStore`, with `electron` replaced.
 *
 * The lifecycle test beside this one drives the store directly, which is the half
 * that decides what ends up on disk. This is the half above it: the message
 * ordering between the capture page and main, which no fixture-driven test can see,
 * because a fixture is not two IPC messages sent in the same turn.
 *
 * That ordering is load-bearing. The capture page sends `meta` and the first chunk
 * for the *same* frame, back to back, and opening the part is two awaits long. A
 * chunk that arrives in that window and is dropped is the part's initial keyframe —
 * and without it nothing before the next one, a second later, decodes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL } from '@loom/ipc';
import {
  validateFrameIndexDoc,
  validateRecordingDoc,
  type ProjectState,
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import { ProjectStore } from '../src/project-store.ts';
import { RecorderSession } from '../src/recorder/session.ts';
import type { WindowRegistry, WindowRole } from '../src/windows.ts';
import {
  loadEncodedFixture,
  type FixtureFrame,
} from '../../../packages/mux/test/helpers/fixture.ts';

interface FakeContents {
  id: number;
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
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      isTrustedAccessibilityClient: () => false,
    },
  };
});

const fixture = loadEncodedFixture();

let nextContentsId = 0;
let scratch: string;
let store: ProjectStore;
let recorder: RecorderSession;

/** The window registry, reduced to what `RecorderSession` actually asks of it. */
const windows = {
  show(role: WindowRole): FakeWindow {
    const existing = harness.windows.get(role);
    if (existing !== undefined) return existing;
    nextContentsId += 1;
    const window: FakeWindow = {
      webContents: { id: nextContentsId, isLoadingMainFrame: () => false, send: () => undefined },
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

function invoke(channel: string, sender: FakeContents, payload?: unknown): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (handler === undefined) throw new Error(`nothing handles ${channel}`);
  return Promise.resolve(handler({ sender }, payload));
}

/** Poll rather than sleep: these writes are local and finish in single-digit ms. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function untilState(id: RecordingId, state: ProjectState): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if ((await store.list()).find((s) => s.id === id)?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${id} to reach ${state}`);
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

beforeEach(async () => {
  harness.listeners.clear();
  harness.handlers.clear();
  harness.windows.clear();
  scratch = await mkdtemp(join(tmpdir(), 'loom-recorder-session-'));
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
    stopTimeoutMs: 2_000,
    statusIntervalMs: 10_000,
  });
  recorder.install();
});

afterEach(async () => {
  recorder.uninstall();
  await store.closeAll().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
});

describe('the capture page talking to main', () => {
  it('keeps the chunks that arrive while the part is still being opened', async () => {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();

    // One turn, exactly as `onEncoded` sends them: the decoder configuration and
    // the frame it was derived from. `onMeta` has not reached `beginMediaPart`
    // yet, let alone returned from it.
    const frames = fixture.frames.slice(0, 20);
    emit(CHANNEL.captureMeta, contents, metaMessage());
    emit(CHANNEL.captureChunk, contents, chunkMessage(frames[0]!));
    emit(CHANNEL.captureChunk, contents, chunkMessage(frames[1]!));
    expect(store.mediaFrameCount(id, 'screen')).toBe(0);

    // The writer holds one sample, so two chunks through it is one frame on the
    // file — and that frame arriving at all is the property under test.
    await until(() => store.mediaFrameCount(id, 'screen') >= 1, 'the held chunks to be written');
    for (const frame of frames.slice(2)) emit(CHANNEL.captureChunk, contents, chunkMessage(frame));
    await until(() => store.mediaFrameCount(id, 'screen') >= frames.length - 1, 'every chunk');

    const last = frames[frames.length - 1]!;
    const stopping = recorder.stop();
    emit(CHANNEL.captureEnded, contents, {
      reason: 'stopped',
      endedAtUs: last.timestampUs + Math.round(1_000_000 / fixture.fps),
      framesEncoded: frames.length,
      framesDropped: 3,
    });
    await stopping;

    const dir = await store.directoryFor(id);
    const index = validateFrameIndexDoc(
      JSON.parse(await readFile(join(dir, 'media/screen.000.index.json'), 'utf8')),
    );
    expect(index.ok ? null : index.issues).toBeNull();
    if (!index.ok) return;
    expect(index.value.pts.length).toBe(frames.length);
    // The part begins on the keyframe, and on *that* keyframe — its size is the
    // first fixture frame's, not the second's.
    expect(index.value.keyframes[0]).toBe(0);
    expect(index.value.sizes[0]).toBe(frames[0]!.data.byteLength);

    const recording = JSON.parse(
      await readFile(join(dir, 'recording.json'), 'utf8'),
    ) as RecordingDoc;
    expect(validateRecordingDoc(recording).ok).toBe(true);
    expect(recording.tracks.screen?.parts[0]?.frameCount).toBe(frames.length);
    // The capture page counted three drops. Three is what is recorded, not six.
    expect(recording.capture.droppedFrames).toEqual({ screen: 3 });
    expect((await store.list()).find((s) => s.id === id)?.state).toBe('editable');
  });

  it('ends the recording loudly rather than holding chunks for a part that never opens', async () => {
    const id = await recorder.start({ fps: fixture.fps });
    const contents = captureContents();

    // No `meta`, so no part. The bound on what may be held is what keeps this from
    // becoming unbounded memory — which is also the memory a `SIGKILL` would cost.
    for (let i = 0; i < 400; i++) {
      emit(CHANNEL.captureChunk, contents, chunkMessage(fixture.frames[i % 60]!));
    }

    await untilState(id, 'failed');
    const summary = (await store.list()).find((s) => s.id === id);
    expect(summary?.state).toBe('failed');
  });
});

describe('who may drive a recording', () => {
  it('refuses recorder.start and recorder.stop from a window that is not a control surface', async () => {
    const capture = windows.show('capture') as unknown as FakeWindow;
    await expect(invoke(CHANNEL.recorderStart, capture.webContents, {})).rejects.toThrow(
      /may not drive a recording/,
    );
    await expect(invoke(CHANNEL.recorderStop, capture.webContents)).rejects.toThrow(
      /may not drive a recording/,
    );
  });

  it('accepts them from the HUD and from the library', async () => {
    for (const role of ['recorder-hud', 'library'] as const) {
      const window = windows.show(role) as unknown as FakeWindow;
      // A stop with nothing recording is a no-op; what is asserted here is that it
      // got past the sender check at all.
      await expect(invoke(CHANNEL.recorderStop, window.webContents)).resolves.toBeUndefined();
    }
  });
});
