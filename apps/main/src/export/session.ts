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
import { basename, join } from 'node:path';
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
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import type { ProjectStore } from '../project-store.ts';
import { COPY_TIMESCALE, planStreamCopy, streamCopyEligibility } from './stream-copy.ts';
import { verifyExport, type VerificationIo } from './verify.ts';

/** How long main waits for the export window to answer a verification request. */
const VERIFY_TIMEOUT_MS = 60_000;

/** Bytes copied per read on the stream-copy path. */
const COPY_BATCH_BYTES = 8 * 1024 * 1024;

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
    });
    return { mode: decision.eligible ? 'stream-copy' : 'recompose', reasons: decision.reasons };
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
    job.settle?.reject(new ExportCancelled());
  }

  /** Every job still running, so shutdown can stop them. */
  async shutdown(): Promise<void> {
    for (const job of [...this.#jobs.values()]) {
      job.cancelled = true;
      job.settle?.reject(new ExportCancelled());
      await this.#options.store.cancelExport(job.id).catch(() => undefined);
      this.#options.closeWindow(job.id);
    }
    this.#jobs.clear();
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
    try {
      // The window first, always: on the fast path the copy below waits for the
      // writer, and the writer waits for the audio encoder to announce its track —
      // so a copy that started before the window would wait for a message nobody
      // had been asked to send.
      if (job.passes.audio || job.passes.video) {
        await this.#runWindow(job, edit, recording);
      }
      if (job.mode === 'stream-copy') {
        await this.#copyVideo(job, edit, recording);
      }
      await this.#awaitPasses(job);

      this.#report(job, 'muxing');
      const finished = await this.#options.store.finalizeExport(job.id);

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
      // Nothing partial survives, on either path — §7.5's obligation 1 read the
      // other way round: a file that is not verified must not be there to be
      // mistaken for one that is.
      await this.#options.store.cancelExport(job.id).catch(() => undefined);
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

  /** §5.3's remux, in main: source bytes in, output samples out, no decoder anywhere. */
  async #copyVideo(job: Job, edit: EditDocument, recording: RecordingDoc | null): Promise<void> {
    const part = recording?.tracks.screen?.parts[0];
    if (part === undefined) throw new Error('the recording has no screen part to copy');
    const store = this.#options.store;

    const mediaPath = await store.resolveBundleFile(job.recordingId, part.file);
    const indexDoc = await store.readFrameIndex(job.recordingId, part.index);
    const plan = planStreamCopy(indexDoc, part, edit.clips);
    const avcC = await store.readPartAvcC(job.recordingId, part.file);
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
    const window = this.#options.openWindow(job.id);
    if (window.webContents.isLoading()) {
      await new Promise<void>((done) => {
        window.webContents.once('did-finish-load', () => {
          done();
        });
      });
    }
    this.#send(job, { kind: 'start', job: message });
  }

  /**
   * Open the writer once every track that is coming has announced itself.
   *
   * Both encoders emit their `decoderConfig` with their first chunk, and the writer
   * needs the video one to describe the file and the audio one to describe its
   * track. So the first chunks are held by the store's own append queue behind this
   * call — which is why `onChunk` may be called before the writer exists and must
   * not drop what it is holding.
   */
  #openWriterWhenReady(job: Job): void {
    if (this.#options.store.hasOpenExport(job.id)) return;
    if (job.video?.spec == null) return;
    if (job.passes.audio && job.audio?.spec == null) return;
    const video = job.video.spec;
    const audio = job.audio?.spec ?? undefined;
    void this.#options.store
      .beginExport(job.id, {
        outputPath: job.outputPath,
        video,
        ...(audio === undefined ? {} : { audio }),
      })
      .catch((error: unknown) => {
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
   */
  async #decodeInWindow(
    job: Job,
    request: ExportDecodeRequest,
  ): Promise<{ ok: boolean; error?: string }> {
    const window = this.#options.openWindow(job.id);
    if (window.webContents.isLoading()) {
      await new Promise<void>((done) => {
        window.webContents.once('did-finish-load', () => {
          done();
        });
      });
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
  const source = basename(name);
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
