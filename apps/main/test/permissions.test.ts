/**
 * `PermissionManager` — the request driver, with `electron` replaced.
 *
 * What is worth asserting here is not "it calls the API". It is the three places
 * where calling the wrong API is a silent product bug:
 *
 * 1. **The status check must not prompt.** `isTrustedAccessibilityClient(true)` fires
 *    a system dialog. It is called on every launch, every window focus and every
 *    refresh of the setup window, so a `true` here is a dialog the user did not ask
 *    for, several times a session (research report §5.3, note 6).
 * 2. **Each permission is asked for the way macOS allows.** Camera and mic have a
 *    real prompt; Screen Recording has none and prompts on first capture;
 *    Accessibility has neither. An "Allow" button wired to the wrong one is a button
 *    that does nothing.
 * 3. **A renderer never names the URL that gets opened.** `shell.openExternal` hands
 *    what it is given to the OS handler for the scheme, so the renderer names a
 *    permission and main looks up one of four exact strings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL, DEFAULT_CAPTURE_OPTIONS } from '@loom/ipc';
import { PERMISSIONS } from '@loom/permissions';
import { ProjectStore } from '../src/project-store.ts';

type Listener = (event: unknown, payload?: unknown) => void;
type Handler = (event: unknown, payload?: unknown) => unknown;

const harness = vi.hoisted(() => ({
  listeners: new Map<string, Listener[]>(),
  handlers: new Map<string, Handler>(),
  /** What `getMediaAccessStatus` answers, per kind. Mutable so tests can revoke. */
  media: new Map<string, string>(),
  axTrusted: false,
  /** Every `isTrustedAccessibilityClient` call, with the prompt flag it was given. */
  axCalls: [] as boolean[],
  askedFor: [] as string[],
  opened: [] as string[],
  enumerations: 0,
  packaged: true,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return harness.packaged;
    },
  },
  desktopCapturer: {
    getSources: () => {
      harness.enumerations += 1;
      return Promise.resolve([]);
    },
  },
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
  shell: {
    openExternal: (url: string) => {
      harness.opened.push(url);
      return Promise.resolve();
    },
  },
  systemPreferences: {
    getMediaAccessStatus: (kind: string) => harness.media.get(kind) ?? 'not-determined',
    isTrustedAccessibilityClient: (prompt: boolean) => {
      harness.axCalls.push(prompt);
      return harness.axTrusted;
    },
    askForMediaAccess: (kind: string) => {
      harness.askedFor.push(kind);
      return Promise.resolve(true);
    },
  },
}));

const { PermissionManager } = await import('../src/permissions.ts');

let scratch: string;
let store: ProjectStore;
let relaunches = 0;
let broadcasts = 0;
let handovers = 0;
let setupOpens = 0;

type TapProbe = () => Promise<{ clicks: { axTrusted: boolean; tapEnabled: boolean } }>;

function makeManager(
  clickTapProbe: TapProbe | null = null,
  over: ProjectStore = store,
): InstanceType<typeof PermissionManager> {
  return new PermissionManager({
    store: over,
    clickTapProbe,
    relaunchApp: () => {
      relaunches += 1;
    },
    broadcast: () => {
      broadcasts += 1;
    },
    onSetupComplete: () => {
      handovers += 1;
    },
    onOpenSetup: () => {
      setupOpens += 1;
    },
  });
}

/** A store over the same settings file, as the process that comes back builds one. */
function reopenStore(): ProjectStore {
  return new ProjectStore({
    recordingsRoot: join(scratch, 'recordings'),
    settingsPath: join(scratch, 'settings.json'),
    appVersion: '0.1.0',
    trash: () => Promise.resolve(),
  });
}

