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
  /** Every `setContentSize` this window was given, in order. */
  contentSizes: [number, number][];
  window: unknown;
}

vi.mock('electron', () => {
  const created: Recorded[] = [];
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const byContents = new Map<number, unknown>();
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
    private size: [number, number];

    constructor(options: Record<string, unknown>) {
      this.record = {
        options,
        contentProtection: [],
        loaded: [],
        contentSizes: [],
        window: this,
      };
      this.size = [Number(options['width'] ?? 0), Number(options['height'] ?? 0)];
      created.push(this.record);
      byContents.set(this.webContents.id, this);
    }
    static fromWebContents(contents: { id: number }): unknown {
      return byContents.get(contents.id) ?? null;
    }
    setContentProtection(enabled: boolean): void {
      this.record.contentProtection.push(enabled);
    }
    getContentSize(): number[] {
      return [...this.size];
    }
    setContentSize(width: number, height: number): void {
      this.size = [width, height];
      this.record.contentSizes.push([width, height]);
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
    ipcMain: {
      on(channel: string, listener: (event: unknown, ...args: unknown[]) => void) {
        listeners.set(channel, listener);
      },
    },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: () => Promise.resolve() },
    __created: created,
    __listeners: listeners,
  };
});

const electron = (await import('electron')) as unknown as {
  __created: Recorded[];
  __listeners: Map<string, (event: unknown, ...args: unknown[]) => void>;
};
const { WINDOW_ROLES, WindowRegistry } = await import('../src/windows.ts');
type WindowRole = keyof typeof WINDOW_ROLES;

beforeEach(() => {
  electron.__created.length = 0;
});

/** The §1.2 table, restated here so a change to the source has to be deliberate. */
const EXPECTED_PROTECTION: Record<WindowRole, boolean> = {
  // First run happens before any recording can, so there is nothing for it to be
  // hidden from — and a protected window is one a screenshot of a bug report cannot
  // show, which is the wrong trade for the screen that explains four permissions.
  setup: false,
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

/**
 * The half of `installHudNoticeFit` that `test/hud-notice.test.ts` cannot see.
 *
 * That gate measures the pixels a user gets, in a real window, and is the reason
 * this code exists. What it never exercises is a *wrong* sender or a *wrong*
 * number — and both would be silent: the HUD is `alwaysOnTop` over the display it
 * is recording, so a window that grew to a thousand pixels on a stray message
 * would cover the screen with nothing to drag it out of the way by.
 */
describe('the HUD grows only for its own notice', () => {
  function install(): {
    registry: InstanceType<typeof WindowRegistry>;
    fire: (contents: unknown, raw: unknown) => void;
  } {
    const registry = new WindowRegistry({ preloadPath: '/preload.cjs' });
    registry.installHudNoticeFit();
    const listener = electron.__listeners.get('loom.recorder.noticeHeight');
    if (listener === undefined) throw new Error('installHudNoticeFit registered no listener');
    return {
      registry,
      fire: (contents: unknown, raw: unknown) => {
        listener({ sender: contents }, raw);
      },
    };
  }

  it('grows by the reported height and shrinks straight back to 420x92', () => {
    const { registry, fire } = install();
    const hud = registry.show('recorder-hud');

    fire(hud.webContents, 45.5);
    // Rounded up, never down: half a pixel short clips the descenders off the
    // last line of the notice this exists to show.
    expect(hud.getContentSize()).toEqual([420, 138]);

    fire(hud.webContents, 0);
    expect(hud.getContentSize()).toEqual([420, 92]);
  });

  it('ignores a report from any window that is not the HUD', () => {
    const { registry, fire } = install();
    const hud = registry.show('recorder-hud');
    const library = registry.show('library');

    fire(library.webContents, 400);
    expect(hud.getContentSize()).toEqual([420, 92]);
    expect(electron.__created.map((r) => r.contentSizes)).toEqual([[], []]);
  });

  it('clamps a height no notice could have produced', () => {
    const { registry, fire } = install();
    const hud = registry.show('recorder-hud');

    fire(hud.webContents, 10_000);
    expect(hud.getContentSize()[1]).toBeLessThanOrEqual(92 + 200);
    fire(hud.webContents, -500);
    expect(hud.getContentSize()).toEqual([420, 92]);
    // A renderer that sends nonsense is a renderer main ignores, not one that
    // resizes the window to `NaN`.
    fire(hud.webContents, 'tall');
    expect(hud.getContentSize()).toEqual([420, 92]);
  });

  it('does not resize when the shelf has not changed', () => {
    const { registry, fire } = install();
    const hud = registry.show('recorder-hud');
    const record = electron.__created[0];

    fire(hud.webContents, 46);
    fire(hud.webContents, 46);
    fire(hud.webContents, 46);
    expect(record?.contentSizes).toEqual([[420, 138]]);
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
