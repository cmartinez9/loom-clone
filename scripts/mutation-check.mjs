/**
 * The mutation proof for the gates: phase 1's crash gate, phase 3's A/V sync gate,
 * phase 4's camera-unplug gate, §7.3's revoked-microphone path, phase 7's timeline
 * model, phase 8's export, phase 9's delete-after-export retention, phase 10's
 * generators, phase 11's golden-frame gate over annotations and phase 12's live
 * drawing overlay.
 *
 *   node scripts/mutation-check.mjs [--only <name>]
 *
 * A crash test that passes tells you nothing on its own — phase 0 shipped one that
 * exercised a *copy* of the writer it claimed to protect, so a regression in the
 * real one would have left it green. The only way to know a gate is measuring
 * something is to break the thing it measures and watch it fail.
 *
 * So: for each mutation below, this script edits the **production source on disk**,
 * runs the tests that are supposed to catch it, and requires them to fail. A
 * mutation that survives is reported as a hole in the gate and the script exits
 * non-zero. Sources are restored in a `finally`, and again on SIGINT, so an
 * interrupted run does not leave a broken writer behind.
 *
 * This is not part of `npm test`: it takes minutes and it deliberately breaks the
 * working tree while it runs. It is `npm run verify:mutation`, and its output
 * belongs in the phase's evidence.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GATE = 'apps/main/test/capture-crash.test.ts';
const MUX = 'packages/mux/test/media-part.test.ts';
const WRITER = 'packages/mux/test/fragment-writer.test.ts';
const LIFECYCLE = 'apps/main/test/capture-lifecycle.test.ts';
/** The phase 3 gate: flash/tone sync at 1 minute and at 20 minutes. */
const SYNC = 'apps/main/test/av-sync.test.ts';
const SYNC_UNIT = 'packages/format/test/sync.test.ts';
const AUDIO_MUX = 'packages/mux/test/audio-part.test.ts';
/** The phase 4 gate: unplug the camera, keep the screen, two parts placed right. */
const PHASE4 = 'test/phase4-gate.test.ts';
const RECORDER = 'apps/main/test/recorder-session.test.ts';
/** The capture page's own lifecycle, including §7.3's mid-recording track end. */
const RECORDER_CAPTURE_PAGE = 'apps/renderer/test/capture-session.test.ts';
/** Phase 7's two gates, and the tests that carry the model's other properties. */
const EDL_DETERMINISM = 'packages/edl/test/spring-determinism.test.ts';
const EDL_SPRING = 'packages/edl/test/spring.test.ts';
const EDL_RESOLVE = 'packages/edl/test/resolve.test.ts';
const EDL_CHANNEL = 'packages/edl/test/channel.test.ts';
const EDL_HISTORY = 'packages/edl/test/history.test.ts';
const FORMAT_JOURNAL = 'packages/format/test/journal.test.ts';
/** Phase 8's gate — preview and export pixel-identical — and the tests around it. */
const PHASE8 = 'test/phase8-gate.test.ts';
const EXPORT_LOOP = 'apps/renderer/test/export-render-loop.test.ts';
const EXPORT_MOVIE = 'packages/mux/test/export-movie.test.ts';
const EXPORT_VERIFY = 'apps/main/test/export-verify.test.ts';
const EXPORT_SESSION = 'apps/main/test/export-session.test.ts';
const EXPORT_COPY = 'apps/main/test/export-stream-copy.test.ts';
const EXPORT_ENCODE = 'apps/renderer/test/export-encode.test.ts';
const EXPORT_AUDIO = 'apps/renderer/test/audio-source.test.ts';
/**
 * Phase 9's gates: the ten verification failure modes with the sources surviving
 * each one, and a `SIGKILL` aimed at each of §7.5's three deletion steps.
 */
const PHASE9 = 'apps/main/test/phase9-retention.test.ts';
const RETENTION_CRASH = 'apps/main/test/retention-crash.test.ts';
const FORMAT_RETENTION = 'packages/format/test/retention.test.ts';
/** Phase 10's gate: the comfort budget on ten real recordings, and its control. */
const PHASE10 = 'packages/edl/test/phase10-gate.test.ts';
const EDL_CONDITIONING = 'packages/edl/test/conditioning.test.ts';
const EDL_DEAD_ZONE = 'packages/edl/test/dead-zone.test.ts';
const EDL_AUTO_ZOOM = 'packages/edl/test/auto-zoom.test.ts';
const EDL_STACKING = 'packages/edl/test/generator-stacking.test.ts';
const EDL_BUDGET = 'packages/edl/test/budget.test.ts';
/** Phase 11's gate: the golden-frame test, extended to annotations. */
const PHASE11 = 'test/phase11-golden.test.ts';
const EDL_ANNOTATIONS = 'packages/edl/test/annotations.test.ts';
const COMPOSITOR_GEOMETRY = 'packages/compositor/test/annotation-geometry.test.ts';
/**
 * Phase 12's gates: the live overlay in a real Electron renderer, and the pieces
 * around it.
 *
 * There is deliberately **no** mutation here for `setContentProtection` at the
 * `drawing-overlay` role. That measurement needs a screen capture and therefore the
 * Screen Recording grant, so it lives in `apps/main/src/verify/permissions-harness.ts`
 * as `overlay-content-protection` rather than in `npm test`, and no vitest file can
 * catch a mutation that removes it: `apps/main/test/windows.test.ts` structurally
 * cannot, because the mutation leaves the role still *declaring* `contentProtected`
 * and only skips the call. The property is guarded instead by that harness check's own
 * **control window** — same role options, same page, same calls, the flag never set —
 * which must show the marker before the protected window's absence means anything.
 * A mutation kept here would be reported as caught when nothing had caught it, which
 * is worse than the gap it papers over.
 */
const EDL_DRAWING = 'packages/edl/test/drawing.test.ts';
const OVERLAY = 'apps/main/test/overlay.test.ts';
const COMPOSITOR_STROKE = 'packages/compositor/test/stroke-pass.test.ts';
/** The event logs a recording writes, driven through `RecorderSession` itself. */
const EVENTS = 'apps/main/test/recorder-events.test.ts';
/**
 * The phase-6 gate's own judgement policy: which host earns which bound, and when a
 * phase is not judged at all.
 *
 * The source under test is `test/gate/budget-control.ts`, which is the gate's
 * production code even though it lives under `test/` — the phase-6 gate is what
 * consumes it, and a hole here is a run reported as a pass that nothing established.
 */
const BUDGET_POLICY = 'test/budget-control.test.ts';

/**
 * Each mutation is a one-line edit that breaks exactly one of the properties the
 * gate rests on, plus the tests that must notice.
 */
