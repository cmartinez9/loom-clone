/**
 * The window registry, and the flag phase 1 depends on.
 *
 * `setContentProtection(true)` sets `NSWindowSharingNone`, which is the only thing
 * keeping our own recorder HUD out of the recording it is controlling. The
 * architecture report flags it as **assumed, not verified** (§11) — so the least we
 * can do is prove we actually set it, on every window the §1.2 table says gets it,
 * and on no window it says does not.
 *
 * `electron` is replaced with a recording double rather than launched: this asserts
 * what the registry *does*, which is the half that can silently rot. Whether
 * `NSWindowSharingNone` really hides a window from ScreenCaptureKit is a question
 * for a signed build, and phase 2's gate is where that is answered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Recorded {
  options: Record<string, unknown>;
  contentProtection: boolean[];
  loaded: string[];
}

vi.mock('electron', () => {
  const created: Recorded[] = [];
  let nextId = 0;

  class FakeWebContents {
    readonly id = ++nextId;
    setWindowOpenHandler(): void {
      /* recorded by nothing; the navigation policy has its own coverage */
    }
    on(): this {
      return this;
    }
  }

  class FakeBrowserWindow {
    readonly webContents = new FakeWebContents();
    private readonly record: Recorded;

    constructor(options: Record<string, unknown>) {
      this.record = { options, contentProtection: [], loaded: [] };
      created.push(this.record);
    }
    setContentProtection(enabled: boolean): void {
      this.record.contentProtection.push(enabled);
    }
    loadURL(url: string): Promise<void> {
      this.record.loaded.push(url);
      return Promise.resolve();
    }
    once(): this {
      return this;
    }
    on(): this {
      return this;
    }
    show(): void {
      /* no-op */
    }
    focus(): void {
      /* no-op */
    }
    destroy(): void {
      /* no-op */
    }
    isDestroyed(): boolean {
      return false;
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: () => Promise.resolve() },
    __created: created,
  };
});

const electron = (await import('electron')) as unknown as { __created: Recorded[] };
const { WINDOW_ROLES, WindowRegistry } = await import('../src/windows.ts');
type WindowRole = keyof typeof WINDOW_ROLES;

beforeEach(() => {
  electron.__created.length = 0;
});

/** The §1.2 table, restated here so a change to the source has to be deliberate. */
const EXPECTED_PROTECTION: Record<WindowRole, boolean> = {
  library: false,
  'recorder-hud': true,
  countdown: true,
  'drawing-overlay': true,
  capture: false,
  editor: false,
  export: false,
};

describe('content protection', () => {
  it('declares it exactly where architecture report §1.2 says', () => {
    for (const [role, expected] of Object.entries(EXPECTED_PROTECTION)) {
      expect(
        WINDOW_ROLES[role as WindowRole].contentProtected,
        `role ${role} disagrees with the §1.2 table`,
      ).toBe(expected);
    }
    // And there are no roles beyond the table: a new window is a row here, not a
    // window that quietly defaults to appearing in every recording.
    expect(Object.keys(WINDOW_ROLES).sort()).toEqual(Object.keys(EXPECTED_PROTECTION).sort());
  });

  it('turns it on for the recorder HUD, which is the window phase 1 needs hidden', () => {
    const registry = new WindowRegistry({ preloadPath: '/preload.cjs' });
    registry.show('recorder-hud');

    const hud = electron.__created[0];
    expect(hud?.contentProtection, 'setContentProtection was never called for the HUD').toEqual([
      true,
    ]);
    expect(hud?.loaded).toEqual(['loom://app/recorder.html']);
  });

  it('leaves it off for the library, so an ordinary window is not silently hidden', () => {
    const registry = new WindowRegistry({ preloadPath: '/preload.cjs' });
    registry.show('library');
    expect(electron.__created[0]?.contentProtection).toEqual([]);
  });

  it('turns it on for every role the table marks, and no others', () => {
    for (const role of Object.keys(EXPECTED_PROTECTION) as WindowRole[]) {
      electron.__created.length = 0;
      new WindowRegistry({ preloadPath: '/preload.cjs' }).show(role);
      const calls = electron.__created[0]?.contentProtection ?? [];
      expect(calls, `role ${role}`).toEqual(EXPECTED_PROTECTION[role] ? [true] : []);
    }
  });
});

describe('the capture window', () => {
  it('is hidden, tiny and sandboxed', () => {
    const registry = new WindowRegistry({ preloadPath: '/preload.cjs' });
    registry.show('capture');
    const options = electron.__created[0]?.options ?? {};

    expect(WINDOW_ROLES.capture.visible).toBe(false);
    expect(options['show']).toBe(false);
    // The structural half of "renderers cannot write to disk" (§0, rule 2).
    const web = options['webPreferences'] as Record<string, unknown>;
    expect(web['sandbox']).toBe(true);
    expect(web['contextIsolation']).toBe(true);
    expect(web['nodeIntegration']).toBe(false);
    expect(web['nodeIntegrationInWorker']).toBe(false);
    expect(electron.__created[0]?.loaded).toEqual(['loom://app/capture.html']);
  });
});
