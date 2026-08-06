/**
 * The window registry. Architecture report §1.2.
 *
 * | Window          | Visible | `setContentProtection` | Job |
 * |-----------------|---------|------------------------|-----|
 * | Setup           | yes     | no                     | First run: the four permissions, explained, asked for together |
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

import {
  BrowserWindow,
  ipcMain,
  nativeTheme,
  shell,
  type BrowserWindowConstructorOptions,
} from 'electron';
import { CHANNEL, appUrl } from '@loom/ipc';

export type WindowRole =
  | 'setup'
  | 'library'
  | 'recorder-hud'
  | 'countdown'
  | 'drawing-overlay'
  | 'capture'
  | 'editor'
  | 'export';

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

/**
 * The recorder HUD's shipping geometry, and the one window in the app that changes
 * size without a user dragging it.
 *
 * §7.4's camera banner and the error line sit on a shelf *below* the 92 px bar, and
 * the HUD clips at its own height — so for as long as this window was a fixed 92 px
 * the banner rendered at y=92 and no pixel of it ever reached the user. Reserving
 * the shelf permanently is the wrong fix: it is 45 px of empty paper floating over
 * the desktop for every recording that goes fine. Main grows the window by the
 * measured height of the shelf while there is something on it, and puts it straight
 * back afterwards. The bar itself never moves — macOS anchors a programmatic resize
 * at the top-left — so the controls stay exactly where the user last saw them.
 */
const HUD_SIZE = { width: 420, height: 92 } as const;

/**
 * The tallest shelf main will grow to.
 *
 * The number comes from a renderer, so it is a request, not a fact. A HUD that
 * asked for a thousand pixels — a bug, or a compromised renderer — would get a
 * window covering the screen it is recording, on top of everything, unclosable.
 * Two banners' worth is more than §7.4 or an error line can produce.
 */
const HUD_MAX_NOTICE_PX = 200;

