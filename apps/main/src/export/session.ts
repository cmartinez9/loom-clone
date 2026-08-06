/**
 * `ExportSession` — one export job, from a button press to a file on the clipboard.
 *
 * §1.2: *"Export · hidden · one hidden window per job; own GL context, decoder,
 * encoder"* and *"**The export window is owned by main, not by the editor.** Closing
 * the editor mid-export must not kill the export."* This class is that ownership.
 *
 * ## What it is responsible for, in order
 *
 * 1. work out the settings and the destination (captain decision 9 — a default, not
 *    a prompt);
 * 2. decide which pipeline (§5.3's stream-copy fast path, or compose-and-encode);
 * 3. open the writer, run the passes, write the file;
 * 4. **verify it** (§7.5's five checks, `verify.ts`);
 * 5. record the result in `project.json`, put the file on the clipboard, reveal it.
 *
 * Step 4 is why the rest exists in this shape. `decision-loom-storage-retention.md`
 * has phase 9 delete the user's only copy of the raw sources on the strength of what
 * this returns, so success has to be a thing that was *checked* rather than a thing
 * that was not interrupted. A cancelled or failed job leaves no file, records the
 * failure with the checks that did pass, and never reports `phase: 'done'`.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  CHANNEL,
  recordingUrl,
  type ExportChunkMsg,
  type ExportCommand,
  type ExportDecodeReport,
  type ExportDecodeRequest,
  type ExportFailedMsg,
  type ExportJob,
  type ExportMetaMsg,
  type ExportMode,
  type ExportPassDoneMsg,
  type ExportPassProgressMsg,
  type ExportPhase,
  type ExportProgress,
  type ExportResult,
  type ExportSettings,
  type ExportVideoSource,
} from '@loom/ipc';
import {
  AAC_FRAME_SAMPLES,
  AAC_ENCODER_DELAY_SAMPLES,
  type FastStartAudioSpec,
  type FastStartVideoSpec,
} from '@loom/mux';
import { compile, type CompiledTimeline } from '@loom/edl';
import {
  isoTimestamp,
  type EditDocument,
  type ExportRecord,
  type FrameIndexDoc,
  type RecordingDoc,
  type RecordingId,
  type VideoPart,
} from '@loom/format';
import type { ProjectStore } from '../project-store.ts';
import {
  COPY_TIMESCALE,
  StreamCopyRefused,
  planStreamCopy,
  streamCopyEligibility,
  type StreamCopyPlan,
} from './stream-copy.ts';
import { verifyExport, type VerificationIo } from './verify.ts';

/** How long main waits for the export window to answer a verification request. */
const VERIFY_TIMEOUT_MS = 60_000;

/**
 * How long main waits for the export window's page to load.
 *
 * Every other wait in this file is bounded and this one was not, which is §10.2's
 * named symptom exactly: a load that fails, or a window destroyed while the await is
 * pending, left the job in `phase: 'preparing'` for ever — no error broadcast, no
 * `cancelExport`, and its scratch files never removed. A `loom://app` page off the
 * local disk is milliseconds of work; thirty seconds is a machine in trouble, and a
 * typed error beats a spinner.
 */
const LOAD_TIMEOUT_MS = 30_000;

/** Bytes copied per read on the stream-copy path. */
const COPY_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * How much encoded media main will hold while it waits for the writer to open.
 *
 * The writer needs the video encoder's `avcC` to describe the file, and WebCodecs
 * hands that over **with the first output chunk** — so it is not possible for both
 * encoders to have announced themselves before either has emitted anything, and a
 * chunk that arrives before the writer exists is the normal case rather than a race.
 * On the recompose path it is the whole audio pass: §5.7 runs audio to completion
 * first, so every audio chunk of the export arrives before the video encoder has said
 * a word. Refusing them is what made every export of a recording with audio fail
 * before a single sample reached disk.
 *
 * So they are held, in arrival order, and appended the moment `beginExport` is under
 * way — the shape and the reason of `MAX_HELD_CHUNKS` in the recorder's `session.ts`.
 *
 * The bound is derived from the job rather than fixed, because "one audio pass" is a
 * different number of bytes for a twenty-second recording and a two-hour one:
 * twice what the pass could possibly encode, plus slack. More than that means the
 * writer is never going to open, and the export ends loudly rather than quietly
 * dropping audio nobody would notice missing.
 */
const HELD_SLACK_BYTES = 4 * 1024 * 1024;

function heldBudgetBytes(settings: ExportSettings, totalSec: number): number {
  const audioBytes = (Math.max(0, settings.audioBitrate) / 8) * (Math.max(0, totalSec) + 1);
  return Math.ceil(audioBytes * 2) + HELD_SLACK_BYTES;
}

