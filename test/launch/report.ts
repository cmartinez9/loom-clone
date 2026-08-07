/**
 * What the launch probe measures. Shared by `test/launch/main.ts` and the gate.
 *
 * Every field is a reading of the **shipping** `dist/main/index.cjs` doing what it
 * does when a person double-clicks the app: nothing here is reconstructed and
 * nothing is stubbed.
 */

/** One window the app opened by itself, as the window server has it. */
export interface WindowReading {
  /** The role's page, e.g. `loom://app/library.html`. */
  url: string;
  title: string;
  /** `BrowserWindow.isVisible()` — main's opinion. */
  isVisible: boolean;
  /** `[width, height]` on screen. A window with no area is not a window. */
  contentSize: [number, number];
  /**
   * `document.visibilityState` inside the page.
   *
   * Recorded and **not asserted on**, because the control measured it and it does
   * not discriminate: an Electron window created `show: false` and never revealed
   * still reports `visible` here. It is kept so the next person reaching for the
   * renderer's own opinion of whether it is on screen finds the measurement rather
   * than repeating it.
   */
  visibilityState: string;
  /**
   * Distinct colours in `webContents.capturePage()` — did this window composite a
   * picture at all.
   *
   * `1` is a flat rectangle: the ground colour the registry paints every window so
   * the first frame is never a white flash, with nothing drawn over it. Anything
   * more means the page rendered into the window rather than merely into a document
   * `getBoundingClientRect` was willing to describe.
   */
  capturedColours: number;
  /** `[width, height]` of that capture, in device pixels. */
  capturedSize: [number, number];
  /** Text the page actually rendered, so a blank window cannot pass. */
  headingText: string;
  /** Pixels of that heading inside the viewport. */
  headingVisiblePx: number;
}

/** One call made from inside the page, through the real preload and the real IPC. */
export interface IpcReading {
  /** The `window.loom` path that was called, e.g. `library.list`. */
  call: string;
  /** Resolved, with a short description of what came back. */
  ok: boolean;
  /** The rejection message, when it rejected. */
  error: string;
  /** A one-line description of the value, for the failure message. */
  value: string;
}

/**
 * What the IPC surface looked like at the instant the app's own `before-quit` body
 * had run.
 *
 * Taken from a listener registered **after** the app's, so it observes the state the
 * app left synchronously — which is exactly where a teardown that runs too early
 * shows up. The two channels are not interchangeable: `library.list` is what a
 * visible window calls and is where the symptom was first seen, and `capture.ended`
 * is what the recorder's own stop waits for, so losing it costs a recording its
 * measurements rather than costing a window a list.
 */
export interface QuitReading {
  /** A window was still on screen when the quit began. */
  windowsAlive: number;
  /** `library.list` still has a handler — the channel a live window calls. */
  libraryListHandled: boolean;
  /** Listeners on `capture.ended` — the message `RecorderSession.stop` waits for. */
  captureEndedListeners: number;
}

export interface LaunchReport {
  ok: boolean;
  error: string;
  /** `setup` when the scratch settings say first run, `library` when they do not. */
  scenario: 'setup' | 'library';
  /** Windows the app had open before anything was required. Must be zero. */
  windowsBeforeLaunch: number;
  /** Every window the app opened by itself. */
  windows: WindowReading[];
  /**
   * The control for the visibility instrument: a window this harness creates with
   * `show: false`, loading the same page through the same preload.
   *
   * Without it, `isVisible === true` is a reading nobody has watched come back any
   * other way — the same discipline `kill-mid-write.test.ts`'s naive writer and the
   * content-protection control window exist for. It is also what retired
   * {@link WindowReading.visibilityState}.
   */
  hiddenControl: WindowReading | null;
  ipc: IpcReading[];
  quit: QuitReading | null;
  logs: string[];
}