const MUTATIONS = [
  {
    name: 'fragments-buffered-until-stop',
    breaks:
      'fragments are produced as frames arrive. This makes the writer hold every ' +
      'frame until the recording stops, which is the configuration architecture ' +
      'report §12.2 measured at zero recovered frames.',
    file: 'packages/mux/src/fragment-writer.ts',
    find: '    return this.emit(previous, measured > 0 ? measured : 1);',
    replace: '    return null;',
    mustFail: [GATE, LIFECYCLE],
  },
  {
    name: 'no-initialisation-segment',
    breaks:
      'the ftyp + empty moov is written before the first frame. Without it the ' +
      'file is a pile of fragments no demuxer will open, which is the "moov at the ' +
      'end" failure that loses the whole recording.',
    file: 'packages/mux/src/fs/media-part-writer.ts',
    find: '      await part.writeAll(handle, init);',
    replace: '      await part.writeAll(handle, init.subarray(0, 0));',
    mustFail: [GATE, MUX],
  },
  {
    name: 'index-offsets-point-at-the-moof',
    breaks:
      'every frame index entry points at the sample data. Off by one box header, ' +
      'the sidecar phase 6 seeks with lands on the fragment header instead of the ' +
      'frame — a file that still plays and an editor that cannot decode it.',
    file: 'packages/mux/src/fragment-writer.ts',
    find: '      offsetBytes: this.fileBytes + (bytes.byteLength - sample.data.byteLength),',
    replace: '      offsetBytes: this.fileBytes,',
    // Not the crash gate: recovery rebuilds the index by scanning the file, so it
    // is blind to a writer that computes offsets wrongly. The sidecar a *clean*
    // stop writes is the one at risk, and these two read it.
    mustFail: [MUX, LIFECYCLE],
  },
  {
    name: 'last-frame-does-not-reach-the-stop',
    breaks:
      'the last frame stands for the still screen that follows it. A screen track ' +
      'stops producing frames when the screen stops changing, so without this a ' +
      'four second recording of a static screen reports as a fraction of a second.',
    file: 'packages/mux/src/fragment-writer.ts',
    find: '    if (measured !== null && measured > 0) return this.emit(last, measured);',
    replace: '    if (measured !== null && measured < 0) return this.emit(last, measured);',
    mustFail: [WRITER],
  },
  {
    name: 'torn-tail-left-in-place',
    breaks:
      'recovery truncates a fragment that was mid-write. Leaving it welds the next ' +
      'write onto a partial box, so the damage outlives the crash that caused it.',
    file: 'packages/mux/src/fs/recover.ts',
    find: '    await handle.truncate(endsAt);',
    replace: '    await handle.sync();',
    mustFail: [MUX, LIFECYCLE],
  },
  {
    name: 'audio-rate-taken-as-nominal',
    breaks:
      'measuredSampleRate is measured rather than assumed. A device that reports ' +
      '48000 Hz does not run at 48000.000 Hz, and taking its word for it is the ' +
      'drift architecture report §5.5 and §10.1 both name — invisible at one ' +
      'minute, 60 ms at twenty.',
    file: 'packages/format/src/sync/audio-meter.ts',
    find: '    const measured = spanUs > 0 && measurable > 0 ? measurable / (spanUs / 1_000_000) : null;',
    replace: '    const measured = null;',
    mustFail: [SYNC, SYNC_UNIT],
  },
  {
    name: 'encoder-priming-not-trimmed',
    breaks:
      "the edit list that trims the AAC encoder's 2112 priming samples. Two " +
      'demuxers then give two different answers about where the audio starts, 44 ms ' +
      'apart — twice the phase 3 sync budget. Not the sync gate: AVFoundation, which ' +
      'is what decodes the tone there, applies the trim whether the file asks for it ' +
      'or not. The audio-part test is where it shows, against both decoders.',
    file: 'packages/mux/src/boxes.ts',
    find: '    ...(delaySamples > 0 ? [editList(delaySamples)] : []),',
    replace: '    ...[],',
    mustFail: [AUDIO_MUX],
  },
  {
    name: 'audio-gaps-closed-instead-of-reproduced',
    breaks:
      'a gap in the captured audio is reproduced as silence of exactly its length ' +
      '(§5.4 mechanism 5). Closing it shortens the track by the gap and ' +
      'desynchronises everything after it — permanently, and invisibly at first.',
    file: 'packages/format/src/sync/align.ts',
    find: '    startSec = gap.atSec + Math.max(0, gap.durationSec);',
    replace: '    startSec = gap.atSec;',
    mustFail: [SYNC, SYNC_UNIT],
  },
  {
    name: 'second-part-placed-at-the-origin',
    breaks:
      'every part of a video track carries its own startTimeSec (§2.3, §5.4 ' +
      'mechanism 2). Collapsing it to zero puts webcam.001.mp4 on top of ' +
      'webcam.000.mp4 for the length of the recording — two files, both playable, ' +
      'and a camera that plays over the wrong part of the screen.',
    file: 'apps/main/src/recorder/session.ts',
    find: '                : videoPartStartSec({',
    replace: '                : 0 * videoPartStartSec({',
    mustFail: [PHASE4],
  },
  {
    name: 'part-start-not-snapped-to-the-reference',
    breaks:
      'sub-buffer offsets are snapped onto the reference track (§5.4 mechanism 3). ' +
      'Without it a camera that opened 10 ms after the screen is recorded as ' +
      'starting 10 ms late, and every consumer resamples to honour noise.',
    file: 'packages/format/src/sync/align.ts',
    find: '  return snapNearby(\n    raw,\n    options.referenceStartSec,',
    replace: '  return snapNearby(\n    raw,\n    null,',
    mustFail: [PHASE4],
  },
  {
    name: 'camera-never-reacquired',
    breaks:
      'a camera that comes back opens the next part (§7.4 step 4). Without it the ' +
      'unplug is permanent: the recording keeps its screen and its audio, and ' +
      'silently has no camera for everything after the moment the cable moved.',
    file: 'apps/renderer/src/capture/webcam.ts',
    find: "      void this.loseCurrentPart('device-lost', { reacquire: true });",
    replace: "      void this.loseCurrentPart('device-lost', { reacquire: false });",
    mustFail: [PHASE4],
  },
  {
    name: 'lost-part-never-announced',
    breaks:
      'a part that closed while the recording carried on is announced, so main ' +
      'finalizes that file and lets the next part open. Swallowing it leaves the ' +
      'first part open forever: main refuses the reconnect as a part it already ' +
      'has, and the camera is written into one file with the unplug concatenated ' +
      'out of it.',
    file: 'apps/renderer/src/capture/webcam.ts',
    find: '    this.sink.partEnded(this.reportFor(acquisition, true, reason));',
    replace: '    void reason;',
    mustFail: [PHASE4],
  },
  {
    name: 'held-frames-dropped-while-a-part-opens',
    breaks:
      'frames that arrive while a part is being created are held and written the ' +
      'moment it opens. Discarding them costs the initial keyframe and everything ' +
      'up to the next one — a second of footage per part, with no error anywhere.',
    file: 'apps/main/src/recorder/session.ts',
    find: '      if (chunk.part === state.part) this.appendChunk(active, state, chunk);',
    replace: '      if (chunk.part !== state.part) this.appendChunk(active, state, chunk);',
    mustFail: [PHASE4, RECORDER],
  },

  // ---- §7.3: a Microphone grant withdrawn mid-recording -------------------
  {
    name: 'revoked-microphone-treated-as-a-lost-device',
    breaks:
      'the one distinction `decision-mic-revocation.md` is about. Reading TCC is ' +
      'what tells a withdrawn Microphone grant apart from an unplugged interface, ' +
      'and answering "still granted" for every audio track that ends puts the ' +
      "revocation straight back on §7.4's webcam path: recorded as device-lost, " +
      'with the recording carrying on and nobody told why the voice went away.',
    file: 'apps/main/src/recorder/session.ts',
    find: "  if (cause !== 'track-ended') return 'crash';\n  return stillGranted ? 'device-lost' : 'permission-revoked';",
    replace: "  if (cause !== 'track-ended') return 'crash';\n  return 'device-lost';",
    mustFail: [RECORDER],
  },
  {
    name: 'audio-track-end-not-reported-while-recording',
    breaks:
      'the capture page telling main a track stopped **as it happens**. Held until ' +
      'the end report instead, the TCC read that decides the cause is taken minutes ' +
      'after the grant moved — and a recording that should have stopped at minute ' +
      'two runs to the end without its microphone.',
    file: 'apps/renderer/src/capture/audio.ts',
    find: '  sink.ended({ track: capture.track, part: capture.part, cause, detail });',
    replace: '  void cause;\n  void detail;',
    mustFail: [RECORDER_CAPTURE_PAGE],
  },

  // ---- phase 7: the timeline model ---------------------------------------
  {
    name: 'spring-integrated-at-frame-rate',
    breaks:
      'the fixed 8 ms grid (§3.4). Integrating at 60 fps instead is the one thing ' +
      'the report says never to do: a 60 fps preview and a 30 fps export then put ' +
      'the zoom in visibly different places, measured at 82.6 px on a 3456-wide ' +
      'source, and a single dropped preview frame shifts the framing for the rest ' +
      'of the shot.',
    file: 'packages/edl/src/spring.ts',
    find: 'export const SPRING_GRID_SEC = 0.008;',
    replace: 'export const SPRING_GRID_SEC = 1 / 60;',
    mustFail: [EDL_DETERMINISM],
  },
  {
    name: 'spring-integrated-numerically-not-analytically',
    breaks:
      "the closed-form solution (§3.4: *'exact at any step size and identical on " +
      "every machine'*). A forward-Euler step gives an answer that depends on how " +
      'the interval was divided and accumulates its own error over a thirty-minute ' +
      'channel, so two builds sampling the same channel differently disagree.',
    file: 'packages/edl/src/spring.ts',
    find:
      '    const x = decay * (x0 * cos + b * sin);\n' +
      '    const v = decay * (v0 * cos - ((omega0 * omega0 * x0 + zeta * omega0 * v0) / omegaD) * sin);',
    replace:
      '    const acceleration = -omega0 * omega0 * x0 - 2 * zeta * omega0 * v0;\n' +
      '    const v = v0 + acceleration * dt;\n' +
      '    const x = x0 + v * dt;',
    mustFail: [EDL_SPRING],
  },
  {
    name: 'clip-speed-ignored-in-the-time-mapping',
    breaks:
      'the clip list being the *only* mapping between the two time domains (§3.1). ' +
      'Dropping `speed` leaves every effect on a sped-up clip pointing at the wrong ' +
      'content, and preview and export at the wrong source frame.',
    file: 'packages/edl/src/clips.ts',
    find: '  return sourceStart + (timelineTime - start) * speed;',
    replace: '  return sourceStart + (timelineTime - start);',
    mustFail: [EDL_RESOLVE],
  },
  {
    name: 'ease-read-from-the-incoming-keyframe',
    breaks:
      "§3.4's *'the ease on the outgoing keyframe governs the segment'*. Reading " +
      'the next key instead applies every ease one segment late — a timeline that ' +
      'still animates, and animates wrongly everywhere.',
    file: 'packages/edl/src/channel.ts',
    find: '    const ease = this.#eases[i];',
    replace: '    const ease = this.#eases[i + 1];',
    mustFail: [EDL_CHANNEL, EDL_RESOLVE],
  },
  {
    name: 'undo-restores-a-track-on-top-of-the-stack',
    breaks:
      'track order surviving an undo. §3.5 resolves tracks in array order, so an ' +
      'inverse that appends instead of re-inserting silently changes which zoom ' +
      'wins — the "my other zoom took over after undo" bug, which leaves a valid ' +
      'document and a wrong picture.',
    file: 'packages/edl/src/inverse.ts',
    find: "      return { op: 'track.add', track: structuredClone(track), at: doc.tracks.indexOf(track) };",
    replace: "      return { op: 'track.add', track: structuredClone(track) };",
    mustFail: [EDL_HISTORY],
  },
  {
    name: 'undo-of-an-added-key-does-not-remove-it',
    breaks:
      'a removal reaching the document at all. `patch.remove` is the one form of ' +
      '"take this key off" that survives `JSON.stringify`, so it is the whole of ' +
      'what makes an undo crash-safe: with it ignored, undoing "add a generator ' +
      'block" leaves the block in place and the editor shows a document its own ' +
      'file does not describe.',
    file: 'packages/format/src/journal/apply.ts',
    find: '      removeTrackKeys(fields, remove, op);',
    replace: '      removeTrackKeys(fields, undefined, op);',
    mustFail: [FORMAT_JOURNAL, EDL_HISTORY],
  },
  // ---------------------------------------------------------------- phase 8
  {
    name: 'export-encodes-through-a-lost-context',
    breaks:
      'the export refuses when the GL context dies. A lost context is SILENT — every ' +
      'call is a no-op and the canvas keeps its last contents — so without this the ' +
      'loop keeps compositing, `new VideoFrame(canvas)` keeps handing the encoder ' +
      'stale pixels, and the export finishes on a file of black frames that passes ' +
      'every one of §7.5\u2019s five checks and is recorded verified-good. Phase 9 then ' +
      'deletes the user\u2019s only copy of the raw sources on the strength of it. The ' +
      'gate\u2019s relaunch predicate does not cover this: it protects the gate\u2019s ' +
      'measurement, and a real user has no second attempt.',
    file: 'apps/renderer/src/export/render-loop.ts',
    find: '    if (this.#contextLostAt === null && !this.#compositor.contextLost) return;',
    replace: '    if (true as boolean) return;',
    mustFail: [EXPORT_LOOP],
  },
  {
    name: 'export-composites-a-stale-frame',
    breaks:
      'the exporter checks that the frame it was handed is the one the index puts ' +
      'at that instant. `FrameRing.frameAtMicros` is hold-last *within the ring*, so ' +
      'a reader whose decode has not caught up returns an older frame rather than ' +
      'null — right for preview (§4.3 holds the previous picture) and a wrong frame ' +
      'written into a file for an export. Without the check the export is stuck on ' +
      'whatever the ring happened to hold, and the file plays, is the right length, ' +
      'and shows the wrong picture.',
    file: 'apps/renderer/src/export/render-loop.ts',
    find: '    const expected = this.#screen.selectionMicros?.(sourceTime);',
    replace: '    const expected = undefined as number | undefined;',
    mustFail: [EXPORT_LOOP],
  },
  {
    name: 'a-stalled-encoder-is-waited-on-forever',
    breaks:
      '§5.3’s backpressure wait is bounded. It waits on the encoder’s *output* ' +
      'callback, which is right and is only safe while something is guaranteed to ' +
      'call it: a platform encoder whose backend goes away — the GPU process dying ' +
      'takes VideoToolbox, the queue and the error callback’s pipe together — calls ' +
      'neither `output` nor `error`. Unbounded, that is §10.2’s named symptom, an ' +
      'export that hangs with no error, and it cost the phase-8 gate a 480-second ' +
      'CI timeout with nothing to read.',
    file: 'apps/renderer/src/export/encode.ts',
    find: '  return new Promise((done, fail) => {\n    const waiter = (): void => {',
    replace:
      '  return new Promise<void>((done) => {\n    waiters.push(done);\n  });\n' +
      '  return new Promise((done, fail) => {\n    const waiter = (): void => {',
    mustFail: [EXPORT_ENCODE],
  },
  {
    name: 'export-writer-registered-after-it-opens',
    breaks:
      'an export chunk that arrives while the output file is still being created ' +
      'queues behind the open instead of being refused. The encoder announces its ' +
      'decoderConfig and emits its first chunk in the same callback, so meta and the ' +
      'first chunk are one IPC message apart and opening the file is two awaits ' +
      'long. Registering the open late loses the first chunk — which is the video’s ' +
      'keyframe, so the file cannot be decoded from the front.',
    file: 'apps/main/src/project-store.ts',
    find: '    this.openExports.set(jobId, entry);',
    replace: '    void opening.then(() => this.openExports.set(jobId, entry));',
    mustFail: [PHASE8],
  },
  {
    name: 'two-exports-share-one-destination',
    breaks:
      'one live export per output path. Two jobs aimed at one destination share all ' +
      'three scratch paths: the second’s `create` sweeps the first’s scratch away, ' +
      'either one’s cancel unlinks the other’s `.partial` mid-assembly, and both ' +
      'rename over the same output — so a *verified* export is silently replaced by ' +
      'an unverified one, which is what phase 9 deletes sources on the strength of. ' +
      '`wx+` used to refuse this; the scratch sweep deletes the files it refused on, ' +
      'so the check has to be real.',
    file: 'apps/main/src/project-store.ts',
    find: '    if (holder !== null) throw new ExportDestinationBusyError(request.outputPath, holder);',
    replace: '    void holder;',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'destination-released-before-the-mux',
    breaks:
      'the destination claim spanning the work it protects. `finalize` creates ' +
      '`<out>.partial`, copies the whole mdat into it, fsyncs, renames it over ' +
      '`<out>` and unlinks both scratch streams — tens of seconds on a 4K export. ' +
      'Released a step early, a second job is admitted for all of it, and its sweep ' +
      'removes the `.partial` the first is about to rename: a complete, correct ' +
      'export reported as failed at its last step.',
    file: 'apps/main/src/project-store.ts',
    find: '      return await writer.finalize();',
    replace: '      this.openExports.delete(jobId);\n      return await writer.finalize();',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'destination-released-before-the-cancel',
    breaks:
      'the same claim spanning the other release site. `cancel()` is what unlinks ' +
      'the scratch streams and the `.partial`, so a job admitted before it finishes ' +
      'has its own freshly created scratch removed by the cleanup of the job it ' +
      'replaced.',
    file: 'apps/main/src/project-store.ts',
    find: '      const writer = await open.writer.catch(() => null);',
    replace:
      '      this.openExports.delete(jobId);\n' +
      '      const writer = await open.writer.catch(() => null);',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'export-duration-checked-against-the-writer',
    breaks:
      '§7.5’s fourth check being answered against the *edit*. `FastStartWriter.plan()`’s ' +
      'tally is the number `mvhd.duration` was written from, so handing it back as the ' +
      'expectation makes the check compare the writer with itself: it can then only fail ' +
      'on header bytes the parse above it has already rejected, and an export that is ' +
      'not as long as the timeline asked for — a truncated encode, a clip list the ' +
      'exporter ignored — passes all five checks and is recorded verified-good. Phase 9 ' +
      'deletes the user’s only copy of the sources on the strength of that record.',
    file: 'apps/main/src/export/session.ts',
    find:
      '      const outcome = await verifyExport(job.outputPath, job.expectedDurationSec, ' +
      'this.#io(job));',
    replace:
      '      const outcome = await verifyExport(job.outputPath, finished.durationSec, ' +
      'this.#io(job));',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'export-destination-comes-from-the-renderer',
    breaks:
      'main owning where an export goes. `ExportSession.start` composes ' +
      '`<exportRoot>/<name>.mp4`, `beginExport` mkdir -p’s that directory, `finalize` ' +
      'renames over the output and a failed verification removes it — so a renderer that ' +
      'could name the directory could make main create directories anywhere on the ' +
      'volume and replace or delete any .mp4 on it. §0 rule 1 read backwards: a ' +
      'sandboxed renderer has no filesystem precisely so that it cannot.',
    file: 'apps/main/src/export/session.ts',
    find: "    if ('outputDir' in overrides) {",
    replace: '    if (false as boolean) {',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'a-job-that-never-renamed-can-discard',
    breaks:
      'the gate on the one `rm` that points outside a bundle, at a directory the user ' +
      'chose. The ledger `discardExport` reads is written only when the writer says the ' +
      'rename actually happened; record it unconditionally and a job whose finalize ' +
      'threw *before* the rename claims the path anyway — and deletes the user’s ' +
      'earlier, good export sitting there under the same name.',
    file: 'apps/main/src/project-store.ts',
    find: '      if (writer.renamed) this.renamedExports.set(jobId, writer.outputPath);',
    replace: '      this.renamedExports.set(jobId, writer.outputPath);',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'export-holds-the-bundle-lock-for-ever',
    breaks:
      'an export handing back the bundle lock and the JournalWriter it took. Held to ' +
      '`before-quit`, one export keeps the `.lock` for the rest of the session and the ' +
      'next launch sweeps a lock that was never stale — and `releaseProject` is what ' +
      'makes that safe to give back while an editor may hold the same project.',
    file: 'apps/main/src/project-store.ts',
    find: '    const held = this.holds.get(id);\n    if (held === undefined) return;',
    replace: '    const held = this.holds.get(id);\n    if (held !== undefined) return;',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'a-dead-export-window-hangs-the-job',
    breaks:
      'the bound on the one wait that had none. A renderer killed for memory sends no ' +
      'chunk, no passDone and no exportFailed, so the job waits for ever: it stays in ' +
      '`#jobs`, the writer and its two `wx+` scratch streams stay open, the destination ' +
      'is never released and progress freezes — §10.2’s "an export that hangs at 40% ' +
      'with no error", verbatim.',
    file: 'apps/main/src/export/session.ts',
    find: '    this.#watchWindow(job, window);',
    replace: '    void window;',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'an-early-export-failure-leaves-no-record',
    breaks:
      'the promise that "no record" and "a record saying it failed" are different ' +
      'things to wake up to. Only a *verification* failure used to be recorded, so an ' +
      'encoder this machine cannot configure, a lost GL context, a stalled decode or an ' +
      'append that threw left nothing at all in project.json — and with retention ' +
      'coming, that is exactly the case where the user needs to be told something ' +
      'happened.',
    file: 'apps/main/src/export/session.ts',
    find: '        await this.#record(job, { error: message }).catch((recordError: unknown) => {',
    replace: '        await Promise.resolve().catch((recordError: unknown) => {',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'finalize-claims-a-rename-it-did-not-make',
    breaks:
      '`ExportMp4Writer.renamed` reporting the rename rather than the return. finalize ' +
      'renames and *then* opens and fsyncs the parent directory inside the same try, so ' +
      'inferring "the file is in place" from finalize having returned leaves an ' +
      'unverified export under the finished name whenever that fsync fails — the one ' +
      'artifact §7.5’s rename-then-verify order exists to be able to remove.',
    file: 'packages/mux/src/fs/export-writer.ts',
    find: '      this.#renamed = true;',
    replace: '      this.#renamed = false;',
    mustFail: [EXPORT_MOVIE, EXPORT_SESSION],
  },
  {
    name: 'mvhd-counts-the-aac-priming',
    breaks:
      '`mvhd.duration` being what the file PRESENTS. AAC carries 2112 samples of ' +
      'priming and the audio `elst` is what tells every player to skip exactly them, ' +
      'so a `mvhd` written from the raw sample tally disagrees with its own audio ' +
      '`tkhd` by 44 ms and describes a movie longer than anything plays. §7.5’s ' +
      'fourth check compares that number against the *timeline* inside a 100 ms ' +
      'budget, so the over-count spends nearly half of it on sound nobody hears — and ' +
      'a job that fails verification has its finished file discarded, which makes ' +
      'this a correct export deleted rather than a cosmetic header.',
    file: 'packages/mux/src/faststart.ts',
    find: '    return Math.max(video, this.#audioPresentedSec());',
    replace:
      '    return Math.max(video, this.#audio.durationUnits / (this.#options.audio?.sampleRate ?? 1));',
    mustFail: [EXPORT_MOVIE, EXPORT_SESSION],
  },
  {
    name: 'export-chunk-offsets-off-by-one',
    breaks:
      'every chunk offset in the exported moov points at the sample data. Off by a ' +
      'byte, the file demuxes, reports the right duration, passes four of §7.5’s ' +
      'five checks and decodes into garbage — which is exactly the damage phase 9 ' +
      'must never delete the user’s sources on the strength of.',
    file: 'packages/mux/src/faststart.ts',
    find: '      offsets[i] = cursor;',
    replace: '      offsets[i] = cursor + 1;',
    mustFail: [EXPORT_MOVIE],
  },
  {
    name: 'cancelled-export-leaves-its-partial',
    breaks:
      'a cancelled export leaves nothing behind. §7.5 obligation 1 read the other ' +
      'way round: a truncated export is a shorter video that looks finished, and it ' +
      'must not be there to be mistaken for one.',
    file: 'packages/mux/src/fs/export-writer.ts',
    find: `    await this.#removeScratch();
    await unlink(this.#partialPath).catch(() => undefined);`,
    replace: '    await Promise.resolve();',
    mustFail: [EXPORT_MOVIE],
  },
  {
    name: 'verification-assumes-the-last-frame-decodes',
    breaks:
      '§7.5’s fifth check — *"last frame actually decodes"*. Assuming it turns the ' +
      'verification into four checks that a truncated or mis-offset file passes, and ' +
      'phase 9 deletes the only copy of the sources on the strength of the answer.',
    file: 'apps/main/src/export/verify.ts',
    find: `  if (!outcome.ok) {`,
    replace: `  if (false as boolean) {`,
    mustFail: [EXPORT_VERIFY],
  },
  {
    name: 'early-export-chunks-refused-instead-of-held',
    breaks:
      'main holding the chunks that arrive before the writer can be opened. WebCodecs ' +
      'hands the decoderConfig over WITH the first output chunk, so a chunk always ' +
      'arrives before the writer exists — and on the recompose path §5.7 runs the ' +
      'whole audio pass before the video encoder says a word. Refusing them fails ' +
      'every export of a recording with audio before a single sample reaches disk.',
    file: 'apps/main/src/export/session.ts',
    find: '      held.push(message);',
    replace: '      void message;',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'held-export-chunks-flushed-out-of-order',
    breaks:
      'the held chunks reaching the writer in arrival order. Reversing them puts the ' +
      "video's keyframe after the frames that reference it and the audio backwards, " +
      'and `addVideoSample` is what has to notice — a sample table that cannot express ' +
      'the order it was given is a file that plays and shows the wrong thing.',
    file: 'apps/main/src/export/session.ts',
    find: '    for (const message of held) this.#appendChunk(job, message);',
    replace: '    for (const message of held.reverse()) this.#appendChunk(job, message);',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'mid-gop-cut-reported-as-instant',
    breaks:
      "§5.3's second condition — cut points snapped to keyframes — in the predicate " +
      'the export routes on. Without it a mid-GOP trim is reported eligible, the job ' +
      'commits to a copy with no video pass requested, and the plan then refuses it: ' +
      'a failed export where recompose would have produced the file asked for.',
    file: 'apps/main/src/export/stream-copy.ts',
    find: '    reasons.push(...cutPointReasons(input.edit.clips, input.index));',
    replace: '    reasons.push();',
    mustFail: [EXPORT_COPY, EXPORT_SESSION],
  },
  {
    name: 'stale-export-scratch-blocks-the-next-export',
    breaks:
      'the sweep of this output’s own scratch before the writer opens. The scratch ' +
      'streams open `wx+`, so one SIGKILL mid-export means that recording can never ' +
      'be exported under that name again — an opaque EEXIST pointing at files the ' +
      'user has no reason to know exist.',
    file: 'packages/mux/src/fs/export-writer.ts',
    find: '    await sweepExportScratch(options.outputPath);',
    replace: '    await Promise.resolve();',
    mustFail: [EXPORT_MOVIE],
  },
  {
    name: 'only-the-first-part-of-a-straddling-block-is-mixed',
    breaks:
      'every part an output block overlaps being mixed. A block is ~21 ms and a §7.4 ' +
      'reacquire puts a part boundary wherever it falls, so mixing only the first ' +
      'emits the far side of every seam as silence — §5.4 mechanism 5’s class of ' +
      'error: small, silent, and permanent once it is in the file.',
    file: 'apps/renderer/src/export/audio-source.ts',
    find: '    for (const part of this.#partsCovering(startSec, endSec)) {',
    replace: '    for (const part of this.#partsCovering(startSec, endSec).slice(0, 1)) {',
    mustFail: [EXPORT_AUDIO],
  },
  // ---- phase 10: the generators ------------------------------------------
  {
    name: 'dead-zone-removed',
    breaks:
      '§6.2, the anti-seasickness mechanism itself. A rest box of zero is the "pure ' +
      'spring-to-cursor" §6.2 opens by rejecting: the frame is no longer still by ' +
      'default, and every hover becomes a camera move.',
    file: 'packages/edl/src/generators/dead-zone.ts',
    find: 'export const DEFAULT_REST_BOX: readonly [number, number] = [0.35, 0.45];',
    replace: 'export const DEFAULT_REST_BOX: readonly [number, number] = [0, 0];',
    mustFail: [PHASE10, EDL_DEAD_ZONE],
  },
  {
    name: 'rest-box-measured-against-the-frame',
    breaks:
      'the rest box being a fraction of the *visible zoomed viewport*. Measured ' +
      'against the whole frame it is twice as large at 2x and four times at 4x, so ' +
      'the camera stops following at exactly the magnification where following is ' +
      'the point.',
    file: 'packages/edl/src/generators/dead-zone.ts',
    find: '    const halfBoxX = boxW * half;',
    replace: '    const halfBoxX = boxW * 0.5;',
    mustFail: [EDL_DEAD_ZONE],
  },
  {
    name: 'frame-safe-clamp-removed',
    breaks:
      'the zoomed viewport staying inside the frame. Without the clamp a cursor in ' +
      'a corner frames background, and §6.6 is then measured on a centre the ' +
      'compositor would clamp away — a budget about a picture nobody sees.',
    file: 'packages/edl/src/generators/dead-zone.ts',
    find: '  return value < lo ? lo : value > hi ? hi : value;',
    replace: '  return value;',
    mustFail: [EDL_DEAD_ZONE],
  },
  {
    name: 'phase-lead-not-applied',
    breaks:
      '§6.4. The spring trails a moving target by friction/tension seconds — 0.200 s ' +
      "at §6.3's parameters, measured at 0.196 s — and reading the target that far " +
      'ahead is what cancels it. Without the lead the frame visibly lags the pointer.',
    file: 'packages/edl/src/generators/cursor-follow.ts',
    find: '  return Math.max(0, friction / tension);',
    replace: '  return 0;',
    mustFail: [EDL_DEAD_ZONE],
  },
  {
    name: 'seasickness-budget-always-passes',
    breaks:
      '§6.6 being a check at all. A verdict that is always `pass` means the retry ' +
      'ladder never runs and the phase-10 control — a camera glued to the cursor — is ' +
      'reported as comfortable.',
    file: 'packages/edl/src/generators/budget.ts',
    find: '    pass: failures.length === 0,',
    replace: '    pass: true,',
    mustFail: [PHASE10],
  },
  {
    name: 'pan-speed-never-measured',
    breaks:
      "§6.6's first assertion. A speed that is always zero cannot exceed anything, so " +
      'the budget stops seeing the one failure mode the dead zone and the spring exist ' +
      'to prevent.',
    file: 'packages/edl/src/generators/budget.ts',
    find: '    const speed = step / dt;',
    replace: '    const speed = 0;',
    mustFail: [PHASE10, EDL_BUDGET],
  },
  {
    name: 'budget-measured-on-the-raw-centre',
    breaks:
      'the budget being taken on what the viewer sees. `sourceSampleRect` clamps ' +
      'the sampled rect into the frame, so a raw centre at amount 1 reports a pan ' +
      'that does not exist — and a `center`-only track measured alone would report ' +
      'a whole camera that is not there.',
    file: 'packages/edl/src/generators/budget.ts',
    find: '  return centre < lo ? lo : centre > hi ? hi : centre;',
    replace: '  return centre;',
    mustFail: [EDL_BUDGET],
  },
  {
    name: 'shake-filter-passes-everything',
    breaks:
      "§6.1's shake filter. A direction reversal with two small legs inside 100 ms " +
      'is a hand resting on a mouse, and keeping it puts that tremor into the ' +
      'follow target.',
    file: 'packages/edl/src/generators/conditioning.ts',
    find: '    const reversal = ax * bx + ay * by < 0;',
    replace: '    const reversal = false;',
    mustFail: [EDL_CONDITIONING],
  },
  {
    name: 'nan-samples-reach-the-keyframes',
    breaks:
      'the §6.1 sanity pass. A non-finite sample propagates into a spring table, ' +
      'then into a keyframe, then into `edit.json`, where `validateEditDocument` ' +
      'refuses it — a recording that stops opening because of one bad log line.',
    file: 'packages/edl/src/generators/conditioning.ts',
    find: '    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) {',
    replace: '    if (false) {',
    mustFail: [PHASE10, EDL_CONDITIONING],
  },
  {
    name: 'auto-zoom-reads-a-dead-tap-as-no-clicks',
    breaks:
      'the one thing phase 5 exists to make impossible. Generating an empty track ' +
      'instead of refusing turns "Accessibility was never granted" into "nobody ' +
      'clicked", which is silent on every fresh install and unexplainable to a user.',
    file: 'packages/edl/src/generators/auto-zoom.ts',
    find: "  if (input.clicks.kind === 'unavailable') {",
    replace: "  if (false && input.clicks.kind === 'unavailable') {",
    mustFail: [EDL_AUTO_ZOOM],
  },
  {
    name: 'auto-zoom-clusters-across-any-pause',
    breaks:
      '§6.5 step 1’s time criterion. Clustering on the bounding box alone lets one ' +
      'cluster span a whole recording — measured on the ten real logs as eight ' +
      'single segments of 20.6–24.9 s in 25 s — so `mergeGapSec` and the handover ' +
      'to the cursor-follow track underneath become inert and auto-zoom-on-click is ' +
      'one zoom-in-and-hold for the video.',
    file: 'packages/edl/src/generators/auto-zoom.ts',
    find: '      click.t - previousT < params.clusterGapSec &&',
    replace: '      true &&',
    mustFail: [EDL_AUTO_ZOOM, PHASE10],
  },
  {
    name: 'auto-zoom-accepts-clicks-stamped-with-machine-uptime',
    breaks:
      'the click log’s sanity ceiling. `clicks.ndjson` shares the sampler’s `t0Us` ' +
      'with `cursor.ndjson`, so a log whose origin was never subtracted carries ' +
      'machine uptime; kept, those keyframes compile a spring table past ' +
      'MAX_SPRING_TABLE_SEC and the generator throws out of its own budget check ' +
      'instead of answering.',
    file: 'packages/edl/src/generators/auto-zoom.ts',
    find: '    if (t > maxSourceTimeSec) {',
    replace: '    if (false) {',
    mustFail: [EDL_AUTO_ZOOM, PHASE10],
  },
  {
    name: 'seasickness-budget-passes-a-camera-it-cannot-measure',
    breaks:
      'the §6.6 check failing closed. A non-finite centre falls through both ' +
      'comparisons, every inequality against the NaN is false, `failures` stays ' +
      'empty and the budget reports `pass` on a camera it never measured — and it ' +
      'stops agreeing with `sourceSampleRect`, which answers the low bound.',
    file: 'packages/edl/src/generators/budget.ts',
    find: '  if (!Number.isFinite(centre)) return lo;',
    replace: '  if (false) return lo;',
    mustFail: [EDL_BUDGET],
  },
  {
    name: 'auto-zoom-edge-snap-removed',
    breaks:
      '§6.5 step 3. A click near a corner then frames background, which is exactly ' +
      'the sentence the step is written to prevent.',
    file: 'packages/edl/src/generators/auto-zoom.ts',
    find: '  if (value <= lo + snapWithin) return lo;',
    replace: '  if (false) return lo;',
    mustFail: [EDL_AUTO_ZOOM],
  },
  {
    name: 'regeneration-appends-instead-of-replacing-in-place',
    breaks:
      'track order surviving a regeneration. §3.5 stacks in array order, so a ' +
      "regenerated cursor-follow track that lands on top of the user's manual zoom " +
      'silently takes over from it — a valid document and a wrong picture.',
    file: 'packages/edl/src/generators/lifecycle.ts',
    find: "    { op: 'track.add', track: replacement, at: options.at ?? existing },",
    replace: "    { op: 'track.add', track: replacement },",
    mustFail: [EDL_STACKING],
  },
  {
    name: 'bake-leaves-the-generator-attached',
    breaks:
      "§3.5's bake being the escape hatch. A track that keeps its `generator` block " +
      'is still offered a regeneration, and the next one overwrites the edits the ' +
      'bake was performed to protect.',
    file: 'packages/edl/src/generators/lifecycle.ts',
    find: "      patch: { origin: 'manual', generatedFrom: spec, remove: ['generator'] },",
    replace: "      patch: { origin: 'manual', generatedFrom: spec },",
    mustFail: [EDL_STACKING],
  },

  // ---- phase 11: annotations, and the golden-frame gate over them -----------
  //
  // The acceptance criterion is *"ship a control proving the extension would catch a
  // divergence — perturb an annotation's rendering and show the test goes red"*.
  // These are that control, at the same discipline as every mutation above: the
  // production source on disk is broken and `test/phase11-golden.test.ts` has to
  // notice. Three of the six below are privacy defects — a redaction that lands in
  // the wrong place, one that renders as the identity, and one that takes a default
  // region instead of refusing — which is why they are here and not only in a unit
  // test: the failure they model publishes something.
  {
    name: 'annotations-ignore-the-zoom-they-are-anchored-in',
    breaks:
      'a source-anchored annotation lands on the pixels the screen pass drew that ' +
      'part of the source onto. Dropping the pan term leaves the redaction where it ' +
      'was before the zoom while the content slides out from under it — the blur is ' +
      'still visibly present, a few centimetres from the thing it was hiding.',
    file: 'packages/compositor/src/geometry.ts',
    find: '    originX: content.x - source.x * scaleX,',
    replace: '    originX: content.x,',
    mustFail: [PHASE11, COMPOSITOR_GEOMETRY],
  },
  {
    name: 'the-blur-pass-is-a-single-tap',
    breaks:
      'the blur is a real Gaussian. A single centre tap is the identity, so the ' +
      'region composites back exactly what was under it: a redaction that renders as ' +
      'nothing, on a frame that looks finished.',
    file: 'packages/compositor/src/annotation-shaders.ts',
    find: '    if (i > u_taps) break;',
    replace: '    if (i > 0) break;',
    mustFail: [PHASE11],
  },
  {
    name: 'an-annotation-track-ignores-its-own-window',
    breaks:
      "§3.5's window reaching the annotation it gates. This is the mute-span bug one " +
      'target along: a parked track — enabled, with an empty or elapsed `activeRanges` ' +
      '— goes on drawing over every frame at full strength, and the crossfade at a ' +
      'range edge becomes a cut. The `continue` above it is a second, redundant guard, ' +
      'so breaking that instead changes no pixel and would be an equivalent mutant.',
    file: 'packages/edl/src/resolve.ts',
    find: '      span.resolved.weight = w;',
    replace: '      span.resolved.weight = 1;',
    mustFail: [PHASE11, EDL_ANNOTATIONS],
  },
  {
    name: 'the-window-crossfade-never-reaches-the-annotation',
    breaks:
      "the other end of §3.5's window: the track's weight is what carries `blendMs` " +
      'into an annotation, and without the multiplication a crossfade at a range edge ' +
      'becomes a cut. Invisible to a check that only asks whether an annotation drew, ' +
      'which is why the gate reads the weight back out of an opaque white span.',
    file: 'packages/edl/src/annotations.ts',
    find: '  out.opacity = Math.max(0, Math.min(1, opacity)) * annotation.weight;',
    replace: '  out.opacity = Math.max(0, Math.min(1, opacity));',
    mustFail: [PHASE11, EDL_ANNOTATIONS],
  },
  {
    name: 'annotation-colour-is-linearised-on-one-side',
    breaks:
      "annotation colour being read in the target's own encoding. The whole pipeline " +
      'is display-encoded — the screen pass uploads with no colour conversion into a ' +
      'non-sRGB RGBA8 target — so linearising here puts every annotation a gamma curve ' +
      'away from the picture it sits on, and puts a mask a gamma curve away from the ' +
      'colour the document asked for.',
    file: 'packages/edl/src/annotations.ts',
    find: '    return value / 255;',
    replace: '    return (value / 255) ** 2.2;',
    mustFail: [PHASE11, EDL_ANNOTATIONS],
  },
  {
    name: 'a-blur-with-an-unknown-region-draws-nothing',
    breaks:
      'failing closed. With the check gone, a blur whose `center` channel is missing ' +
      'takes the default region instead of refusing the frame — so the compositor ' +
      'redacts the middle of the picture, leaves the thing the user hid in plain ' +
      'sight, and reports success.',
    file: 'packages/edl/src/annotations.ts',
    find: '    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {',
    replace: '    if (false) {',
    mustFail: [PHASE11, EDL_ANNOTATIONS],
  },

  // ---- phase 12: the live drawing overlay ----------------------------------

  {
    name: 'the-overlay-swallows-every-click',
    breaks:
      'the constraint that a full-screen always-on-top window must not take clicks ' +
      'meant for the app underneath. With the ignoring branch gone the overlay eats ' +
      "the user's input for the whole recording — on the display they are recording.",
    file: 'apps/main/src/overlay.ts',
    find: '    else window.setIgnoreMouseEvents(true, { forward: true });',
    replace: '    else window.setIgnoreMouseEvents(false);',
    mustFail: [OVERLAY],
  },
  {
    name: 'the-overlay-steals-focus',
    breaks:
      '*"must not steal focus from what the user is recording"*. `show()` activates ' +
      'the app on macOS; `showInactive()` does not, and the difference is the window ' +
      'the presenter was demonstrating losing key in the middle of their recording.',
    file: 'apps/main/src/overlay.ts',
    find: '      window.showInactive();',
    replace: '      window.show();\n      window.focus();',
    mustFail: [OVERLAY],
  },
  {
    name: 'a-failed-stroke-write-takes-the-recording-down',
    breaks:
      '*"a drawing overlay must never break the recording"*. Rethrowing instead of ' +
      'recording the failure sends a full disk, or any other write error, straight ' +
      'into `RecorderSession.finalize` — losing the footage to save the ink, which ' +
      "is the exact inversion of this phase's priority.",
    file: 'apps/main/src/overlay.ts',
    find: "    console.error('[overlay]', this.#error);",
    replace: "    console.error('[overlay]', this.#error);\n    throw error;",
    mustFail: [OVERLAY],
  },
  {
    name: 'a-strokes-time-is-taken-when-it-arrives',
    breaks:
      'the one arithmetic claim on this path: a stroke happened *before* the message ' +
      'about it, and the two processes share no time origin, so main subtracts the ' +
      'age the renderer reported. Ignoring it puts every stroke at the moment its ' +
      'IPC landed — a whole gesture late, and every stroke of a recording drifting ' +
      'by however long the pen was down.',
    file: 'apps/main/src/overlay.ts',
    find: '    return Math.max(0, now - msAgo / 1000);',
    replace: '    return Math.max(0, now);',
    mustFail: [OVERLAY],
  },
  {
    name: 'a-rubbed-out-stroke-stays-for-the-whole-recording',
    breaks:
      'the reading that makes an `erase` mean anything. A stroke ends when it was ' +
      'rubbed out, not when the recording did — with this, ink the presenter cleared ' +
      'at 0:40 is composited over the rest of the video.',
    file: 'packages/edl/src/drawing.ts',
    find: "    if (event.e === 'erase' && event.ids.includes(stroke.id)) return event.t;",
    replace: '    if (false) return event.t;',
    mustFail: [EDL_DRAWING],
  },
  {
    name: 'the-drawing-track-is-not-generated',
    breaks:
      "§3.5's whole arrangement. A `manual` drawing track is one a re-import would " +
      'overwrite the user\'s own edits in — the separation that makes *"user edits ' +
      'survive by construction"* true is that generated and hand-authored tracks ' +
      'never share storage.',
    file: 'packages/edl/src/drawing.ts',
    find: "    origin: 'generated',",
    replace: "    origin: 'manual',",
    mustFail: [EDL_DRAWING],
  },
  {
    name: 'a-stroke-appears-before-it-was-drawn',
    breaks:
      'the reveal. Without the `progress` keys a stroke is composited whole at the ' +
      'instant the pen went down — so the finished arrow is on screen a second ' +
      'before the presenter draws it. Invisible to any check that only asks whether ' +
      'the ink is there, which is why the golden gate reads the growth back out of ' +
      'the pixels.',
    file: 'packages/edl/src/drawing.ts',
    find: "  if (!(stroke.t1 > stroke.t)) return [{ t: stroke.t, v: 1, ease: { kind: 'hold' } }];",
    replace: "  return [{ t: stroke.t, v: 1, ease: { kind: 'hold' } }];",
    mustFail: [EDL_DRAWING],
  },
  {
    name: 'a-revealing-stroke-is-truncated-by-point-index',
    breaks:
      'the reveal being by **arc length**. Truncating by point index instead makes a ' +
      'slow dense stretch of a stroke reveal at a different speed from a fast sparse ' +
      'one, which is what a simplified polyline is made of. The golden gate is what ' +
      'sees it: the growth stops being monotonic in the drawn length.',
    file: 'packages/compositor/src/annotations.ts',
    find: '      const fraction = to > from ? Math.min(1, (drawn - from) / (to - from)) : 1;',
    replace: '      const fraction = 1;',
    mustFail: [PHASE11],
  },
  {
    name: 'stroke-coverage-double-blends-at-every-joint',
    breaks:
      'the reason the coverage goes through a scratch at all. Consecutive capsules ' +
      'overlap by construction — that is what rounds a joint — so accumulating them ' +
      'with an ordinary additive blend instead of `MAX` composites the ink over ' +
      "itself at every joint. At full opacity nothing shows; at a highlighter's 0.35, " +
      'or anywhere in a crossfade, the line grows a string of dark beads.',
    file: 'packages/compositor/src/annotations.ts',
    find: '    gl.blendEquation(gl.MAX);',
    replace: '    gl.blendEquation(gl.FUNC_ADD);',
    mustFail: [COMPOSITOR_STROKE],
  },
  {
    name: 'the-scratch-scissor-is-not-flipped',
    breaks:
      "the one flip between GL's bottom-left scissor box and `pxRect`'s top-left " +
      'origin. Get it wrong and the scissor lands on a band of the scratch the ' +
      'stroke is not in, so the coverage draw is clipped away entirely — the ink ' +
      'vanishes for every stroke that is not exactly halfway down the frame.',
    file: 'packages/compositor/src/annotations.ts',
    find: '    const sy = Math.max(0, Math.floor(height - (pxRect.y + pxRect.height)));',
    replace: '    const sy = Math.max(0, Math.floor(pxRect.y));',
    mustFail: [PHASE11],
  },

  // ---- the event logs: a recording that samples the pointer ---------------
  {
    name: 'no-recording-samples-the-pointer',
    breaks:
      'the whole of it. The sampler existed, was tested, and had no caller in the ' +
      'product for ten phases: every recording wrote `events: {}` while first-run ' +
      'setup asked for the Accessibility grant on the promise of that log. Removing ' +
      'the one call puts it straight back.',
    file: 'apps/main/src/recorder/session.ts',
    find: '        this.beginSampling(active, active.originAtUs ?? monotonicUs());',
    replace: '        void active.originAtUs;',
    mustFail: [EVENTS],
  },
  {
    name: 'sampler-stopped-after-the-bundle-is-closed',
    breaks:
      "the ordering rule. `ProjectStore`'s event-log writes require the project to " +
      'be open and refuse it otherwise, on purpose — so closing first turns the ' +
      "sampler's final flush and `fsync` into typed refusals nobody reads, and " +
      'costs the tail of the cursor log.',
    file: 'apps/main/src/recorder/session.ts',
    find: '    await this.stopSampling(active);',
    replace:
      '    await this.options.store.close(active.id).catch(() => undefined);\n' +
      '    await this.stopSampling(active);',
    mustFail: [EVENTS],
  },
  {
    name: 'clicks-not-asked-for-when-accessibility-is-missing',
    breaks:
      'the distinction the sampler exists to keep. The app asks for clicks on every ' +
      "recording; whether it gets them is macOS's answer. Conditioning the request " +
      'on `AXIsProcessTrusted()` writes `not-requested` — "this caller opted out" — ' +
      'over a grant the user actually declined, and loses the reason a surface ' +
      'would have to show them.',
    file: 'apps/main/src/recorder/session.ts',
    find: '      clicks: true,',
    replace: '      clicks: readAxTrusted(),',
    mustFail: [EVENTS],
  },
  {
    name: 'cursor-log-stamped-with-the-helpers-raw-clock',
    breaks:
      "§2.5's *`t` shares its origin with `VideoFrame.timestamp`*. With the origin " +
      "unsubtracted, every `t` carries the machine's uptime — 2,678,930 s was " +
      "measured here — and `@loom/edl`'s sanity pass drops the lot. The symptom is " +
      'not a wrong log; it is generators that silently produce nothing.',
    file: 'apps/main/src/recorder/session.ts',
    find: '      t0Us: Math.round(clock.tUs + (originAtUs - clock.atUs)),',
    replace: '      t0Us: 0,',
    mustFail: [EVENTS],
  },

  // ---- phase 9: retention ---------------------------------------------------
  // The captain's decision deletes the user's only copy of their raw footage, so
  // every one of these is a mutation that would lose somebody's recording. The
  // first is the one the phase's gate exists for: deletion made unconditional.
  {
    name: 'retention-deletes-whatever-the-export-said',
    breaks:
      '§7.5 obligation 1 — *"deletion happens only after a verified-good export"*. ' +
      'With the predicate always true, every export deletes the sources: a missing ' +
      'file, an empty one, a file that does not demux, a truncated encode, a last ' +
      'frame that will not decode. The recording is gone and the thing it was ' +
      'exchanged for does not play.',
    file: 'packages/format/src/retention.ts',
    find: '  return { mayDelete: reasons.length === 0, reasons };',
    replace: '  return { mayDelete: true, reasons };',
    mustFail: [PHASE9, FORMAT_RETENTION],
  },
  {
    name: 'retention-ignores-a-recorded-failure',
    breaks:
      'the first thing `mayDeleteSources` reads: an export that recorded an error is ' +
      'an export that failed, whatever else its partial `verified` block happens to ' +
      'say. §7.5 requires the partial record precisely so a failure is legible, and ' +
      'this is the read that acts on it.',
    file: 'packages/format/src/retention.ts',
    find: '  if (record.error !== undefined) {',
    replace: '  if (false as boolean) {',
    mustFail: [FORMAT_RETENTION],
  },
  {
    name: 'retention-does-not-read-all-five-checks',
    breaks:
      'the five checks being read **one by one** rather than collapsed into ' +
      '`error === undefined`. A record that says four of §7.5’s five passed is a ' +
      'record this must refuse, and the one dropped here is the one phase 8 built a ' +
      'whole renderer round trip to answer.',
    file: 'packages/format/src/retention.ts',
    find:
      "  if (!verified.lastFrameDecodable) reasons.push('the last frame of the export did " +
      "not decode');",
    replace: '  void verified.lastFrameDecodable;',
    mustFail: [FORMAT_RETENTION],
  },
  {
    name: 'retention-deletes-more-than-the-report-names',
    breaks:
      '§7.5’s list being *exactly* `media/` and `events/`. Deleting more than the ' +
      'authoritative document says is the one direction this may never err in: ' +
      '`thumbs/` is the poster the library card for an exported recording still ' +
      'shows, and the report does not name it.',
    file: 'packages/format/src/retention.ts',
    find:
      "export const RETENTION_SOURCE_DIRECTORIES: readonly ['media', 'events'] = " +
      "['media', 'events'];",
    replace:
      "export const RETENTION_SOURCE_DIRECTORIES = ['media', 'events', 'cursors', 'thumbs'] as " +
      "readonly ['media', 'events'] as unknown as readonly ['media', 'events'];",
    mustFail: [PHASE9, FORMAT_RETENTION],
  },
  {
    name: 'retention-deletes-before-it-records',
    breaks:
      '§7.5’s ordering — *"write `retention.sourcesDeletedAt` **first**, then unlink"*. ' +
      'Reversed, a crash inside the unlink loop leaves an editable recording with ' +
      'holes in its media and nothing on disk saying a deletion ever began, so no ' +
      'later launch finishes it and nothing can explain it.',
    file: 'apps/main/src/export/retention.ts',
    find:
      '    await store.recordRetention(id, newRetentionRecord(isoTimestamp()));\n' +
      "    await step('recorded', id);\n" +
      '    const removed = await store.deleteSources(id, RETENTION_SOURCE_DIRECTORIES, {',
    replace: '    const removed = await store.deleteSources(id, RETENTION_SOURCE_DIRECTORIES, {',
    mustFail: [PHASE9, RETENTION_CRASH],
  },
  {
    name: 'retention-sets-the-state-before-the-media-goes',
    breaks:
      '§7.5’s third step being **last**. Set first, a crash mid-unlink leaves a ' +
      'recording the library calls `exported` — *"the sources are gone and this ' +
      'recording is final"* — with most of its media still on disk and no launch ' +
      'that will ever look at it again.',
    file: 'apps/main/src/export/retention.ts',
    find: "    await step('recorded', id);\n    const removed = await store.deleteSources(",
    replace:
      "    await step('recorded', id);\n    await store.setState(id, 'exported');\n" +
      '    const removed = await store.deleteSources(',
    mustFail: [RETENTION_CRASH],
  },
  {
    name: 'an-unexported-recording-can-be-deleted',
    breaks:
      '§7.5 obligation 3 — *"an unexported recording is never auto-deleted"* — being a ' +
      'property of the deleting method rather than of its callers. The retention ' +
      'record is written only after a verification that returned no failure, and ' +
      'refusing without it is what makes the one destructive call in this ' +
      'application unable to fire on its own.',
    file: 'apps/main/src/project-store.ts',
    find: '    if (open.project.retention === undefined) {',
    replace: '    if (false as boolean) {',
    mustFail: [PHASE9],
  },
  {
    name: 'retention-resumes-a-recording-nobody-exported',
    breaks:
      'the launch-time pass being a *resume* rather than a sweep. Without the ' +
      '`sourcesDeleted` half of the predicate it lists every recording that is not ' +
      'already exported — which is every recording — and obligation 3’s *"never by ' +
      'age, disk pressure, or app launch"* becomes exactly the policy the captain ' +
      'was told he was not getting.',
    file: 'apps/main/src/project-store.ts',
    find: "    return summaries.filter((s) => s.sourcesDeleted && s.state !== 'exported');",
    replace: "    return summaries.filter((s) => s.state !== 'exported');",
    mustFail: [PHASE9],
  },
  {
    name: 'retention-treats-an-unreadable-directory-as-an-empty-one',
    breaks:
      'the one distinction `deleteBundleSources` is allowed to make. Only `ENOENT` ' +
      'means "already deleted"; swallowing `EACCES`, `EIO` or `ENOTDIR` reports a ' +
      "directory it could not read as one it emptied, and the caller's next act is " +
      '`state: "exported"` — a library that says the recording is final beside every ' +
      'source still on disk, which no later launch will revisit because ' +
      '`listInterruptedRetention` skips an exported recording.',
    file: 'packages/format/src/fs/bundle.ts',
    find: "  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;\n  throw error;",
    replace: '  void error;\n  return null;',
    mustFail: [PHASE9],
  },
  {
    name: 'two-exports-of-one-recording-are-allowed-to-race',
    breaks:
      'the refusal phase 9 made necessary. Two jobs for one recording resolve the ' +
      'same `<name>.mp4`, and the destination claim in `ProjectStore` only spans a ' +
      "writer's life — so the second renames over an export the first already had " +
      'verified, hashed and recorded, and a `discardExport` on its own failure unlinks ' +
      'it. The first job has by then deleted the sources, which leaves the user ' +
      'neither their footage nor their finished file: the one outcome nothing else in ' +
      'this application can produce.',
    file: 'apps/main/src/export/session.ts',
    find:
      '    const heldBy = this.#exporting.get(id);\n' +
      '    if (heldBy !== undefined) throw new ExportRecordingBusyError(id, heldBy);',
    replace: '    const heldBy = this.#exporting.get(id);\n    void heldBy;',
    mustFail: [EXPORT_SESSION],
  },
  {
    name: 'a-failed-verification-does-not-stop-the-export',
    breaks:
      'the throw that stands between §7.5’s checks and everything after them. Without ' +
      'it a failed export reports `done`, puts an unverified file on the clipboard, ' +
      'and reaches the deletion — where only `mayDeleteSources` is left between the ' +
      'user and losing their footage. That is one guard where there were two.',
    file: 'apps/main/src/export/session.ts',
    find: '      if (outcome.failure !== null) {',
    replace: '      if (outcome.failure !== null && (false as boolean)) {',
    mustFail: [PHASE9, EXPORT_SESSION],
  },

  // ---- the phase-6 gate's own judgement policy ----------------------------
  {
    name: 'the-over-budget-share-is-never-compared',
    breaks:
      'the one bound the deferred branch carries on both of its doors. The tracking ' +
      'ceiling is a multiple of a number a stalling host inflates, and the scaled ' +
      'envelope grows ten times faster than a GPU-side regression lifts the frame it ' +
      'judges — so a compositor missing the budget frame after frame is caught by *how ' +
      'often* and, on those hosts, by nothing else. Deleting the comparison leaves a ' +
      'deferred phase with no distributional check at all, and the gate reports it.',
    file: 'test/gate/budget-control.ts',
    find: '  if (frameShare >= resolution && frameShare > spinShare) {',
    replace: '  if (false) {',
    mustFail: [BUDGET_POLICY],
  },
  {
    name: 'a-dead-control-withholds-the-verdict',
    breaks:
      "the rule that a withheld verdict keys on the control's own measured overrun and " +
      'on nothing else. Withholding for a control that produced *nothing* makes "the ' +
      'instrument stopped running" and "the gate has no opinion" the same event, ' +
      'silently and forever: a control that dies takes §8 with it and the run reports ' +
      'skipped rather than failing on its own sample-count floor.',
    file: 'test/gate/budget-control.ts',
    find: '  return !environmentSustainsBudget(control, budgetMs);',
    replace: '  return control.count === 0 || !environmentSustainsBudget(control, budgetMs);',
    mustFail: [BUDGET_POLICY],
  },
];

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const selected = only === null ? MUTATIONS : MUTATIONS.filter((m) => m.name === only);
if (selected.length === 0) {
  console.error(`no mutation named ${only}; known: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(2);
}

/** Original bytes of every file we touch, so an interrupt cannot leave one broken. */
const originals = new Map();

function restoreAll() {
  for (const [path, text] of originals) writeFileSync(path, text);
  originals.clear();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

function runTests(files) {
  const result = spawnSync('npx', ['vitest', 'run', ...files], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  return { failed: result.status !== 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const results = [];
try {
  for (const mutation of selected) {
    const path = resolve(root, mutation.file);
    const original = readFileSync(path, 'utf8');
    const occurrences = original.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      console.error(
        `mutation ${mutation.name}: expected exactly one occurrence of its target in ` +
          `${mutation.file}, found ${occurrences}. The source moved; update the mutation.`,
      );
      results.push({ name: mutation.name, verdict: 'stale' });
      continue;
    }

    originals.set(path, original);
    writeFileSync(path, original.replace(mutation.find, mutation.replace));
    console.log(`\n── ${mutation.name}`);
    console.log(`   breaks: ${mutation.breaks}`);

    const caughtBy = [];
    const survived = [];
    for (const file of mutation.mustFail) {
      const { failed } = runTests([file]);
      (failed ? caughtBy : survived).push(file);
      console.log(`   ${failed ? 'caught by' : 'SURVIVED '} ${file}`);
    }

    writeFileSync(path, original);
    originals.delete(path);
    results.push({
      name: mutation.name,
      verdict: survived.length === 0 ? 'caught' : 'survived',
      caughtBy,
      survived,
    });
  }
} finally {
  restoreAll();
}

console.log('\n── summary');
for (const result of results) {
  console.log(`   ${result.verdict.padEnd(9)} ${result.name}`);
}

const holes = results.filter((r) => r.verdict !== 'caught');
if (holes.length > 0) {
  console.error(
    `\n${holes.length} mutation(s) were not caught. The gate does not measure what it claims.`,
  );
  process.exit(1);
}
console.log(`\nall ${results.length} mutations were caught.`);