/** Raised when the held buffer overruns {@link heldBudgetBytes}. */
export class HeldExportChunksOverflow extends Error {
  constructor(jobId: string, bytes: number, budget: number) {
    super(
      `export ${jobId} held ${bytes} bytes of encoded media waiting for its writer to open, ` +
        `past the ${budget} byte budget — the encoders never announced the tracks the file ` +
        'has to be described with',
    );
    this.name = 'HeldExportChunksOverflow';
  }
}

/** Raised when the export window never becomes usable. See {@link LOAD_TIMEOUT_MS}. */
export class ExportWindowUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportWindowUnavailable';
  }
}

/**
 * How the two passes share the progress bar.
 *
 * Audio is seconds of work and video is minutes (§5.7), so a 50/50 split would sit
 * at "50%" for the whole export. Ten percent still moves visibly at the start,
 * which is what a progress bar is for.
 */
const AUDIO_SHARE = 0.1;

export interface ExportSessionOptions {
  store: ProjectStore;
  /** Creates (or reuses) the hidden export window for a job. */
  openWindow: (jobId: string) => BrowserWindow;
  /** Closes it. Called on every exit path. */
  closeWindow: (jobId: string) => void;
  /** Broadcast progress to every live window. */
  broadcast: (progress: ExportProgress) => void;
  /** Put the finished file on the clipboard. Returns whether it worked. */
  copyToClipboard: (path: string) => boolean;
  /** Reveal it in Finder. Returns whether it worked. */
  reveal: (path: string) => boolean;
  /** Injected for tests. Defaults to `randomUUID`. */
  newJobId?: () => string;
}

interface Job {
  id: string;
  recordingId: RecordingId;
  settings: ExportSettings;
  outputPath: string;
  mode: ExportMode;
  timeline: CompiledTimeline;
  totalSec: number;
  /** Which passes the window owes us. */
  passes: { audio: boolean; video: boolean };
  audioDone: boolean;
  videoDone: boolean;
  cancelled: boolean;
  /** Set once a fatal error has been reported, so the first one wins. */
  failure: string | null;
  video: { spec: FastStartVideoSpec | null; durationUnits: number } | null;
  audio: { spec: FastStartAudioSpec | null } | null;
  progress: { audioSec: number; videoSec: number };
  startedAtMs: number;
  settle: { resolve: () => void; reject: (error: Error) => void } | null;
  decode: ((report: ExportDecodeReport) => void) | null;
  /**
   * Chunks that arrived before the writer was opened, in arrival order, and the
   * bytes they hold. `null` once the writer is opening — see
   * {@link heldBudgetBytes}.
   */
  held: ExportChunkMsg[] | null;
  heldBytes: number;
  /**
   * Waits that a cancel or a failure has to be able to break out of.
   *
   * `settle` covers the passes; this covers everything else that awaits an event
   * from a window, so a cancel is not silently lost against a load that will never
   * finish.
   */
  waiters: Set<(error: Error) => void>;
}

/** Everything `#copyVideo` needs, read and refused-or-accepted before any window exists. */
interface CopySources {
  part: VideoPart;
  mediaPath: string;
  plan: StreamCopyPlan;
  avcC: Uint8Array;
}

export class ExportSession {
  readonly #options: ExportSessionOptions;
  readonly #jobs = new Map<string, Job>();

  constructor(options: ExportSessionOptions) {
    this.#options = options;
  }

  /**
   * The settings a recording would export with right now.
   *
   * Size and frame rate from `edit.json`'s `output` — the editor's own answer to
   * "how big is this" — and the destination from `settings.json`. §5.7 defaults 30
   * fps even for a 60 fps capture, which the edit document already carries.
   */
  async defaults(id: RecordingId): Promise<ExportSettings> {
    const opened = await this.#options.store.readProject(id);
    const [width, height] = opened.edit.output.size;
    return {
      width,
      height,
      fps: opened.edit.output.fps,
      bitrate: bitrateFor(width, height, opened.edit.output.fps),
      audioBitrate: 128_000,
      outputDir: await this.#options.store.exportRoot(),
      name: safeFileName(opened.project.name),
      keepSources: false,
    };
  }

  /** Whether an export would be instant, and why not. For the button's label (§5.3). */
  async previewMode(
    id: RecordingId,
    settings: ExportSettings,
  ): Promise<{
    mode: ExportMode;
    reasons: string[];
  }> {
    const opened = await this.#options.store.readProject(id);
    const decision = streamCopyEligibility({
      edit: opened.edit,
      recording: opened.recording,
      settings,
      index: await this.#screenIndex(id, opened.recording),
    });
    return { mode: decision.eligible ? 'stream-copy' : 'recompose', reasons: decision.reasons };
  }

