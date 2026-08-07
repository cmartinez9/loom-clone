/**
 * The hidden export page.
 *
 * Thin on purpose: it owns the command loop and nothing else. `session.ts` runs a
 * job, `render-loop.ts` is §5.3's pipeline, `encode.ts` owns the two encoders and
 * `verify-decode.ts` answers §7.5's last question. This file is where they meet
 * `window.loom`.
 *
 * The window is created by main, owned by main, and never by the editor (§1.2), so
 * everything here is driven by a command that arrived over IPC. There is no page
 * state to speak of: one job at a time, by construction, because main opens one
 * window per job.
 */

// Pressroom's `@font-face` rules and nothing else — not `@loom/design/css`, which
// would also bring tokens and component primitives to a page with no DOM. A `text`
// annotation's glyphs are rasterised in this window (`../glyphs.ts`), and a face this
// page has not declared is a face `measureText` silently falls back from — so the
// labels in an export would be set in a different typeface from the preview the
// person approved. §4.5 does not permit that difference.
import '@loom/design/css/type.css';
import type { ExportCommand } from '@loom/ipc';
import { runExportJob, type RunningExport } from './session.ts';
import { verifyByDecoding } from './verify-decode.ts';

const jobs = new Map<string, RunningExport>();

window.loom.exportRender.onCommand((command: ExportCommand) => {
  switch (command.kind) {
    case 'start': {
      const job = command.job;
      if (jobs.has(job.jobId)) return;
      const running = runExportJob(job, window.loom.exportRender);
      jobs.set(job.jobId, running);
      // The failure has already been reported to main by `runExportJob`; this is
      // only here so a rejected promise is not unhandled, which in a renderer is a
      // console error main would report as a page problem.
      void running.done.catch(() => undefined).finally(() => jobs.delete(job.jobId));
      return;
    }
    case 'cancel': {
      jobs.get(command.jobId)?.cancel();
      return;
    }
    case 'verify': {
      void verifyByDecoding(command.request)
        .then((outcome) => {
          window.loom.exportRender.decoded({ jobId: command.jobId, ...outcome });
        })
        .catch((error: unknown) => {
          window.loom.exportRender.decoded({
            jobId: command.jobId,
            ok: false,
            framesDecoded: 0,
            lastTimestampUs: null,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
  }
});
