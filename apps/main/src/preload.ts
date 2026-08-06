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
  type AudioPartEndMsg,
  type CaptureCommand,
  type CaptureEndReport,
  type CaptureOptions,
  type ChunkMsg,
  type ClearMsg,
  type EditDocument,
  type EditOp,
  type EraseMsg,
  type ExportChunkMsg,
  type ExportCommand,
  type ExportDecodeReport,
  type ExportFailedMsg,
  type ExportMetaMsg,
  type ExportPassDoneMsg,
  type ExportPassProgressMsg,
  type ExportProgress,
  type ExportSettings,
  type ExportSettingsOverride,
  type LoomApi,
  type MetaMsg,
  type OverlayStatus,
  type PartEndMsg,
  type PermissionKind,
  type PermissionReport,
  type PreflightReport,
  type RecorderStatus,
  type RecordingDoc,
  type RecordingId,
  type RecordingSummary,
  type SetupState,
  type StrokeMsg,
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
    open: (): void => {
      ipcRenderer.send(CHANNEL.setupOpen);
    },
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
    audioEnded: (message: AudioPartEndMsg): void => {
      ipcRenderer.send(CHANNEL.captureAudioEnded, message);
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

  /**
   * The live drawing overlay (phase 12).
   *
   * Every method is a `send`, including the two the *overlay page* calls on itself
   * — `setArmed` as the pointer enters and leaves the palette. That is not laziness
   * about return values: `setIgnoreMouseEvents` is a property of a `BrowserWindow`,
   * so only main can set it, and a renderer that could ask for the answer back
   * would be a renderer waiting on the main process sixty times a second while the
   * user moves the mouse.
   *
   * Main accepts `stroke`/`erase`/`clear` only from the overlay window and
   * `setOpen`/`setArmed` only from the HUD and the overlay, which is where that
   * check belongs — the preload is shared by every window in the app, so a
   * capability is only ever as narrow as main makes it.
   */
  overlay: {
    setOpen: (open: boolean): void => {
      ipcRenderer.send(CHANNEL.overlaySetOpen, open);
    },
    setArmed: (armed: boolean): void => {
      ipcRenderer.send(CHANNEL.overlaySetArmed, armed);
    },
    stroke: (message: StrokeMsg): void => {
      ipcRenderer.send(CHANNEL.overlayStroke, message);
    },
    erase: (message: EraseMsg): void => {
      ipcRenderer.send(CHANNEL.overlayErase, message);
    },
    clear: (message: ClearMsg): void => {
      ipcRenderer.send(CHANNEL.overlayClear, message);
    },
    onStatus: (callback: (status: OverlayStatus) => void): Unsubscribe =>
      subscribe(CHANNEL.overlayStatus, (payload) => {
        callback(payload as OverlayStatus);
      }),
  },

  export: {
    defaults: (id: RecordingId): Promise<ExportSettings> =>
      ipcRenderer.invoke(CHANNEL.exportDefaults, id) as Promise<ExportSettings>,
    chooseOutputFolder: (): Promise<string | null> =>
      ipcRenderer.invoke(CHANNEL.exportChooseFolder) as Promise<string | null>,
    // No destination: main owns where the file goes. See `ExportSettingsOverride`.
    start: (id: RecordingId, settings?: ExportSettingsOverride): Promise<{ jobId: string }> =>
      ipcRenderer.invoke(CHANNEL.exportStart, id, settings ?? {}) as Promise<{ jobId: string }>,
    cancel: (jobId: string): void => {
      ipcRenderer.send(CHANNEL.exportCancel, jobId);
    },
    onProgress: (callback: (progress: ExportProgress) => void): Unsubscribe =>
      subscribe(CHANNEL.exportProgress, (payload) => {
        callback(payload as ExportProgress);
      }),
  },

  /**
   * The hidden export window's half. Present on every window because there is one
   * preload; accepted by main only from an export window, and only for the job that
   * window was given — same rule as `capture`, and for the same reason: a renderer
   * cannot be trusted to decline a capability.
   */
  exportRender: {
    onCommand: (callback: (command: ExportCommand) => void): Unsubscribe =>
      subscribe(CHANNEL.exportCommand, (payload) => {
        callback(payload as ExportCommand);
      }),
    meta: (message: ExportMetaMsg): void => {
      ipcRenderer.send(CHANNEL.exportMeta, message);
    },
    chunk: (message: ExportChunkMsg): void => {
      ipcRenderer.send(CHANNEL.exportChunk, message);
    },
    passProgress: (message: ExportPassProgressMsg): void => {
      ipcRenderer.send(CHANNEL.exportPassProgress, message);
    },
    passDone: (message: ExportPassDoneMsg): void => {
      ipcRenderer.send(CHANNEL.exportPassDone, message);
    },
    failed: (message: ExportFailedMsg): void => {
      ipcRenderer.send(CHANNEL.exportFailed, message);
    },
    decoded: (report: ExportDecodeReport): void => {
      ipcRenderer.send(CHANNEL.exportDecoded, report);
    },
  },
};

contextBridge.exposeInMainWorld(LOOM_API_KEY, api);
