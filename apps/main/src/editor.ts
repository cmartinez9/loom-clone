/**
 * The editor window's main-process half.
 *
 * Two jobs, and they are the two halves of one lifetime:
 *
 *  - **open** — `loom.editor.open(id)` shows `editor.html` keyed by the recording,
 *    which is what §1.2's `multiple: true` already means by "one editor per
 *    recording". The id goes into the page's URL, so the window is *told* what it
 *    is showing rather than asking, and a second `open` for the same recording
 *    focuses the window that already exists.
 *  - **close** — the window going away closes the project. That is not tidiness:
 *    `ProjectStore.openProject` takes the bundle `.lock`, and a lock held by a
 *    window nobody can see is a recording the user cannot open in a second
 *    instance and cannot record over, with nothing on screen to explain it.
 *
 * ## Why an editor is refused while the recorder holds the same bundle
 *
 * `close()` aborts any media part still open for that id, and the recorder's parts
 * are exactly that. So an editor opened on a live recording would, on being closed,
 * pull the file descriptors out from under the capture that is still running — a
 * user action in one window truncating a recording in another. Refusing the open is
 * the honest version: the library already shows the state, and there is nothing to
 * edit in a recording that has not finished being made.
 *
 * The refusal is main's rather than the library's for the reason every other check
 * in this process is: a renderer's decision not to send a message is not an
 * enforcement of anything.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { CHANNEL, SUBJECT_PARAM, type RecordingId } from '@loom/ipc';
import type { ProjectStore } from './project-store.ts';
import type { WindowRegistry } from './windows.ts';

export interface EditorWindowsOptions {
  store: ProjectStore;
  windows: WindowRegistry;
  /**
   * Which recording the recorder currently owns, or `null`.
   *
   * A function rather than a value because the answer changes while this object
   * lives, and injected rather than reached for because `RecorderSession` and this
   * module have no other reason to know about each other.
   */
  activeRecordingId: () => RecordingId | null;
}

/** Ids the store may not be closed for: another window is still showing them. */
export class EditorWindows {
  readonly #options: EditorWindowsOptions;

  constructor(options: EditorWindowsOptions) {
    this.#options = options;
  }

  /** Register the handler and the close rule. Call once, beside the others. */
  install(): void {
    const { store, windows } = this.#options;

    ipcMain.on(CHANNEL.editorOpen, (_event, rawId: unknown) => {
      const id = readRecordingId(rawId);
      if (id === null) return;
      this.open(id);
    });

    windows.onClosed((role, key) => {
      if (role !== 'editor') return;
      // The recorder's own bundle is never closed from here — see the header. It
      // cannot normally be open in an editor at all; this is the second guard,
      // because the cost of getting it wrong is somebody's footage.
      if (key === this.#options.activeRecordingId()) return;
      store.close(key).catch((error: unknown) => {
        // Reported and not rethrown: the window is already gone, so there is
        // nobody to tell, and the next launch's `sweepTempArtifacts` and lock
        // acquisition are what actually recover from a flush that failed.
        console.error(`[editor] closing project ${key} failed:`, error);
      });
    });
  }

  /**
   * Show the editor for `id`, unless the recorder is using that bundle.
   *
   * Returns the window so a caller inside main — a menu item, a test harness — can
   * wait for it; `undefined` means the open was refused.
   */
  open(id: RecordingId): BrowserWindow | undefined {
    if (id === this.#options.activeRecordingId()) {
      console.warn(`[editor] refused to open ${id}: it is being recorded`);
      return undefined;
    }
    return this.#options.windows.show('editor', id, { [SUBJECT_PARAM]: id });
  }
}

/**
 * A recording id off the wire, or `null`.
 *
 * The same bound `apps/main/src/ipc.ts` puts on the invoke channels, restated here
 * because this is a `send` and there is no promise to reject: a bad id is dropped,
 * not answered. The value becomes a window key and a query parameter, so an
 * unbounded string from a renderer is a payload rather than an id.
 */
function readRecordingId(value: unknown): RecordingId | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  return value;
}
