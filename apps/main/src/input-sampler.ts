/**
 * Wiring the phase-5 input sampler to the one thing that writes.
 *
 * `@loom/sampler` deliberately has no filesystem: it spawns the native helper, folds
 * its NDJSON into the §2.5 shapes, and hands the bytes to an `EventLogSink`. This
 * module is the only implementation of that sink, and it is `ProjectStore` — so
 * cursor samples go through the same per-project queue, the same bundle lock and the
 * same atomic writes as `edit.json`. Report §0, rule 2: main is the only writer, and
 * within main there is one.
 *
 * Nothing here starts a sampler on its own. Capture is phase 1 and the permission
 * flow is phase 2; when they land, they call {@link startInputSampler} with the
 * recording's id and the clock origin from `recording.json`.
 */

import { join } from 'node:path';
import { InputSampler, type ClickCapability, type EventLogSink } from '@loom/sampler';
import type { CursorIndexDoc, EventLogKind, RecordingId } from '@loom/format';
import type { ProjectStore } from './project-store.ts';

/**
 * An `EventLogSink` backed by `ProjectStore`.
 *
 * Every method is one call into the store, which enqueues it on the project's write
 * chain. There is no buffering here on purpose — the sampler already batches to
 * §2.5's 100 ms cadence, and a second buffer would only add a place for samples to
 * be lost in a crash.
 */
export class ProjectStoreEventSink implements EventLogSink {
  private readonly store: ProjectStore;
  private readonly id: RecordingId;

  constructor(store: ProjectStore, id: RecordingId) {
    this.store = store;
    this.id = id;
  }

  create(log: EventLogKind): Promise<void> {
    return this.store.createEventLog(this.id, log);
  }

  append(log: EventLogKind, ndjson: string): Promise<void> {
    return this.store.appendEventLog(this.id, log, ndjson);
  }

  sync(log: EventLogKind): Promise<void> {
    return this.store.syncEventLog(this.id, log);
  }

  writeCursorImage(sha256: string, png: Uint8Array): Promise<void> {
    return this.store.writeCursorImage(this.id, sha256, png);
  }

  writeCursorIndex(doc: CursorIndexDoc): Promise<void> {
    return this.store.writeCursorIndex(this.id, doc);
  }
}

export interface StartInputSamplerOptions {
  store: ProjectStore;
  id: RecordingId;
  /** `recording.json`'s `clock.t0Us` — the origin every `t` in the logs is measured from. */
  t0Us: number;
  /** `CGDirectDisplayID` of the display being recorded. */
  displayId?: number;
  /**
   * Whether to attempt click capture.
   *
   * Phase 2 passes `false` when the user declined Accessibility, which is the
   * difference between the log saying `not-requested` and saying
   * `accessibility-denied` — two different sentences to show a user.
   */
  clicks?: boolean;
  /** Where the helper lives. Defaults to `dist/native/loom-input-sampler`. */
  helperPath?: string;
  onCapability?: (capability: ClickCapability) => void;
}

/**
 * Start sampling into a recording bundle.
 *
 * Resolves once click capability is known, so the caller can put the truth into
 * `recording.json`'s `capture.permissions.accessibility` before the first frame
 * rather than guessing at it afterwards.
 */
export async function startInputSampler(options: StartInputSamplerOptions): Promise<InputSampler> {
  const sampler = new InputSampler({
    sink: new ProjectStoreEventSink(options.store, options.id),
    t0Us: options.t0Us,
    ...(options.helperPath === undefined ? {} : { helperPath: options.helperPath }),
    ...(options.displayId === undefined ? {} : { displayId: options.displayId }),
    ...(options.clicks === undefined ? {} : { clicks: options.clicks }),
    ...(options.onCapability === undefined ? {} : { onCapability: options.onCapability }),
    onError: (error) => {
      // A sampler failure must never take a recording down with it: position and
      // clicks are both additive to the video, and §7.3's rule is that a lost
      // permission degrades the recording rather than ending it.
      console.error('[input-sampler]', error.message);
    },
  });
  await sampler.start();
  return sampler;
}

/**
 * Where the helper sits relative to the bundled main process.
 *
 * `dist/main/index.cjs` → `dist/native/loom-input-sampler`, unpacked out of the asar
 * archive by `electron-builder.yml` because an executable inside an archive cannot
 * be run. Passed explicitly rather than left to the package's own default so the one
 * place that knows this layout is the one place that owns `dist/`.
 */
export function helperPathFor(distRoot: string): string {
  return join(distRoot, 'native', 'loom-input-sampler');
}
