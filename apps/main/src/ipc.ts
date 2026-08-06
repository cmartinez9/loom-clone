/**
 * The main-process half of the IPC contract in `@loom/ipc`.
 *
 * Every handler here obeys three rules:
 *
 * 1. **Arguments from a renderer are untrusted.** They are shape-checked before
 *    they reach the store, even though the renderer is our own code — a renderer is
 *    the process most likely to be compromised, and it is the one that must never
 *    be able to name an arbitrary path.
 * 2. **Nothing raw crosses.** `VideoFrame`, `AudioData`, `ImageBitmap` and pixel
 *    buffers are not in the contract and never will be (§1.4). Media reaches the
 *    renderer as a `loom://` URL it fetches with range requests, not as bytes over
 *    IPC.
 * 3. **Errors are converted at the boundary.** An `Error` thrown in a handler
 *    reaches the renderer as an opaque `Error: ...` string; anything the user needs
 *    to act on is returned as data instead.
 */

import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  CHANNEL,
  recordingUrl,
  type AppInfo,
  type ApplyOpsResult,
  type EditOp,
  type ExportSettings,
  type ExportSettingsOverride,
  type OpenedProject,
  type RecordingSummary,
} from '@loom/ipc';
import { TRACK_KEYS, isEditOp, type TrackKey } from '@loom/format';
import type { ProjectStore } from './project-store.ts';
import { safeFileName, type ExportSession } from './export/session.ts';
import { LOOM_BUNDLE_ID } from './identity.ts';

export interface IpcContext {
  store: ProjectStore;
  appVersion: string;
  /** Absent only in tests that exercise the phase-0 handlers alone. */
  exports?: ExportSession;
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new BadRequestError('recording id must be a non-empty string');
  }
  return value;
}

function requireTrack(value: unknown): TrackKey {
  if (typeof value !== 'string' || !(TRACK_KEYS as readonly string[]).includes(value)) {
    throw new BadRequestError(`track must be one of ${TRACK_KEYS.join(' | ')}`);
  }
  return value as TrackKey;
}

function requirePart(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 999) {
    throw new BadRequestError('part must be an integer between 0 and 999');
  }
  return value;
}

function requireOps(value: unknown): EditOp[] {
  if (!Array.isArray(value)) throw new BadRequestError('ops must be an array');
  if (value.length > 10_000) throw new BadRequestError('too many ops in one batch');
  for (const [i, op] of value.entries()) {
    if (!isEditOp(op)) throw new BadRequestError(`ops[${String(i)}] is not a recognised edit op`);
  }
  return value as EditOp[];
}

/**
 * Shape-check an export settings override.
 *
 * **The destination is not in it, and cannot be.** A directory is the one argument
 * here that could put a file anywhere on the volume, and validating it — "absolute,
 * no NUL" — only settles whether main can *reach* the path, never whether the user
 * asked for it. `ExportSession.start` joins it with the file name, `beginExport`
 * `mkdir -p`s it, `finalize` `rename(2)`s over `<dir>/<name>.mp4`, and a failed
 * verification removes that file: a renderer naming the directory therefore names
 * what gets created and what gets replaced, which is §0 rule 1 read backwards.
 *
 * So it comes from main and only from main — `settings.exportRoot`, changed through
 * `export:chooseFolder`, a native dialog main itself opens. That is captain decision
 * 9's *"pick a sensible default output location and let the captain change it; do not
 * prompt on every export"* in full, with no renderer composing a path.
 *
 * Refused loudly rather than dropped: a caller that thought it was choosing a
 * destination should hear that it was not.
 */
