/**
 * The gate harness's preload.
 *
 * Named channels only, exactly as the app's own preload does (architecture report
 * §1.4: *"The preload exposes named channels only — never a generic `invoke`"*).
 * The harness is sandboxed and context-isolated like every other window in this
 * app, so the gate is not quietly measuring a more permissive renderer than the
 * one that will ship.
 *
 * Bundled to CommonJS: a sandboxed preload has to be.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { GateReport } from './report.ts';

contextBridge.exposeInMainWorld('gate', {
  options: () => ipcRenderer.invoke('gate:options'),
  write: (path: string, data: Uint8Array) => ipcRenderer.invoke('gate:write', path, data),
  finish: (report: GateReport) => ipcRenderer.invoke('gate:finish', report),
  log: (message: string) => {
    ipcRenderer.send('gate:log', message);
  },
});
