/**
 * The golden gate's preload.
 *
 * Named channels only, exactly as the app's own preload does (§1.4: *"The preload
 * exposes named channels only — never a generic `invoke`"*). Sandboxed and
 * context-isolated like every window in this app, so the gate is not measuring a
 * more permissive renderer than the one that ships.
 *
 * Bundled to CommonJS: a sandboxed preload has to be.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { GoldenReport } from './report.ts';

type VerifyHandler = (request: unknown) => Promise<{ ok: boolean; error?: string }>;
let verify: VerifyHandler | null = null;

// Main asks the renderer to decode the last GOP, exactly as `ExportSession` does in
// the app: an event out, a send back. The handler is registered by the harness.
ipcRenderer.on('golden:verify', (_event, request: unknown) => {
  const handler = verify;
  if (handler === null) {
    ipcRenderer.send('golden:verified', { ok: false, error: 'no verify handler registered' });
    return;
  }
  void handler(request).then(
    (outcome) => {
      ipcRenderer.send('golden:verified', outcome);
    },
    (error: unknown) => {
      ipcRenderer.send('golden:verified', {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
});

contextBridge.exposeInMainWorld('exportGolden', {
  options: () => ipcRenderer.invoke('golden:options'),
  writeFixture: (request: unknown) => ipcRenderer.invoke('golden:writeFixture', request),
  beginExport: (request: unknown) => ipcRenderer.invoke('golden:beginExport', request),
  appendExport: (sample: unknown) => ipcRenderer.invoke('golden:appendExport', sample),
  finalizeExport: (expectedDurationSec: number) =>
    ipcRenderer.invoke('golden:finalizeExport', expectedDurationSec),
  onVerifyRequest: (handler: VerifyHandler) => {
    verify = handler;
  },
  cancelProbe: () => ipcRenderer.invoke('golden:cancelProbe'),
  finish: (report: GoldenReport) => ipcRenderer.invoke('golden:finish', report),
  log: (message: string) => {
    ipcRenderer.send('golden:log', message);
  },
});