  /**
   * The screen part's frame index, for §5.3's keyframe condition.
   *
   * Only when there is exactly one part — with any other number the copy is already
   * refused for a reason that does not need a sidecar — and `null` rather than a
   * throw when it cannot be read, because an unreadable sidecar is a reason to
   * recompose rather than a reason to refuse the export.
   */
  async #screenIndex(
    id: RecordingId,
    recording: RecordingDoc | null,
  ): Promise<FrameIndexDoc | null> {
    const parts = recording?.tracks.screen?.parts ?? [];
    if (parts.length !== 1) return null;
    const part = parts[0];
    if (part === undefined) return null;
    return this.#options.store.readFrameIndex(id, part.index).catch(() => null);
  }

  async start(id: RecordingId, overrides: Partial<ExportSettings>): Promise<{ jobId: string }> {
    const settings = { ...(await this.defaults(id)), ...overrides };
    const jobId = (this.#options.newJobId ?? randomUUID)();
    // Opened, not read: the export records itself in `project.json` when it is done,
    // and `recordExport` requires the project to be open — the same rule the event
    // logs follow. Opening here also takes the bundle lock for the export's life.
    const opened = await this.#options.store.openProject(id);
    const timeline = compile(opened.edit, {
      cursor: null,
      clicks: null,
      recording: opened.recording,
    });

    const eligibility = streamCopyEligibility({
      edit: opened.edit,
      recording: opened.recording,
      settings,
      index: await this.#screenIndex(id, opened.recording),
    });
    const hasAudio = audioSources(id, opened.recording).length > 0;
    const job: Job = {
      id: jobId,
      recordingId: id,
      settings,
      outputPath: join(settings.outputDir, `${settings.name}.mp4`),
      mode: eligibility.eligible ? 'stream-copy' : 'recompose',
      timeline,
      totalSec: timeline.durationSec,
      passes: { audio: hasAudio, video: !eligibility.eligible },
      audioDone: false,
      videoDone: false,
      cancelled: false,
      failure: null,
      video: null,
      audio: null,
      progress: { audioSec: 0, videoSec: 0 },
      startedAtMs: Date.now(),
      settle: null,
      decode: null,
      held: [],
      heldBytes: 0,
      waiters: new Set(),
    };
    this.#jobs.set(jobId, job);

    void this.#run(job, opened.edit, opened.recording).catch((error: unknown) => {
      console.error('[export] job failed:', error);
    });
    return { jobId };
  }

  cancel(jobId: string): void {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.cancelled) return;
    job.cancelled = true;
    this.#send(job, { kind: 'cancel', jobId });
    this.#abandonWaits(job, new ExportCancelled());
    job.settle?.reject(new ExportCancelled());
  }

  /** Every job still running, so shutdown can stop them. */
  async shutdown(): Promise<void> {
    for (const job of [...this.#jobs.values()]) {
      job.cancelled = true;
      this.#abandonWaits(job, new ExportCancelled());
      job.settle?.reject(new ExportCancelled());
      await this.#options.store.cancelExport(job.id).catch(() => undefined);
      this.#options.closeWindow(job.id);
    }
    this.#jobs.clear();
  }

  /** Break every wait this job has outstanding. See {@link Job.waiters}. */
  #abandonWaits(job: Job, error: Error): void {
    for (const waiter of [...job.waiters]) waiter(error);
    job.waiters.clear();
  }

  // ------------------------------------------------- messages from the window

  onMeta(message: ExportMetaMsg): void {
    const job = this.#jobs.get(message.jobId);
    if (job === undefined) return;
    const config = message.decoderConfig;
    if (message.kind === 'video') {
      const description = config.description;
      if (description === undefined) {
        this.#fail(job, 'the video encoder produced no avcC, so the file cannot be described');
        return;
      }
      job.video = {
        spec: {
          width: config.codedWidth ?? job.settings.width,
          height: config.codedHeight ?? job.settings.height,
          // `fps * 1000`, so every CFR frame is exactly 1000 units.
          timescale: job.settings.fps * 1000,
          avcC: new Uint8Array(description),
          // The compositor works in sRGB and the export is tagged bt709 primaries
          // and matrix with the sRGB transfer curve — §4.5's "export writes tagged
          // bt709", stated in the file rather than left for a player to guess.
          colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
        },
        durationUnits: 1000,
      };
    } else {
      const description = config.description;
      if (description === undefined) {
        this.#fail(job, 'the audio encoder produced no AudioSpecificConfig');
        return;
      }
      job.audio = {
        spec: {
          sampleRate: config.sampleRate ?? 48000,
          channels: config.numberOfChannels ?? 2,
          audioSpecificConfig: new Uint8Array(description),
          bitrate: job.settings.audioBitrate,
          encoderDelaySamples: AAC_ENCODER_DELAY_SAMPLES,
        },
      };
    }
    this.#openWriterWhenReady(job);
  }

  onChunk(message: ExportChunkMsg): void {
    const job = this.#jobs.get(message.jobId);
    // A chunk that arrives after a failure is dropped on purpose: the job is already
    // being torn down and its writer cancelled, so appending would either throw into
    // nobody's hands or grow a file that is about to be unlinked.
    if (job === undefined) return;
    if (job.failure !== null) return;

    // Before the writer exists there is nothing to append to, and refusing is not an
    // option — see {@link heldBudgetBytes}. Held in arrival order, and the buffer is
    // what decides, not `hasOpenExport`: `held` is emptied synchronously by the same
    // call that starts the open, so a chunk can never overtake one already waiting.
    const held = job.held;
    if (held !== null) {
      const budget = heldBudgetBytes(job.settings, job.totalSec);
      if (job.heldBytes + message.data.byteLength > budget) {
        this.#fail(job, new HeldExportChunksOverflow(job.id, job.heldBytes, budget).message);
        return;
      }
      held.push(message);
      job.heldBytes += message.data.byteLength;
      return;
    }
    this.#appendChunk(job, message);
  }

  /** One chunk into the writer, queued behind whatever is already writing. */
  #appendChunk(job: Job, message: ExportChunkMsg): void {
    const kind = message.kind;
    const durationUnits = kind === 'video' ? (job.video?.durationUnits ?? 1000) : AAC_FRAME_SAMPLES;
    // Queued behind whatever is already writing, and its rejection is not dropped: a
    // failed append is the export ending, not a log line.
    void this.#options.store
      .appendExportSample(job.id, kind, {
        data: message.data,
        durationUnits,
        isKey: message.isKey,
        ...(kind === 'video' ? { timestampUs: message.timestampUs } : {}),
      })
      .catch((error: unknown) => {
        this.#fail(job, error instanceof Error ? error.message : String(error));
      });
  }

  onPassProgress(message: ExportPassProgressMsg): void {
    const job = this.#jobs.get(message.jobId);
    if (job === undefined) return;
    if (message.phase === 'audio') job.progress.audioSec = message.renderedSec;
    else job.progress.videoSec = message.renderedSec;
    this.#report(job, message.phase);
  }

  onPassDone(message: ExportPassDoneMsg): void {
    const job = this.#jobs.get(message.jobId);
    if (job === undefined) return;
    if (message.sampleCount === 0) {
      this.#fail(job, `the ${message.kind} pass produced no samples`);
      return;
    }
    if (message.kind === 'audio') job.audioDone = true;
    else job.videoDone = true;
    this.#settleIfComplete(job);
  }

  onFailed(message: ExportFailedMsg): void {
    const job = this.#jobs.get(message.jobId);
    if (job === undefined) return;
    this.#fail(job, message.message);
  }

  onDecoded(report: ExportDecodeReport): void {
    this.#jobs.get(report.jobId)?.decode?.(report);
  }

  // ------------------------------------------------------------------ the run

  async #run(job: Job, edit: EditDocument, recording: RecordingDoc | null): Promise<void> {
    this.#report(job, 'preparing');
    let renamed = false;
    try {
      // The copy is *planned* before anything is told anything, so a plan that has to
      // be refused becomes a recompose rather than a failed export. §5.3's conditions
      // are already in `streamCopyEligibility`, so this is the backstop rather than
      // the decision — but a refusal after the window has been given `passes.video:
      // false` cannot be recovered from, and recompose was available the whole time.
      const copy = job.mode === 'stream-copy' ? await this.#planCopy(job, edit, recording) : null;
      // The window next: on the fast path the copy below waits for the writer, and
      // the writer waits for the audio encoder to announce its track — so a copy that
      // started before the window would wait for a message nobody had been asked to
      // send.
      if (job.passes.audio || job.passes.video) {
        await this.#runWindow(job, edit, recording);
      }
      if (copy !== null) {
        await this.#copyVideo(job, copy);
      }
      await this.#awaitPasses(job);

      this.#report(job, 'muxing');
      const finished = await this.#options.store.finalizeExport(job.id);
      // From here the file is in place under its real name (§7.5's order: rename,
      // then verify), so a failure below has something to clean up.
      renamed = true;

      this.#report(job, 'verifying');
      const outcome = await verifyExport(job.outputPath, finished.durationSec, this.#io(job));
      const record: ExportRecord = {
        id: job.id,
        path: job.outputPath,
        completedAt: isoTimestamp(),
        settings: {
          width: job.settings.width,
          height: job.settings.height,
          fps: job.settings.fps,
          bitrate: job.settings.bitrate,
        },
        verified: outcome.verified,
        sourcesKept: job.settings.keepSources,
        ...(outcome.error === null ? {} : { error: outcome.error }),
      };
      await this.#options.store.recordExport(job.recordingId, record);

      if (outcome.failure !== null) {
        throw new Error(outcome.error ?? `verification failed at ${outcome.failure}`);
      }

      // Captain decision 9's whole contract, in three lines: on disk, on the
      // clipboard, revealed in Finder.
      const copiedToClipboard = this.#options.copyToClipboard(job.outputPath);
      const revealed = this.#options.reveal(job.outputPath);
      const result: ExportResult = {
        path: job.outputPath,
        bytes: outcome.verified.bytes,
        durationSec: outcome.verified.durationSec,
        verified: outcome.verified,
        copiedToClipboard,
        revealed,
        sourcesKept: job.settings.keepSources,
        mode: job.mode,
      };
      this.#finish(job, { phase: 'done', result });
    } catch (error) {
      const cancelled = error instanceof ExportCancelled || job.cancelled;
      // Nothing survives, on either path — §7.5's obligation 1 read the other way
      // round: a file that is not verified must not be there to be mistaken for one
      // that is. Before the rename that is the writer's scratch; after it, the output
      // itself, which is why `renamed` is tracked rather than assumed — an unlink of
      // the path on a job that never got that far would remove an *earlier* good
      // export that happened to share the name.
      await this.#options.store.cancelExport(job.id).catch(() => undefined);
      if (renamed) {
        await this.#options.store.discardExport(job.outputPath).catch(() => undefined);
      }
      this.#finish(job, {
        phase: cancelled ? 'cancelled' : 'failed',
        ...(cancelled
          ? {}
          : { error: job.failure ?? (error instanceof Error ? error.message : String(error)) }),
      });
    } finally {
      this.#options.closeWindow(job.id);
      this.#jobs.delete(job.id);
    }
  }

  /**
   * Read what a copy would need, and refuse it into a recompose if it cannot.
   *
   * Returns `null` having downgraded the job — mode, passes and all — so the window
   * is asked for a video pass and the export produces the same file it would have
   * produced had eligibility said so in the first place. A refusal is not a failure:
   * §5.3's fast path is an optimisation, and the slow path can express every edit.
   *
   * Only {@link StreamCopyRefused} downgrades. An I/O error reading the sidecar or
   * the part is a real problem with the recording and is reported as one, rather than
   * being turned into a recompose that will hit the same file three layers down.
   */
  async #planCopy(
    job: Job,
    edit: EditDocument,
    recording: RecordingDoc | null,
  ): Promise<CopySources | null> {
    const part = recording?.tracks.screen?.parts[0];
    if (part === undefined) {
      this.#recompose(job, 'the recording has no screen part to copy');
      return null;
    }
    const store = this.#options.store;
    const mediaPath = await store.resolveBundleFile(job.recordingId, part.file);
    const indexDoc = await store.readFrameIndex(job.recordingId, part.index);
    let plan: StreamCopyPlan;
    try {
      plan = planStreamCopy(indexDoc, part, edit.clips);
    } catch (error) {
      if (!(error instanceof StreamCopyRefused)) throw error;
      this.#recompose(job, error.message);
      return null;
    }
    const avcC = await store.readPartAvcC(job.recordingId, part.file);
    return { part, mediaPath, plan, avcC };
  }

  /** Move a job off the fast path before anything has been committed to it. */
  #recompose(job: Job, reason: string): void {
    console.warn(`[export] ${job.id}: recomposing rather than copying — ${reason}`);
    job.mode = 'recompose';
    job.passes.video = true;
  }

  /** §5.3's remux, in main: source bytes in, output samples out, no decoder anywhere. */
  async #copyVideo(job: Job, copy: CopySources): Promise<void> {
    const { part, mediaPath, plan, avcC } = copy;
    const store = this.#options.store;
    const colour = colourOf(part);

    job.video = {
      spec: {
        width: plan.width,
        height: plan.height,
        timescale: COPY_TIMESCALE,
        avcC,
        ...(colour === null ? {} : { colour }),
      },
      durationUnits: 0,
    };
    job.totalSec = plan.durationSec;
    this.#openWriterWhenReady(job);
    // A copy cannot start before the writer exists, and the writer waits for the
    // audio encoder's config when there is audio. Waiting here rather than
    // interleaving keeps the ordering trivially correct: the audio pass has already
    // announced itself by the time `#runWindow` returns for a copy job.
    await this.#waitForWriter(job);

    let done = 0;
    for (let at = 0; at < plan.samples.length;) {
      if (job.cancelled) throw new ExportCancelled();
      // Batched by bytes rather than by count: a 4K keyframe is megabytes and a
      // static-screen P-frame is a few hundred bytes.
      let bytes = 0;
      let to = at;
      while (to < plan.samples.length && bytes < COPY_BATCH_BYTES) {
        bytes += plan.samples[to]?.byteLength ?? 0;
        to += 1;
      }
      const batch = plan.samples.slice(at, to);
      const payloads = await store.readFileRanges(
        mediaPath,
        batch.map((sample) => ({ offset: sample.offset, byteLength: sample.byteLength })),
      );
      for (const [i, sample] of batch.entries()) {
        const data = payloads[i];
        if (data === undefined) throw new Error('the copy read fewer ranges than it asked for');
        await store.appendExportSample(job.id, 'video', {
          data,
          durationUnits: sample.durationUnits,
          isKey: sample.isKey,
        });
        done += sample.durationUnits;
      }
      at = to;
      job.progress.videoSec = done / plan.timescale;
      this.#report(job, 'video');
    }
    job.videoDone = true;
    this.#settleIfComplete(job);
  }

  /** Hand the job to the hidden window and let it get on with it. */
  async #runWindow(job: Job, edit: EditDocument, recording: RecordingDoc | null): Promise<void> {
    const message: ExportJob = {
      jobId: job.id,
      recordingId: job.recordingId,
      settings: job.settings,
      edit,
      recording,
      screen: videoSources(job.recordingId, recording),
      audio: audioSources(job.recordingId, recording),
      durationSec: job.totalSec,
      passes: job.passes,
    };
    // The window is created here rather than at `start`, so a job that is refused
    // before this point never lights one up.
    await this.#awaitWindowReady(job, this.#options.openWindow(job.id));
    this.#send(job, { kind: 'start', job: message });
  }

  /**
   * Wait for the window's page, bounded on every axis it can fail on.
   *
   * A load that fails, a window destroyed under us, a machine that has stopped
   * answering, and a cancel that lands while this is pending — each of them used to
   * be the same thing: a promise nobody would ever settle, and a job wedged in
   * `phase: 'preparing'` with its scratch files still on disk (§10.2).
   */
  async #awaitWindowReady(job: Job, window: BrowserWindow): Promise<void> {
    if (window.isDestroyed()) {
      throw new ExportWindowUnavailable('the export window was destroyed before it loaded');
    }
    if (!window.webContents.isLoading()) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.waiters.delete(finish);
        if (error === null) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => {
        finish(
          new ExportWindowUnavailable(
            `the export window did not finish loading within ${LOAD_TIMEOUT_MS} ms`,
          ),
        );
      }, LOAD_TIMEOUT_MS);
      // A cancel or a failure reaches in through here rather than being lost.
      job.waiters.add(finish);

      window.webContents.once('did-finish-load', () => {
        finish(null);
      });
      window.webContents.once('did-fail-load', (_event, code: number, description: string) => {
        finish(
          new ExportWindowUnavailable(`the export window failed to load (${code} ${description})`),
        );
      });
      window.webContents.once('destroyed', () => {
        finish(new ExportWindowUnavailable('the export window was destroyed before it loaded'));
      });
    });
  }

  /**
   * Open the writer once every track that is coming has announced itself.
   *
   * Both encoders emit their `decoderConfig` with their first chunk, and the writer
   * needs the video one to describe the file and the audio one to describe its
   * track. So chunks *always* arrive before this can be called — `onChunk` holds
   * them, and this is what releases them.
   *
   * The flush is synchronous and happens the instant `beginExport` is entered rather
   * than when it resolves: `ProjectStore.openExports` registers its promise before
   * its first `await`, so an append issued from here queues behind the open, and
   * emptying `job.held` in the same turn is what guarantees no later chunk can
   * overtake one that was waiting.
   */
  #openWriterWhenReady(job: Job): void {
    // `held` rather than `hasOpenExport`: this is set synchronously below, so two
    // announcements in one turn cannot both start an open.
    if (job.held === null) return;
    if (job.video?.spec == null) return;
    if (job.passes.audio && job.audio?.spec == null) return;
    const video = job.video.spec;
    const audio = job.audio?.spec ?? undefined;
    const held = job.held;
    job.held = null;
    job.heldBytes = 0;

    const opening = this.#options.store.beginExport(job.id, {
      outputPath: job.outputPath,
      video,
      ...(audio === undefined ? {} : { audio }),
    });
    for (const message of held) this.#appendChunk(job, message);
    void opening.catch((error: unknown) => {
      this.#fail(job, error instanceof Error ? error.message : String(error));
    });
  }

  async #waitForWriter(job: Job): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!this.#options.store.hasOpenExport(job.id)) {
      if (job.cancelled) throw new ExportCancelled();
      if (job.failure !== null) throw new Error(job.failure);
      if (Date.now() > deadline) throw new Error('the export writer never opened');
      await new Promise((done) => setTimeout(done, 10));
    }
  }

  #awaitPasses(job: Job): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      job.settle = { resolve, reject };
      this.#settleIfComplete(job);
    });
  }

  #settleIfComplete(job: Job): void {
    // Cancellation first, and checked here rather than only in `cancel()`: the window
    // is handed the job before `#awaitPasses` installs the settle, so a cancel — or a
    // window that fails instantly — can land while there is nothing to reject. Losing
    // it would leave the job waiting for a pass nobody is running, which is §10.2's
    // hang with a different cause.
    if (job.cancelled) {
      job.settle?.reject(new ExportCancelled());
      return;
    }
    if (job.failure !== null) {
      job.settle?.reject(new Error(job.failure));
      return;
    }
    if (job.passes.audio && !job.audioDone) return;
    if (!job.videoDone) return;
    job.settle?.resolve();
  }

  #fail(job: Job, message: string): void {
    job.failure ??= message;
    // Held chunks belong to a file that is not going to exist. Dropped here rather
    // than left, so a job that fails before its writer opened does not sit on the
    // memory it was holding until `#run`'s `finally` deletes it.
    job.held = null;
    job.heldBytes = 0;
    this.#abandonWaits(job, new Error(job.failure));
    job.settle?.reject(new Error(job.failure));
  }

  /** The I/O `verifyExport` needs, wired to the store and the export window. */
  #io(job: Job): VerificationIo {
    const store = this.#options.store;
    return {
      size: (path) => store.fileSize(path),
      readHead: (path, byteLength) => store.readFileHead(path, byteLength),
      readRanges: (path, ranges) => store.readFileRanges(path, ranges),
      hash: (path) => store.hashFile(path),
      decode: (request) => this.#decodeInWindow(job, request),
    };
  }

  /**
   * Ask the export window to decode the last GOP.
   *
   * The window is still open at this point on both paths: a stream copy that had no
   * audio never opened one, so it is opened now — the decoder has to live somewhere,
   * and §7.5's fifth check is not optional on the fast path.
   *
   * A window that cannot be reached is answered as a *failed check* rather than
   * thrown out of: §7.5's fifth question is "does the last frame decode", and "we
   * could not ask" is not a yes. Failing it here keeps the record in `project.json`,
   * which is what phase 9 reads.
   */
  async #decodeInWindow(
    job: Job,
    request: ExportDecodeRequest,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.#awaitWindowReady(job, this.#options.openWindow(job.id));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        job.decode = null;
        resolve({ ok: false, error: 'the export window did not answer the decode check' });
      }, VERIFY_TIMEOUT_MS);
      job.decode = (report) => {
        clearTimeout(timer);
        job.decode = null;
        resolve(
          report.ok
            ? { ok: true }
            : { ok: false, ...(report.error === undefined ? {} : { error: report.error }) },
        );
      };
      this.#send(job, { kind: 'verify', jobId: job.id, request });
    });
  }

  #send(job: Job, command: ExportCommand): void {
    const window = this.#options.openWindow(job.id);
    if (window.isDestroyed()) return;
    window.webContents.send(CHANNEL.exportCommand, command);
  }

  #report(job: Job, phase: ExportPhase): void {
    const audioShare = job.passes.audio ? AUDIO_SHARE : 0;
    const audioFraction = job.totalSec > 0 ? job.progress.audioSec / job.totalSec : 0;
    const videoFraction = job.totalSec > 0 ? job.progress.videoSec / job.totalSec : 0;
    const completed = Math.min(
      1,
      audioShare * Math.min(1, audioFraction) + (1 - audioShare) * Math.min(1, videoFraction),
    );
    const elapsedMs = Date.now() - job.startedAtMs;
    this.#options.broadcast({
      jobId: job.id,
      recordingId: job.recordingId,
      phase,
      mode: job.mode,
      completed,
      renderedSec: job.progress.videoSec,
      totalSec: job.totalSec,
      // Only once there is enough to extrapolate from: an estimate off the first
      // percent of an export is a number that lies for a minute and then jumps.
      etaSec: completed > 0.05 ? Math.max(0, (elapsedMs / 1000) * (1 / completed - 1)) : null,
    });
  }

  #finish(job: Job, outcome: { phase: ExportPhase; result?: ExportResult; error?: string }): void {
    this.#options.broadcast({
      jobId: job.id,
      recordingId: job.recordingId,
      phase: outcome.phase,
      mode: job.mode,
      completed: outcome.phase === 'done' ? 1 : 0,
      renderedSec: job.progress.videoSec,
      totalSec: job.totalSec,
      etaSec: 0,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
  }
}