function requireExportSettings(value: unknown): ExportSettingsOverride {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object') throw new BadRequestError('settings must be an object');
  const raw = value as Record<string, unknown>;
  const out: ExportSettingsOverride = {};
  const number = (name: keyof ExportSettings, min: number, max: number): void => {
    const found = raw[name];
    if (found === undefined) return;
    if (typeof found !== 'number' || !Number.isFinite(found) || found < min || found > max) {
      throw new BadRequestError(`${name} must be a number in [${min}, ${max}]`);
    }
    (out as Record<string, unknown>)[name] = Math.round(found);
  };
  number('width', 16, 7680);
  number('height', 16, 4320);
  number('fps', 1, 120);
  number('bitrate', 100_000, 200_000_000);
  number('audioBitrate', 32_000, 512_000);

  if (raw['outputDir'] !== undefined) {
    throw new BadRequestError(
      'an export destination cannot be named by a renderer; it is settings.exportRoot, ' +
        'changed through export:chooseFolder',
    );
  }
  if (raw['name'] !== undefined) {
    const name = raw['name'];
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
      throw new BadRequestError('name must be a non-empty string');
    }
    // Sanitised rather than rejected: a recording called "Q3 / demo" is a reasonable
    // thing to have, and it is not the renderer's job to know it cannot be a path.
    out.name = safeFileName(name);
  }
  if (raw['keepSources'] !== undefined) {
    if (typeof raw['keepSources'] !== 'boolean') {
      throw new BadRequestError('keepSources must be a boolean');
    }
    out.keepSources = raw['keepSources'];
  }
  return out;
}

/** Register every handler. Call once, after `app.whenReady()`. */
export function registerIpc(context: IpcContext): void {
  const { store, appVersion } = context;

  ipcMain.handle(CHANNEL.appInfo, (): AppInfo => {
    return {
      version: appVersion,
      bundleId: LOOM_BUNDLE_ID,
      recordingsRoot: store.recordingsRoot,
      platform: process.platform,
    };
  });

  ipcMain.on(CHANNEL.appRevealRoot, () => {
    // `openPath` rather than `showItemInFolder`: the root is a directory the user
    // wants to be *in*, not a thing to be pointed at.
    void shell.openPath(store.recordingsRoot);
  });

  ipcMain.handle(CHANNEL.libraryList, (): Promise<RecordingSummary[]> => store.list());

  ipcMain.on(CHANNEL.libraryReveal, (_event: unknown, rawId: unknown) => {
    const id = requireId(rawId);
    void store
      .directoryFor(id)
      .then((dir) => {
        shell.showItemInFolder(dir);
      })
      .catch((error: unknown) => {
        console.error('[ipc] reveal failed:', error);
      });
  });

  ipcMain.handle(CHANNEL.libraryDelete, async (_event: IpcMainInvokeEvent, rawId: unknown) => {
    await store.trash(requireId(rawId));
  });

  ipcMain.handle(
    CHANNEL.projectOpen,
    async (_event: IpcMainInvokeEvent, rawId: unknown): Promise<OpenedProject> => {
      const opened = await store.openProject(requireId(rawId));
      // `project.json` travels too, so the editor can put the recording's name in
      // its window and refuse a bundle whose §2.2 state says its sources are gone.
      // Both facts live only here; see `OpenedProject` for why the alternative —
      // making the editor call `library.list()` — is worse.
      return { project: opened.project, recording: opened.recording, edit: opened.edit };
    },
  );

  ipcMain.handle(
    CHANNEL.projectApplyOps,
    async (
      _event: IpcMainInvokeEvent,
      rawId: unknown,
      rawOps: unknown,
      rawBase: unknown,
    ): Promise<ApplyOpsResult> => {
      const id = requireId(rawId);
      const ops = requireOps(rawOps);
      if (typeof rawBase !== 'number' || !Number.isInteger(rawBase) || rawBase < 0) {
        throw new BadRequestError('baseRevision must be a non-negative integer');
      }
      return store.applyOps(id, ops, rawBase);
    },
  );

  ipcMain.handle(
    CHANNEL.projectMediaUrl,
    async (
      _event: IpcMainInvokeEvent,
      rawId: unknown,
      rawTrack: unknown,
      rawPart: unknown,
    ): Promise<string> => {
      const id = requireId(rawId);
      const track = requireTrack(rawTrack);
      const part = requirePart(rawPart);
      // Resolving proves the file exists and is inside the bundle before the
      // renderer is handed a URL for it.
      await store.resolveBundleFile(id, store.mediaRelativePath(track, part));
      return recordingUrl(id, store.mediaRelativePath(track, part));
    },
  );

  // ------------------------------------------------------------------- export

  const exports = context.exports;
  if (exports === undefined) return;

  ipcMain.handle(
    CHANNEL.exportDefaults,
    (_event: IpcMainInvokeEvent, rawId: unknown): Promise<ExportSettings> =>
      exports.defaults(requireId(rawId)),
  );

  /**
   * The picker captain decision 9 allows, and does not require.
   *
   * *"Pick a sensible default output location and let the captain change it. Do not
   * prompt for a path on every export."* So this is opened by a button in the export
   * sheet, never by `start`, and the choice is remembered in `settings.json`.
   */
  ipcMain.handle(CHANNEL.exportChooseFolder, async (): Promise<string | null> => {
    const chosen = await dialog.showOpenDialog({
      title: 'Where should exports go?',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: await store.exportRoot(),
    });
    const path = chosen.filePaths[0];
    if (chosen.canceled || path === undefined) return null;
    await store.setExportRoot(path);
    return path;
  });

  ipcMain.handle(
    CHANNEL.exportStart,
    (
      _event: IpcMainInvokeEvent,
      rawId: unknown,
      rawSettings: unknown,
    ): Promise<{ jobId: string }> =>
      exports.start(requireId(rawId), requireExportSettings(rawSettings)),
  );

  ipcMain.on(CHANNEL.exportCancel, (_event: unknown, rawJobId: unknown) => {
    if (typeof rawJobId !== 'string' || rawJobId.length === 0 || rawJobId.length > 128) return;
    exports.cancel(rawJobId);
  });
}

