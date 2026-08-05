/**
 * The preload — the whole surface a renderer can reach.
 *
 * Architecture report §1.4: renderers run with `contextBridge`,
 * `contextIsolation: true` and `sandbox: true`. What that buys is exact: the only
 * capabilities a renderer has are the functions listed here. There is no `require`,
 * no `process`, no `fs`, and no generic `invoke` escape hatch — a renderer cannot
 * name a channel that is not in this file.
 *
 * That is the structural enforcement of "main is the only writer" (§0, rule 2). It
 * is not that renderers are asked not to write; it is that there is nothing in a
 * renderer to write with.
 *
 * **Never add a passthrough here.** `invoke(channel, ...args)` would hand every
 * present and future channel to whatever runs in a renderer, and would make the
 * IPC contract unenforceable in one line.
 *
 * This file is bundled to CommonJS: a sandboxed preload is CommonJS-only.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNEL,
  LOOM_API_KEY,
  type AppInfo,
  type ApplyOpsResult,
  type EditDocument,
  type EditOp,
  type LoomApi,
  type RecordingDoc,
  type RecordingId,
  type RecordingSummary,
  type TrackKey,
} from '@loom/ipc';

const api: LoomApi = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke(CHANNEL.appInfo) as Promise<AppInfo>,
    revealRecordingsRoot: (): void => {
      ipcRenderer.send(CHANNEL.appRevealRoot);
    },
  },

  library: {
    list: (): Promise<RecordingSummary[]> =>
      ipcRenderer.invoke(CHANNEL.libraryList) as Promise<RecordingSummary[]>,
    reveal: (id: RecordingId): void => {
      ipcRenderer.send(CHANNEL.libraryReveal, id);
    },
    delete: (id: RecordingId): Promise<void> =>
      ipcRenderer.invoke(CHANNEL.libraryDelete, id) as Promise<void>,
  },

  project: {
    open: (id: RecordingId): Promise<{ recording: RecordingDoc | null; edit: EditDocument }> =>
      ipcRenderer.invoke(CHANNEL.projectOpen, id) as Promise<{
        recording: RecordingDoc | null;
        edit: EditDocument;
      }>,
    applyOps: (id: RecordingId, ops: EditOp[], baseRevision: number): Promise<ApplyOpsResult> =>
      ipcRenderer.invoke(CHANNEL.projectApplyOps, id, ops, baseRevision) as Promise<ApplyOpsResult>,
    mediaUrl: (id: RecordingId, track: TrackKey, part: number): Promise<string> =>
      ipcRenderer.invoke(CHANNEL.projectMediaUrl, id, track, part) as Promise<string>,
  },
};

contextBridge.exposeInMainWorld(LOOM_API_KEY, api);