class ExportCancelled extends Error {
  constructor() {
    super('the export was cancelled');
    this.name = 'ExportCancelled';
  }
}

/** The screen track's parts, as `loom://` URLs the export window can range-request. */
export function videoSources(id: RecordingId, recording: RecordingDoc | null): ExportVideoSource[] {
  const track = recording?.tracks.screen;
  if (track === undefined) return [];
  return track.parts
    .map((part) => ({
      mediaUrl: recordingUrl(id, part.file),
      indexUrl: recordingUrl(id, part.index),
      part,
    }))
    .sort((a, b) => a.part.startTimeSec - b.part.startTimeSec);
}

/** Every audio part of both tracks, in one list. */
export function audioSources(id: RecordingId, recording: RecordingDoc | null): ExportJob['audio'] {
  const out: ExportJob['audio'] = [];
  for (const key of ['mic', 'system'] as const) {
    const track = recording?.tracks[key];
    if (track === undefined) continue;
    for (const part of track.parts) {
      out.push({ track: key, mediaUrl: recordingUrl(id, part.file), part });
    }
  }
  return out;
}

/** The source part's `colr`, mapped to the numeric form the muxer writes. */
function colourOf(part: {
  colr?: { primaries: string; transfer: string; matrix: string; fullRange: boolean };
}): {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
} | null {
  if (part.colr === undefined) return null;
  const code = (value: string, fallback: number): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : fallback;
  };
  return {
    primaries: code(part.colr.primaries, 1),
    transfer: code(part.colr.transfer, 13),
    matrix: code(part.colr.matrix, 1),
    fullRange: part.colr.fullRange,
  };
}

