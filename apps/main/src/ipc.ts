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

import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  CHANNEL,
  recordingUrl,
  type AppInfo,
  type ApplyOpsResult,
  type EditOp,
  type OpenedProject,
  type RecordingSummary,
} from '@loom/ipc';
import { TRACK_KEYS, isEditOp, type TrackKey } from '@loom/format';
import type { ProjectStore } from './project-store.ts';
import { LOOM_BUNDLE_ID } from './identity.ts';

export interface IpcContext {
  store: ProjectStore;
  appVersion: string;
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
}

/** Remove every handler. Used on shutdown and by tests. */
export function unregisterIpc(): void {
  for (const channel of Object.values(CHANNEL)) {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  }
}