beforeEach(async () => {
  harness.listeners.clear();
  harness.handlers.clear();
  harness.media.clear();
  harness.axCalls.length = 0;
  harness.askedFor.length = 0;
  harness.opened.length = 0;
  harness.enumerations = 0;
  harness.axTrusted = false;
  harness.packaged = true;
  relaunches = 0;
  broadcasts = 0;
  handovers = 0;
  setupOpens = 0;

  scratch = await mkdtemp(join(tmpdir(), 'loom-perm-'));
  store = reopenStore();
  await store.loadSettings();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('probing', () => {
  it('reads all four and never prompts while doing it', async () => {
    harness.media.set('screen', 'granted');
    harness.media.set('camera', 'denied');
    harness.media.set('microphone', 'restricted');

    const report = await makeManager().probe();

    expect(report.statuses).toEqual({
      screen: 'granted',
      camera: 'denied',
      microphone: 'restricted',
      accessibility: 'denied',
    });
    // Every AX read during a probe passes `false`. One `true` here is a dialog on
    // every window focus.
    expect(harness.axCalls).toEqual([false]);
  });

  it('turns an unrecognised answer into unknown rather than a guess', async () => {
    harness.media.set('screen', 'something-new');
    const report = await makeManager().probe();
    expect(report.statuses.screen).toBe('unknown');
  });

  it('leaves tapLive null when nothing can look, rather than claiming false', async () => {
    // "no sampler in this build" and "the tap is dead" drive different UI: the second
    // offers a relaunch. Collapsing them would offer one to everybody.
    harness.axTrusted = true;
    const report = await makeManager().probe();
    expect(report.accessibility.tapLive).toBeNull();
    expect(report.accessibility.axTrusted).toBe(true);
  });

  it('uses the click probe when one is wired', async () => {
    harness.axTrusted = true;
    const report = await makeManager(() =>
      Promise.resolve({ clicks: { axTrusted: true, tapEnabled: false } }),
    ).probe();
    expect(report.accessibility.tapLive).toBe(false);
  });

  it('falls back to null when the probe throws, not to false', async () => {
    harness.axTrusted = true;
    const report = await makeManager(() => Promise.reject(new Error('helper died'))).probe();
    expect(report.accessibility.tapLive).toBeNull();
  });

  it('does not fork a helper per probe', async () => {
    // `refresh()` runs on every window focus and the tap leg spawns the native
    // sampler, so an unguarded probe forks a process per alt-tab — during a recording,
    // beside the helper the sampler is already running. Concurrent probes share one
    // run, and a probe moments later reuses its answer.
    let spawns = 0;
    const manager = makeManager(() => {
      spawns += 1;
      return Promise.resolve({ clicks: { axTrusted: false, tapEnabled: false } });
    });

    await Promise.all([manager.probe(), manager.probe(), manager.probe()]);
    await manager.probe();

    expect(spawns).toBe(1);
  });

  it('re-runs the tap probe when axTrusted changes, because that is its input', async () => {
    let spawns = 0;
    const manager = makeManager(() => {
      spawns += 1;
      return Promise.resolve({ clicks: { axTrusted: harness.axTrusted, tapEnabled: true } });
    });

    await manager.probe();
    harness.axTrusted = true;
    await manager.probe();

    expect(spawns).toBe(2);
  });

  it('marks a dev binary untrustworthy however good the answers look', async () => {
    harness.packaged = false;
    for (const kind of ['screen', 'camera', 'microphone']) harness.media.set(kind, 'granted');
    harness.axTrusted = true;

    const report = await makeManager().probe();
    expect(report.provenance.packaged).toBe(false);
  });
});

describe('requesting', () => {
  it('uses the real prompt for camera and microphone', async () => {
    const manager = makeManager();
    await manager.request('camera');
    await manager.request('microphone');
    expect(harness.askedFor).toEqual(['camera', 'microphone']);
  });

  it('asks for screen by trying to enumerate, because there is no request API', async () => {
    await makeManager().request('screen');
    expect(harness.askedFor).toEqual([]);
    expect(harness.enumerations).toBe(1);
  });

  it('spends the one Accessibility nudge, and records that it did', async () => {
    await makeManager().request('accessibility');
    // The only call in this codebase that passes `true`, and only from an explicit
    // request.
    expect(harness.axCalls.filter(Boolean)).toHaveLength(1);
    expect(store.setup.accessibilityOpenedAt).not.toBeNull();
  });

  it('offers the relaunch for the rest of the session that asked', async () => {
    const manager = makeManager();
    const report = await manager.request('accessibility');
    expect(report.accessibility.settingsOpened).toBe(true);
    // And still, several probes later: the question is open until a new process
    // looks.
    expect((await manager.probe()).accessibility.settingsOpened).toBe(true);
  });

  it('spends the persisted ask on the relaunch it was waiting for', async () => {
    await makeManager().request('accessibility');

    // The process that comes back, built the way `index.ts` builds one: a fresh store
    // over the same settings file, and — the part that matters — a manager
    // constructed *before* those settings have been read, because loading them is
    // asynchronous and the manager is not. It has to read the persisted ask, which is
    // the only reason there is anything here to spend.
    const restarted = reopenStore();
    const afterRestart = makeManager(null, restarted);
    await restarted.loadSettings();

    // The relaunch has happened and `axTrusted` is still false, so it has answered:
    // the grant was not given. Left standing, the timestamp pins every future launch
    // in `relaunch-to-find-out` — a Relaunch button that can never change anything,
    // beside a refusal card that never closes.
    const report = await afterRestart.probe();
    expect(report.accessibility.settingsOpened).toBe(false);

    await afterRestart.whenSettled();
    expect(restarted.setup.accessibilityOpenedAt).toBeNull();
    // On disk too, not just in the store this manager holds.
    const reread = reopenStore();
    await reread.loadSettings();
    expect(reread.setup.accessibilityOpenedAt).toBeNull();
  });

  it('does not spend it when the relaunch came back with the grant', async () => {
    await makeManager().request('accessibility');

    harness.axTrusted = true;
    const restarted = reopenStore();
    const afterRestart = makeManager(null, restarted);
    await restarted.loadSettings();

    const report = await afterRestart.probe();
    expect(report.accessibility.axTrusted).toBe(true);
    await afterRestart.whenSettled();
    expect(restarted.setup.accessibilityOpenedAt).not.toBeNull();
  });

  it('asking again after the ask was spent re-arms the relaunch offer', async () => {
    await makeManager().request('accessibility');
    const restarted = reopenStore();
    const afterRestart = makeManager(null, restarted);
    await restarted.loadSettings();
    await afterRestart.probe();

    const report = await afterRestart.request('accessibility');
    expect(report.accessibility.settingsOpened).toBe(true);
    expect(restarted.setup.accessibilityOpenedAt).not.toBeNull();
  });
});

describe('opening System Settings', () => {
  it('opens the pane for the permission, and only ever one of four exact urls', async () => {
    const manager = makeManager();
    manager.openSettings('screen');
    manager.openSettings('accessibility');
    expect(harness.opened).toEqual([
      PERMISSIONS.screen.settingsUrl,
      PERMISSIONS.accessibility.settingsUrl,
    ]);
    // The accessibility pane records the ask, and `openSettings` does not wait for
    // that write. Leaving it in flight lets it land inside `scratch` while
    // `afterEach` is removing the directory — an ENOTEMPTY from `rmdir`, in whichever
    // test happens to be unlucky.
    await manager.whenSettled();
  });

  it('drops a bad kind from a renderer rather than opening anything', () => {
    makeManager().install();
    const listener = harness.listeners.get(CHANNEL.permissionsOpenSettings)?.[0];
    listener?.({}, 'file:///etc/passwd');
    listener?.({}, { kind: 'screen' });
    expect(harness.opened).toEqual([]);
  });

  it('records the ask when the Accessibility pane is what was opened', async () => {
    const camera = makeManager();
    camera.openSettings('camera');
    await camera.whenSettled();
    expect(store.setup.accessibilityOpenedAt).toBeNull();

    const accessibility = makeManager();
    accessibility.openSettings('accessibility');
    await accessibility.whenSettled();
    expect(harness.opened).toContain(PERMISSIONS.accessibility.settingsUrl);
    expect(store.setup.accessibilityOpenedAt).not.toBeNull();
  });

  it('does not relaunch until that ask has actually been written', async () => {
    // "Open System Settings" and "Relaunch" are adjacent buttons. A quit that beat
    // the write would come back having forgotten it ever asked, and show the user
    // "Allow" again instead of the relaunch they just performed.
    const manager = makeManager();
    manager.openSettings('accessibility');
    manager.relaunch();
    expect(relaunches).toBe(0);

    await manager.whenSettled();
    // One more turn for the relaunch chained after it.
    await Promise.resolve();
    await Promise.resolve();
    expect(relaunches).toBe(1);
    expect(store.setup.accessibilityOpenedAt).not.toBeNull();
  });
});

describe('preflight', () => {
  it('says what blocks and what merely degrades', async () => {
    harness.media.set('screen', 'granted');
    harness.media.set('camera', 'denied');
    const result = await makeManager().preflight(DEFAULT_CAPTURE_OPTIONS);
    expect(result.ready).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(result.degraded).toContain('camera');
  });

  it('is not ready without Screen Recording', async () => {
    harness.media.set('screen', 'denied');
    const result = await makeManager().preflight(DEFAULT_CAPTURE_OPTIONS);
    expect(result.ready).toBe(false);
    expect(result.blocking).toEqual(['screen']);
  });
});

describe('the ipc surface', () => {
  it('registers every channel it owns and removes them again', () => {
    const manager = makeManager();
    manager.install();
    const owned = [
      CHANNEL.permissionsProbe,
      CHANNEL.permissionsRequest,
      CHANNEL.recorderPreflight,
      CHANNEL.setupState,
      CHANNEL.setupComplete,
    ];
    for (const channel of owned) expect(harness.handlers.has(channel)).toBe(true);
    expect(harness.listeners.has(CHANNEL.permissionsOpenSettings)).toBe(true);
    expect(harness.listeners.has(CHANNEL.permissionsRelaunch)).toBe(true);
    expect(harness.listeners.has(CHANNEL.setupOpen)).toBe(true);

    manager.uninstall();
    for (const channel of owned) expect(harness.handlers.has(channel)).toBe(false);
  });

  it('relaunches through the injected quit, so the shutdown ordering is main’s', async () => {
    const manager = makeManager();
    manager.install();
    harness.listeners.get(CHANNEL.permissionsRelaunch)?.[0]?.({});
    await manager.whenSettled();
    await Promise.resolve();
    expect(relaunches).toBe(1);
  });

  it('refuses an unknown permission from a renderer', async () => {
    makeManager().install();
    const handler = harness.handlers.get(CHANNEL.permissionsRequest);
    await expect(Promise.resolve(handler?.({}, 'bluetooth'))).rejects.toThrow(
      /unknown permission/i,
    );
  });

  it('reopens setup on request, so a refusal is not a dead end', () => {
    // A user who pressed Continue with Screen Recording refused has a recorder that
    // cannot record. The library's route back is this channel.
    makeManager().install();
    harness.listeners.get(CHANNEL.setupOpen)?.[0]?.({});
    expect(setupOpens).toBe(1);
  });

  it('persists setup completion before handing over to the library', async () => {
    makeManager().install();
    await harness.handlers.get(CHANNEL.setupComplete)?.({});

    expect(handovers).toBe(1);
    // On disk, not just in memory: a crash between the two must cost a second look at
    // the setup window, never a user who cannot leave it.
    const onDisk: unknown = JSON.parse(await readFile(join(scratch, 'settings.json'), 'utf8'));
    expect(onDisk).toMatchObject({ setup: { completedAt: expect.any(String) as unknown } });
  });
});

describe('refresh', () => {
  it('pushes only when something actually changed', async () => {
    const manager = makeManager();
    await manager.refresh();
    expect(broadcasts).toBe(1); // the first probe has nothing to compare against

    await manager.refresh();
    expect(broadcasts).toBe(1);

    harness.media.set('camera', 'granted');
    await manager.refresh();
    expect(broadcasts).toBe(2);
  });
});