/**
 * A default video bitrate for an output size.
 *
 * Roughly 0.1 bits per pixel per frame, which puts a 4K30 export at ~25 Mbit/s and a
 * 1080p30 one at ~6 — in the range screen content wants, where a photographic scene
 * would want more. Clamped so a tiny output does not get an absurdly low ceiling.
 */
export function bitrateFor(width: number, height: number, fps: number): number {
  const raw = Math.round(width * height * fps * 0.1);
  return Math.min(40_000_000, Math.max(2_000_000, raw));
}

/**
 * A recording's name, made safe to be a file name.
 *
 * A recording is named by a person, so it can hold a slash, a colon or a newline,
 * and the name reaches here from a renderer. Everything that is a path separator, a
 * shell metacharacter or a control character becomes a space; a leading dot goes, so
 * an export cannot be created hidden. Rejecting instead would be worse: "Q3 / demo"
 * is a reasonable thing to call a recording.
 */
export function safeFileName(name: string): string {
  // Deliberately **not** `basename`. It splits on the separator, so a recording a
  // person called "Q3 / demo" would export as "demo.mp4" — half the name gone, with
  // nothing to notice. Scrubbing the separators to spaces is what makes the result a
  // single path segment, and it keeps the whole name while doing it.
  const source = name;
  let scrubbed = '';
  // Code unit by code unit rather than by code point: every character being replaced
  // is ASCII, so a surrogate pair can only ever fall through untouched — and
  // iterating code points would decompose a family emoji into four names' worth of
  // people for no benefit.
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    const character = source[i] ?? '';
    scrubbed +=
      UNSAFE_NAME_CHARACTERS.has(character) || code < 0x20 || code === 0x7f ? ' ' : character;
  }
  const cleaned = scrubbed.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  return cleaned.length === 0 ? 'Recording' : cleaned.slice(0, 120);
}

/** Path separators and shell metacharacters. Control characters are checked by code. */
const UNSAFE_NAME_CHARACTERS = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);
