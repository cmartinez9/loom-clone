/**
 * The golden gate harness's preload.
 *
 * Named channels only, exactly as the app's own preload does (§1.4: *"The preload
 * exposes named channels only — never a generic `invoke`"*), and the window is
 * sandboxed and context-isolated like every other window in this app. A gate is only
 * worth running if what it measures is the shipping arrangement.
 *
 * Bundled to CommonJS: a sandboxed preload has to be.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { GoldenReport } from './report.ts';

contextBridge.exposeInMainWorld('golden', {
  finish: (report: GoldenReport) => ipcRenderer.invoke('golden:finish', report),
  log: (message: string) => {
    ipcRenderer.send('golden:log', message);
  },
});
