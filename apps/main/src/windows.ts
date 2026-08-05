/**
 * The window registry. Architecture report §1.2.
 *
 * | Window          | Visible | `setContentProtection` | Job |
 * |-----------------|---------|------------------------|-----|
 * | Library         | yes     | no                     | Recording list, sizes, export state, retention warnings |
 * | Recorder HUD    | yes     | **yes**                | Source/device pickers, start/stop, timer, meters, camera preview |
 * | Countdown       | yes     | **yes**                | 3-2-1 |
 * | Drawing overlay | yes     | **yes**                | Transparent, full-screen, click-through except while drawing |
 * | Capture         | **no**  | n/a                    | `getDisplayMedia` → `MediaStreamTrackProcessor` → encoders |
 * | Editor          | yes     | no                     | Timeline model, WebGL2 preview, all editing |
 * | Export          | **no**  | n/a                    | One hidden window per job; own GL context, decoder, encoder |
 *
 * `setContentProtection(true)` sets `NSWindowSharingNone`, which is how our own UI
 * stays out of the recording. **The whole table is declared here in phase 0** even
 * though phase 0 only opens the library: the flag being wrong is the kind of bug
 * that ships, and a later phase adding a window should be picking a role, not
 * rediscovering the policy.
 *
 * Two rules the registry enforces for every window it makes:
 *
 * - **`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.** This
 *   is the structural half of "main is the only writer": a renderer has no
 *   filesystem to reach.
 * - **The export window is owned by main, not by the editor** (§1.2). Closing the
 *   editor mid-export must not kill the export.
 */

import { BrowserWindow, nativeTheme, shell, type BrowserWindowConstructorOptions } from 'electron';
import { appUrl } from '@loom/ipc';

export type WindowRole =
  'library' | 'recorder-hud' | 'countdown' | 'drawing-overlay' | 'capture' | 'editor' | 'export';

interface RoleSpec {
  /** Renderer page under `dist/renderer/`. */
  page: string;
  visible: boolean;
  /** `NSWindowSharingNone` — keeps our own UI out of the recording. */
  contentProtected: boolean;
  /** More than one window may exist for this role (editors, export jobs). */
  multiple: boolean;
  options: BrowserWindowConstructorOptions;
}

/** Paper in light, near-black in dark — so the first paint is never a white flash. */
function groundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#100E09' : '#F4F0E4';
}

const ROLES: Record<WindowRole, RoleSpec> = {
  library: {
    page: 'library.html',
    visible: true,
    contentProtected: false,
    multiple: false,
    options: {
      width: 980,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
      title: 'Recordings',
    },
  },
  'recorder-hud': {
    page: 'recorder.html',
    visible: true,
    contentProtected: true,
    multiple: false,
    options: { width: 420, height: 92, frame: false, resizable: false, alwaysOnTop: true },
  },
  countdown: {
    page: 'countdown.html',
    visible: true,
    contentProtected: true,
    multiple: false,
    options: { frame: false, transparent: true, alwaysOnTop: true, focusable: false },
  },
  'drawing-overlay': {
    page: 'overlay.html',
    visible: true,
    contentProtected: true,
    multiple: false,
    options: { frame: false, transparent: true, alwaysOnTop: true, fullscreenable: false },
  },
  capture: {
    page: 'capture.html',
    visible: false,
    contentProtected: false,
    multiple: false,
    options: { show: false, width: 1, height: 1 },
  },
  editor: {
    page: 'editor.html',
    visible: true,
    contentProtected: false,
    multiple: true,
    options: {
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 640,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
    },
  },
  export: {
    page: 'export.html',
    visible: false,
    contentProtected: false,
    multiple: true,
    options: { show: false, width: 1, height: 1 },
  },
};

export interface RegistryOptions {
  preloadPath: string;
}

interface Entry {
  role: WindowRole;
  window: BrowserWindow;
  key: string;
}

export class WindowRegistry {
  private readonly options: RegistryOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  /**
   * Show the window for a role, creating it if needed.
   *
   * `key` distinguishes instances of a multi-instance role — one editor per
   * recording, one hidden window per export job.
   */
  show(role: WindowRole, key = 'default'): BrowserWindow {
    const spec = ROLES[role];
    if (!spec.multiple && key !== 'default') {
      throw new Error(`role ${role} is single-instance; it takes no key`);
    }
    const id = `${role}:${key}`;
    const existing = this.entries.get(id);
    if (existing !== undefined && !existing.window.isDestroyed()) {
      if (spec.visible) existing.window.show();
      existing.window.focus();
      return existing.window;
    }

    const window = new BrowserWindow({
      show: false,
      backgroundColor: groundColor(),
      ...spec.options,
      webPreferences: {
        preload: this.options.preloadPath,
        // The structural half of "renderers cannot write to disk".
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        // Every window is served from `loom://app`, which is a real origin with a
        // strict CSP, so web security stays on and `file://` never appears.
        webSecurity: true,
      },
    });

    if (spec.contentProtected) window.setContentProtection(true);

    // Nothing in this app navigates. A window that can be navigated is a window
    // that can be pointed at someone else's page while holding our preload.
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });

    const entry: Entry = { role, window, key };
    this.entries.set(id, entry);
    window.on('closed', () => {
      this.entries.delete(id);
    });

    if (spec.visible) {
      window.once('ready-to-show', () => {
        window.show();
      });
    }

    // Every window loads from `loom://app`, in development exactly as in a packaged
    // build. `npm run dev` rebuilds into the same `dist/renderer` and reloads,
    // rather than serving from a dev server on another origin — which keeps the
    // origin, the CSP and the asset paths identical in both, so "works in dev,
    // breaks when packaged" has one fewer place to hide.
    void window.loadURL(appUrl(spec.page));
    return window;
  }

  get(role: WindowRole, key = 'default'): BrowserWindow | undefined {
    const entry = this.entries.get(`${role}:${key}`);
    return entry?.window.isDestroyed() === false ? entry.window : undefined;
  }

  /** Every live window, for broadcasting status events. */
  all(): BrowserWindow[] {
    return [...this.entries.values()].filter((e) => !e.window.isDestroyed()).map((e) => e.window);
  }

  /** The role a `WebContents` belongs to, for authorising an IPC call. */
  roleOf(window: BrowserWindow): WindowRole | undefined {
    for (const entry of this.entries.values()) {
      if (entry.window === window) return entry.role;
    }
    return undefined;
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    this.entries.clear();
  }
}

/** Exported for the test that asserts the §1.2 table has not drifted. */
export const WINDOW_ROLES: Readonly<Record<WindowRole, Readonly<RoleSpec>>> = ROLES;