const ROLES: Record<WindowRole, RoleSpec> = {
  /**
   * First run. Shown instead of the library when `settings.setup.completedAt` is
   * `null`, and openable afterwards from the library.
   *
   * Sized to its content and resizable, which is a correction rather than a
   * preference: at a fixed 760px the Accessibility row's second sentence — "not
   * keystrokes, not window contents, not what you type" — fell off the bottom edge
   * with no way to reach it. That sentence is the one the captain's decision requires
   * and the one that earns the most invasive of the four asks, so the window is tall
   * enough for it and lets a short display scroll to it.
   *
   * `titleBarStyle` matches the library so the two do not look like they came from
   * different apps.
   */
  setup: {
    page: 'setup.html',
    visible: true,
    contentProtected: false,
    multiple: false,
    options: {
      width: 720,
      height: 880,
      minWidth: 640,
      minHeight: 520,
      maximizable: false,
      fullscreenable: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
      title: 'Welcome',
    },
  },
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
    options: { ...HUD_SIZE, frame: false, resizable: false, alwaysOnTop: true },
  },
  countdown: {
    page: 'countdown.html',
    visible: true,
    contentProtected: true,
    multiple: false,
    options: { frame: false, transparent: true, alwaysOnTop: true, focusable: false },
  },
  /**
   * Phase 12's live drawing overlay: transparent, full-screen, over everything,
   * and out of the recording.
   *
   * Four of these options are load-bearing rather than tidy, and each is a
   * constraint from the phase's brief made mechanical:
   *
   * - **`contentProtected: true`** — the whole point. The strokes are logged to
   *   `events/drawing.ndjson` and re-composited at edit time, so they must not also
   *   be burned into the captured pixels. `overlay-content-protection` in
   *   `apps/main/src/verify/permissions-harness.ts` measures that in a real capture
   *   against a control window, the way phase 2 measured the HUD's — and it is there
   *   rather than in `npm test` because looking needs the Screen Recording grant. An
   *   assertion that this flag was *set* is a different claim, which is why
   *   `windows.test.ts` asserting the table is not that check.
   * - **`focusable: false`** — *"must not steal focus from what the user is
   *   recording"*. On macOS this makes the window non-activating: clicking it, even
   *   to draw, leaves the app being demonstrated as the key window. The cost is
   *   real and is why nothing here is dismissed with a key — a non-activating
   *   window receives mouse events and not keystrokes.
   * - **`backgroundColor: '#00000000'`** — the registry paints every window
   *   {@link groundColor} so the first frame is never a white flash, and on a
   *   transparent window that would be a sheet of paper over the desktop. This is
   *   the one role that wants no ground at all.
   * - **`hasShadow: false`, `resizable`/`movable: false`** — a full-screen sheet
   *   with a drop shadow draws a dark band down the edge of the screen it is over,
   *   and a window the user can drag off the display they are recording is a window
   *   whose ink no longer lines up with the recording.
   *
   * Mouse events are `OverlayController`'s, not the registry's: the window is
   * created ignoring them and is armed only while the user is drawing.
   */
  'drawing-overlay': {
    page: 'overlay.html',
    visible: true,
    contentProtected: true,
    multiple: false,
    options: {
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      fullscreenable: false,
      focusable: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
    },
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

/**
 * Schemes `shell.openExternal` may be handed. Anything else is dropped.
 *
 * Widening this list is a decision, not a convenience: every entry is a way for a
 * renderer to make the OS launch something outside the sandbox.
 */
const OPENABLE_SCHEMES: ReadonlySet<string> = new Set(['https:', 'http:']);

function isBrowserUrl(url: string): boolean {
  try {
    return OPENABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

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
  private readonly closedListeners: ((role: WindowRole, key: string) => void)[] = [];

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  /**
   * Be told when a window goes away, by role and key.
   *
   * Registered on the registry rather than on each window because the caller that
   * needs it — the one releasing the bundle lock an editor took — must hear about
   * *every* close, including the ones it did not open, and must hear about each of
   * them once. Attaching a listener beside `show()` would do neither: `show()` on
   * an existing window adds a second listener, and a window closed by the user
   * quitting was never `show()`n by that caller at all.
   */
  onClosed(callback: (role: WindowRole, key: string) => void): void {
    this.closedListeners.push(callback);
  }

  /**
   * Listen for the HUD reporting how tall its notice shelf is, and size the window
   * to it. Call once, beside the other `ipcMain` registrations.
   *
   * Registered against the sender's role rather than trusted from the payload: the
   * preload is shared by every window, so `recorder.noticeHeight` exists in the
   * library and in the capture page too, and neither may resize the HUD. Same rule
   * as `recorder.start` — a capability is only as narrow as main makes it.
   */
  installHudNoticeFit(): void {
    ipcMain.on(CHANNEL.recorderNoticeHeight, (event, raw: unknown) => {
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (sender === null || this.roleOf(sender) !== 'recorder-hud') return;
      this.fitHudNotice(sender, raw);
    });
  }

  /**
   * Grow the HUD to fit its notice shelf, and shrink it back when the shelf empties.
   *
   * `resizable: false` is about the *user*: the bar has no grip and cannot be
   * dragged bigger. macOS still honours a programmatic `setContentSize` on it, so
   * the flag stays on and the window keeps its top-left corner while the shelf
   * appears below the controls.
   */
  private fitHudNotice(window: BrowserWindow, raw: unknown): void {
    const requested = typeof raw === 'number' && Number.isFinite(raw) ? Math.ceil(raw) : 0;
    const notice = Math.min(Math.max(requested, 0), HUD_MAX_NOTICE_PX);
    const height = HUD_SIZE.height + notice;
    const [, current] = window.getContentSize();
    // A resize to the size it already is still costs a relayout of the bar, and the
    // HUD is the window with a timer running in it. The renderer only reports on a
    // change, so this is the second of the two guards, not the only one.
    if (current === height) return;
    window.setContentSize(HUD_SIZE.width, height);
  }

  /**
   * Show the window for a role, creating it if needed.
   *
   * `key` distinguishes instances of a multi-instance role — one editor per
   * recording, one hidden window per export job.
   *
   * `search` becomes the page URL's query, which is how a multi-instance window
   * learns which of the things it is for: main writes it, the page reads it out of
   * `location.search`, and a renderer has no way to change it because nothing in
   * this app navigates. An existing window is **shown, not reloaded** — the key
   * already identifies the subject, so a second `show` for the same key with a
   * different query would be asking one window to become another, which is a new
   * window's job.
   */
  show(
    role: WindowRole,
    key = 'default',
    search: Readonly<Record<string, string>> = {},
  ): BrowserWindow {
    const spec = ROLES[role];
    if (!spec.multiple && key !== 'default') {
      throw new Error(`role ${role} is single-instance; it takes no key`);
    }
    const id = `${role}:${key}`;
    const existing = this.entries.get(id);
    if (existing !== undefined && !existing.window.isDestroyed()) {
      if (spec.visible) this.reveal(spec, existing.window);
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
    //
    // The URL comes from a renderer, so it is untrusted, and `shell.openExternal`
    // hands whatever it is given to the OS handler for that scheme — `file:`,
    // `smb:` and every third-party scheme registered on the machine included.
    // Only a browser link is ever a legitimate thing for a window here to ask for.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isBrowserUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });

    const entry: Entry = { role, window, key };
    this.entries.set(id, entry);
    window.on('closed', () => {
      this.entries.delete(id);
      for (const listener of this.closedListeners) listener(role, key);
    });

    if (spec.visible) {
      window.once('ready-to-show', () => {
        this.reveal(spec, window);
      });
    }

    // Every window loads from `loom://app`, in development exactly as in a packaged
    // build. `npm run dev` rebuilds into the same `dist/renderer` and reloads,
    // rather than serving from a dev server on another origin — which keeps the
    // origin, the CSP and the asset paths identical in both, so "works in dev,
    // breaks when packaged" has one fewer place to hide.
    void window.loadURL(appUrl(spec.page, search));
    return window;
  }

  /**
   * Put a window on screen — and **do not activate one that declared it must not
   * be**.
   *
   * `focusable: false` is not decoration on the role that uses it: the drawing
   * overlay covers the display the user is recording, and an overlay that took
   * focus would take it from the app they are demonstrating. A registry that
   * called `focus()` on every window it opened would undo that from the outside,
   * on a line nobody reading `windows.ts`'s table would think to check.
   */
  private reveal(spec: RoleSpec, window: BrowserWindow): void {
    if (spec.options.focusable === false) {
      window.showInactive();
      return;
    }
    window.show();
    window.focus();
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