/**
 * The export window's channels, accepted **only** from an export window.
 *
 * The preload is shared by every window, so `window.loom.exportRender` exists in the
 * library and in the capture page too — and neither may feed encoded chunks into
 * somebody's export. The check is in main, against the sender, exactly as it is for
 * `capture` and `recorder.noticeHeight`: a capability the preload hands out is not
 * the same as a capability main honours.
 */
export function registerExportRenderIpc(context: {
  exports: ExportSession;
  isExportWindow: (window: BrowserWindow) => boolean;
}): void {
  const from = (event: { sender: Electron.WebContents }): boolean => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window !== null && context.isExportWindow(window);
  };

  ipcMain.on(CHANNEL.exportMeta, (event, message: unknown) => {
    if (!from(event)) return;
    context.exports.onMeta(message as Parameters<ExportSession['onMeta']>[0]);
  });
  ipcMain.on(CHANNEL.exportChunk, (event, message: unknown) => {
    if (!from(event)) return;
    context.exports.onChunk(message as Parameters<ExportSession['onChunk']>[0]);
  });
  ipcMain.on(CHANNEL.exportPassProgress, (event, message: unknown) => {
    if (!from(event)) return;
    context.exports.onPassProgress(message as Parameters<ExportSession['onPassProgress']>[0]);
  });
  ipcMain.on(CHANNEL.exportPassDone, (event, message: unknown) => {
    if (!from(event)) return;
    context.exports.onPassDone(message as Parameters<ExportSession['onPassDone']>[0]);
  });
  ipcMain.on(CHANNEL.exportFailed, (event, message: unknown) => {
    if (!from(event)) return;
    context.exports.onFailed(message as Parameters<ExportSession['onFailed']>[0]);
  });
  ipcMain.on(CHANNEL.exportDecoded, (event, message: unknown) => {
    if (!from(event)) return;
    context.exports.onDecoded(message as Parameters<ExportSession['onDecoded']>[0]);
  });
}

/** Remove every handler. Used on shutdown and by tests. */
export function unregisterIpc(): void {
  for (const channel of Object.values(CHANNEL)) {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  }
}
