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
  type CaptureCommand,
  type CaptureEndReport,
  type CaptureOptions,
  type ChunkMsg,
  type EditDocument,
  type EditOp,
  type LoomApi,
  type MetaMsg,
  type PartEndMsg,
  type PermissionKind,
  type PermissionReport,
  type PreflightReport,
  type RecorderStatus,
  type RecordingDoc,
  type RecordingId,
  type RecordingSummary,
  type SetupState,
  type TrackKey,
  type Unsubscribe,
} from '@loom/ipc';

/**
 * Subscribe to a main -> renderer push.
 *
 * Two things this deliberately does not do. It does not forward the
 * `IpcRendererEvent` — that carries `sender` and `ports`, and handing a renderer a
 * live handle on the IPC machinery would widen this surface well past the list of
 * functions below. And it does not pretend the payload is typed: what arrives is
 * `unknown`, and the two callers below assert its shape, which is where the "main
 * is trusted, the wire is not" assumption belongs.
 */
function subscribe(
  channel: (typeof CHANNEL)[keyof typeof CHANNEL],
  callback: (payload: unknown) => void,
): Unsubscribe {
  const listener = (_event: unknown, payload: unknown): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

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

  /**
   * The permission surface. Note `openSettings` takes a {@link PermissionKind} and
   * not a URL: `shell.openExternal` hands whatever it is given to the OS handler for
   * that scheme, so the string that gets opened is chosen in main from a closed
   * table, never named by a renderer.
   */
  permissions: {
    probe: (): Promise<PermissionReport> =>
      ipcRenderer.invoke(CHANNEL.permissionsProbe) as Promise<PermissionReport>,
    request: (kind: PermissionKind): Promise<PermissionReport> =>
      ipcRenderer.invoke(CHANNEL.permissionsRequest, kind) as Promise<PermissionReport>,
    openSettings: (kind: PermissionKind): void => {
      ipcRenderer.send(CHANNEL.permissionsOpenSettings, kind);
    },
    relaunch: (): void => {
      ipcRenderer.send(CHANNEL.permissionsRelaunch);
    },
    onChange: (callback: (report: PermissionReport) => void): Unsubscribe =>
      subscribe(CHANNEL.permissionsChanged, (payload) => {
        callback(payload as PermissionReport);
      }),
  },

  setup: {
    state: (): Promise<SetupState> => ipcRenderer.invoke(CHANNEL.setupState) as Promise<SetupState>,
    complete: (): Promise<void> => ipcRenderer.invoke(CHANNEL.setupComplete) as Promise<void>,
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

  recorder: {
    open: (): void => {
      ipcRenderer.send(CHANNEL.recorderOpen);
    },
    preflight: (options?: Partial<CaptureOptions>): Promise<PreflightReport> =>
      ipcRenderer.invoke(CHANNEL.recorderPreflight, options ?? {}) as Promise<PreflightReport>,
    start: (options?: Partial<CaptureOptions>): Promise<{ recordingId: RecordingId }> =>
      ipcRenderer.invoke(CHANNEL.recorderStart, options ?? {}) as Promise<{
        recordingId: RecordingId;
      }>,
    stop: (): Promise<void> => ipcRenderer.invoke(CHANNEL.recorderStop) as Promise<void>,
    onStatus: (callback: (status: RecorderStatus) => void): Unsubscribe =>
      subscribe(CHANNEL.recorderStatus, (payload) => {
        callback(payload as RecorderStatus);
      }),
    noticeHeight: (px: number): void => {
      ipcRenderer.send(CHANNEL.recorderNoticeHeight, px);
    },
  },

  /**
   * The hidden capture page's half. Present on every window because there is one
   * preload; accepted by main only from the capture window, which is where the
   * check belongs — a renderer cannot be trusted to decline a capability.
   */
  capture: {
    onCommand: (callback: (command: CaptureCommand) => void): Unsubscribe =>
      subscribe(CHANNEL.captureCommand, (payload) => {
        callback(payload as CaptureCommand);
      }),
    meta: (message: MetaMsg): void => {
      ipcRenderer.send(CHANNEL.captureMeta, message);
    },
    chunk: (message: ChunkMsg): void => {
      ipcRenderer.send(CHANNEL.captureChunk, message);
    },
    partEnded: (message: PartEndMsg): void => {
      ipcRenderer.send(CHANNEL.capturePartEnded, message);
    },
    cameraUnavailable: (reason: string): void => {
      ipcRenderer.send(CHANNEL.captureCameraUnavailable, reason);
    },
    ended: (report: CaptureEndReport): void => {
      ipcRenderer.send(CHANNEL.captureEnded, report);
    },
    failed: (message: string): void => {
      ipcRenderer.send(CHANNEL.captureFailed, message);
    },
  },
};

contextBridge.exposeInMainWorld(LOOM_API_KEY, api);
