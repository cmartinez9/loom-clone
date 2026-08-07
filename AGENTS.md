# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this is

A **local-only, macOS-only** Loom-style screen recorder and editor, built in Electron.
No cloud, no account, no upload. Being built in fourteen phases against a fixed design.

## The authoritative documents — read these before changing anything structural

These live outside the repo and outrank this file, the code, and your own judgement.
If you believe one is wrong, say so; do not silently diverge, because other phases are
compiling against it.

| Document                                       | What it settles                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/firstmate/data/loom-architecture/report.md` | The technical design. §2 is the on-disk format, §1 the process/module architecture, §3 the timeline model, §8 the build order and each phase's gate. |
| `~/firstmate/data/loom-clone-decisions.md`     | The captain's settled product contract (decisions 1–9).                                                                                              |
| `~/firstmate/data/loom-research/report.md`     | Claims measured on this machine, and §7's traps.                                                                                                     |
| `~/firstmate/data/loom-design/`                | The approved "Pressroom" visual language, plus working mockups of every surface.                                                                     |
| `~/firstmate/data/loom-scope/decision-*.md`    | Individual captain decisions with their reasoning.                                                                                                   |

The architecture report carries a **Correction, 2026-08-05** at its end: §6 is internally
inconsistent (§6.2/§6.3 cannot satisfy §6.6), and where §6 conflicts with that correction
the correction governs. Read it before implementing anything against §6.2, §6.3, §6.5 or
§6.6; the §6 text itself is deliberately preserved as designed.

Section references in source comments (`§2.7`, `§7.1`) point at the architecture report.

## Commands

```bash
npm run build       # esbuild main + preload, vite renderer, clang the sampler -> dist/
npm start           # build, then run the app
npm run dev         # rebuild on change and restart Electron
npm run verify      # typecheck + lint + format:check + test  (what CI runs)
npm test            # vitest
npm run verify:mutation   # break the production source one way per entry in
                          # scripts/mutation-check.mjs's MUTATIONS registry, which is where
                          # the list and the count live — each must fail a gate
npm run verify:permissions # phase 2 gate: package, ad-hoc sign, run the TCC checks from the bundle
node scripts/verify-permissions.mjs --app <path>       # ...against a bundle already on disk
node scripts/verify-permissions.mjs --mic-revocation   # ...plus §7.3's check, which needs you
                                                       # to switch Microphone off mid-recording
node scripts/make-sync-fixture.mjs               # regenerate the flash palette (needs ffmpeg)
npm run package     # electron-builder, macOS only
node scripts/seed-fixtures.mjs <root>            # example recordings to look at
npm run record:cursor-corpus                     # re-record phase 10's ten real
                                                 # recordings (drives the pointer for
                                                 # ~5 min; --manual to move it yourself)
node scripts/make-capture-fixture.mjs            # regenerate the encoded-frame fixture (needs ffmpeg)
npm run build && node scripts/smoke-capture.mjs  # record the real screen once, end to end
node scripts/smoke-capture.mjs --synthetic       # ...with a canvas and an oscillator instead
node packages/sampler/native/build.mjs --force   # rebuild only the native sampler
node scripts/gate-load.mjs 20 45                 # the only way to load the box for a gate run
./dist/native/loom-input-sampler probe           # what input capture can do right now
npx electron scripts/screenshot.cjs --out shots --theme light   # capture the real windows
```

## Layout

```
packages/format/   the on-disk format: schemas, types, validation, migrations,
                   writeAtomic, the edit journal, `src/sync/` — the A/V
                   alignment arithmetic, which lives here rather than in a package
                   §1.3 does not list because every function in it is a reading of
                   a §2.3 field — and `src/retention.ts`, which is the same bargain
                   for §7.5: whether an `ExportRecord` has earned the deletion of the
                   sources, and the sentences the user is shown before it does.
                   `@loom/format` is PURE (no node, no DOM);
                   `@loom/format/fs` is the filesystem half.
packages/mux/      both MP4 writers §1.3 asks for: `fragment-writer.ts` (capture,
                   fragmented, survives SIGKILL) and `faststart.ts` (export, one
                   `moov` first, real sample tables), plus the two readers — `scan.ts`
                   for fragments and `movie-scan.ts` for a finished movie, which is
                   what §7.5's verification demuxes with.
                   `@loom/mux` is PURE; `@loom/mux/fs` owns the file descriptors and,
                   like `@loom/format/fs`, has exactly one caller.
packages/ipc/      the typed main<->renderer contract. Not in the report's §1.3 list;
                   §1.4 requires a shared contract and this is it.
packages/permissions/  the four macOS grants: what each is for, what breaks without it,
                   which System Settings pane turns it on, and whether an answer can be
                   believed at all. PURE. The probes are in
                   `apps/main/src/permissions.ts`, whose header states which files may
                   call `systemPreferences` and what enforces it.
packages/design/   "Pressroom": tokens, type scale, icons, self-hosted fonts.
packages/decode/   the ONE decode path: DemuxIndex, FrameRing, SourceReader.
packages/compositor/  the ONE compositor: WebGL2 `Compositor`, pure draw calls, plus
                   `AnnotationPass` (blur, mask, arrow, rect, ellipse, highlight,
                   text, stroke). `@loom/compositor/raster` is its one impure
                   subpath — the glyph rasteriser, the `@loom/format/fs` bargain
                   applied to a canvas.
packages/edl/      the timeline model (report §3): tracks, channels, keyframes, the
                   two evaluators, `compile`/`resolve`, inverse ops and undo/redo,
                   `src/generators/` — report §6: cursor-follow, auto-zoom-on-click,
                   the §6.6 comfort budget, and §3.5's regenerate and bake — what an
                   annotation span's channels and style MEAN (`annotations.ts`), and
                   the live overlay's import path (`drawing.ts`). Owns the SEMANTICS;
                   `@loom/format` owns the `EditDocument` types and their schema.
                   `ResolvedState` lives here and the compositor imports it.
                   `test/corpus/` is phase 10's ten real recordings.
packages/sampler/  the 120 Hz cursor sampler, CGEventTap clicks and cursor bitmaps.
                   `native/` is an Objective-C CLI built by one `clang` call into
                   `dist/native/`; the TypeScript half parses its NDJSON and has no
                   filesystem of its own. Main-process only.
apps/main/         Electron main: WindowRegistry, ProjectStore, RecorderSession,
                   PermissionManager, OverlayController, `export/` (ExportSession,
                   §7.5 verification, `retention.ts` — the delete-after-export path
                   and its launch-time resume — the file clipboard, §5.3's
                   stream-copy plan), loom:// protocol, IPC.
                   `recorder/disk-monitor.ts` is §7.2's 2 s poll and `disk.ts` the four
                   lines that compose its preflight reading — the decision and the copy
                   are `@loom/ipc`'s, the syscall is `ProjectStore.diskSpace`'s, and
                   this is what sits between them.
                   `input-sampler.ts` is the sampler's only seam onto the world — the
                   `EventLogSink` backed by `ProjectStore`, and the clock reading
                   `t0Us` is derived from. `verify/marker.ts` is the paint-capture-count
                   instrument phases 2 and 12 both prove content protection with — one
                   instrument, so there is one opinion about what counts as evidence.
apps/renderer/     renderer windows. First-run setup, library — including the export
                   sheet, which is where §7.5's retention warning and the keep-sources
                   switch live — recorder HUD, the hidden
                   capture page (screen in `capture/main.ts`, camera in
                   `capture/webcam.ts`, the two audio tracks in `capture/audio.ts`),
                   the live drawing overlay (`overlay/main.ts`), the hidden export page
                   (`export/`), the preview loop, `media/` — the loom:// readers
                   both of them share, including `TrackReader`, which is what turns a
                   multi-part track into the one-part seam preview and export already
                   speak — and `editor/`, the editor window: the preview host, the
                   timeline and trimming.
test/              gates that span more than one package, in a real Electron renderer.
```

`apps/export` and `apps/capture` from report §1.3 live as `apps/renderer/src/export/`
and `apps/renderer/src/capture/` instead, because a window in this repo is a role in
`apps/main/src/windows.ts` plus an entry in `apps/renderer/vite.config.ts`, and a
second renderer app would fork that.

`edl`, `decode` and `compositor` are **pure**: no `node:`, no `electron`, no I/O,
enforced in `eslint.config.mjs`. They reach the world through narrow declared seams —
a `ByteRangeReader`, a `DecoderFactory`, the GL context they are handed, and `edl`'s
`CursorEventStream`/`ClickEventStream`. Wiring a real captured part to `SourceReader`
needs exactly a byte-range reader, a `loom.index/1` sidecar and a
`VideoDecoderConfig`; `source-reader.ts` says so at the top, including the one thing
an adapter has to decide (where the `avcC` description comes from after a restart,
since `recording.json` does not carry it). `apps/renderer/src/media/loom-media.ts` is
the adapter that answered it — out of the part's own initialisation segment, never a
second copy beside it — and its header says why.

**There is exactly one adapter for that seam, and keeping it that way is a §4.5
obligation rather than tidiness.** Phase 8 and phase 14 each wrote one independently —
`media/track-reader.ts` and an editor-local `ScreenSource` — with the same interface
and the same answers. §4.5 puts _"which source frame is selected for a given time"_ on
the list preview and export may never disagree about, and two implementations of that
selection is that guarantee with a second answer beside it waiting to drift, most
likely on a part boundary where neither loop looks. Phase 14's copy was deleted, both
loops open a track through `openVideoTrack`, and the editor's coverage moved onto the
survivor: `apps/renderer/test/track-reader.test.ts` is the part-selection test, and
`the-part-offset-is-dropped` in `verify:mutation` points at `TrackReader.frameAt`.
**Do not add a third.**

## The four rules that are not style preferences

1. **Main is the only writer to disk.** Renderers propose; main persists. Enforced
   structurally, not by convention: sandboxed renderers have no filesystem at all,
   `eslint.config.mjs` restricts `node:fs`, `@loom/format/fs` and `@loom/mux/fs` to
   `apps/main/src/project-store.ts` (plus read-only `media-reader.ts`), and a `.lock`
   file keeps a second app instance out of a bundle. Adding a second writer is an
   architecture change, not a refactor. That includes the 30 Hz capture path: chunks
   reach the disk through `ProjectStore.appendMediaChunk` like everything else.
2. **Raw and decoded frames never cross IPC.** Encoded chunks do (measured 289 MB/s
   against a ~2 MB/s need). `packages/ipc/test/ipc-boundary.test.ts` fails the build
   if `VideoFrame`, `AudioData`, `ImageBitmap` or friends appear in the contract or
   the preload. The preload exposes named channels only — never a generic `invoke`.
   And every `VideoFrame` has exactly one owner, `FrameRing`, with a `FrameLedger`
   that throws on the _first_ frame past the ring cap (report §10.2). A leak here does
   not throw on its own — the decoder just stops producing frames.
3. **The bundle identifier is frozen.** `com.github.cmartinez9.loom-clone`, declared
   once in `apps/main/src/identity.ts`. macOS TCC keys every permission grant on it;
   changing it costs the user Screen Recording, Camera, Microphone and Accessibility,
   and produces black frames that look like a bug in our code. `identity.test.ts`
   fails if it drifts.
4. **No AI-generated look.** A binding review criterion, not taste: no gradients, no
   `backdrop-filter`, no blurred shadows, no blue-black neutrals, no Inter, no emoji
   as iconography. `packages/design/test/no-generic-look.test.ts` enforces the
   mechanical half. Rationale: `data/loom-design/report.md` §2 and §8.

## A/V sync, in one paragraph

Tracks are captured separately and aligned by `recording.json`, never by trimming
media (§5.4). Three fields carry it and `packages/format/src/sync/` is the only
supported way to read them: **`startTimeSec`** (each part's first sample, on the
recording clock, snapped to the reference when the offset is under one audio buffer),
**`measuredSampleRate`** (what the device actually ran at — a "48 kHz" device is not
48000.000 Hz, and 50 ppm is 60 ms over twenty minutes), and **`gaps`** (time in which
the device produced nothing; the container has no hole in it, so `audioRuns()`
reproduces one as silence). `durationSec` on an audio part is its extent on the
recording clock, gaps included; the media in the file is `durationSec - Σ gaps` long.
The measurements can only be taken from the raw buffer stream, so `AudioCaptureMeter`
runs in the capture renderer and a handful of numbers cross IPC; main places them on
the clock and writes them. **The gate is `apps/main/test/av-sync.test.ts`: a
flash/tone cross-correlation at 1 minute and at 20 minutes, |offset| < 20 ms, with
four controls that must fail.** One minute alone is not a gate — it passes a build
that ignores `measuredSampleRate` by 2.6 ms and fails it by 59.6 ms at twenty.

## The format, in one paragraph

A recording is a `.loomrec` **directory** of independently-captured, independently-
timestamped artifacts (`media/`, `events/`, `cursors/`, `thumbs/`) plus a separate,
versioned `edit.json` describing how to compose them. Nothing is baked into pixels
until export. Every file carries `"schema": "<family>/<n>"` on line one and every read
runs **parse → migrate → validate**; an unknown or future schema is refused, never
guessed at — except `edit.journal.ndjson`, which degrades instead: its entries are
withheld and the file is preserved aside, but the recording still opens from its
`edit.json`, because an unreadable header must not brick a recording. The `events/`
logs carry no schema line at all: §2.5 specifies their exact contents, they are
streams of one event shape rather than documents, and `recording.json` is what
versions them.
Writes go through `writeAtomic` (temp file, `fsync`, `rename`, then
`fsync` the directory — the last step is the one people leave out). Edits are appended
to `edit.journal.ndjson` as one op per line and snapshotted into `edit.json` on a
debounce, so an editor crash costs at most 250 ms.

Time is **seconds, float**, everywhere except the frame index sidecar. Media tracks
are lists of parts (`screen.000.mp4`) from day one, never a single file.

`loom.settings` is at **version 2** — phase 2 added first-run state — so the migration
registry has a real step in it and `loadAndUpgradeDocument` is exercised on every
launch. Adding a version is the three steps in `packages/format/src/schema.ts`.

## Capture, in one paragraph

A hidden renderer runs `getDisplayMedia` (video **and** `audio: 'loopback'`) and
`getUserMedia` (the microphone, and the camera) → `MediaStreamTrackProcessor` →
`VideoEncoder`/`AudioEncoder`, and sends **encoded chunks** to main, which writes each one as its own
`moof`+`mdat` fragment the instant it exists. One sample per fragment is the crash
budget made explicit: a `SIGKILL` costs what this process still holds, so a fragment
is one frame (~110 bytes of overhead, ~0.2% at 12 Mbps) rather than the report's
"≤ 1 s". The writer holds exactly one sample so every duration is measured against
the next frame's timestamp, which a variable-rate screen track needs. `recording.json`
is written **before the first frame** with the facts only a live session knows
(display, scale factor, permissions); recovery corrects it rather than inventing it.
The frame index is held in memory and written at finalize — recovery rebuilds it by
scanning the fragments, which is strictly better than a checkpoint and avoids
rewriting a growing JSON once a second for the length of the recording. Audio parts
are the same fragment layout in a `.m4a` (one AAC frame per fragment, no sidecar —
1024 samples is arithmetic, not an index), and their media timeline is contiguous:
a gap lives in `recording.json`, never in the container.

## Parts, and the camera

**One acquisition of a device is one part.** The camera is what makes that real:
unplugging it fires `ended`, which closes `webcam.000.mp4` with `endedEarly` and
`endReason: 'device-lost'`, and a `devicechange` bringing the **same `deviceId`**
back opens `webcam.001.mp4` with a `startTimeSec` of its own (§7.4). The hole
between them lives in `recording.json` and is never concatenated out of the media —
§5.4 mechanism 5, applied to pictures. `apps/renderer/src/capture/webcam.ts` owns
that loop and nothing in it can fail the recording: §7.3's rule for a microphone that
_went away_ is §7.4's rule for the camera — a withdrawn grant is the one case that is
not, and § A revoked Microphone is where it lives — and `session.ts` draws the same
split: the screen is `REFERENCE_TRACK` and only its failures reach `failActive`.

A part that closes **while the recording continues** is the `capture.partEnded`
message; main finalizes that file and its sidecar immediately, so a later crash
costs the part that is open rather than both. The last part of each video track is
still open at stop and is closed from `CaptureEndReport.video`. `startTimeSec` is
deliberately **not** computed when a part closes — the reference track's epoch
offset is not known until the capture page stops — so each part keeps its raw first
timestamp and epoch offset and they are all placed in one pass at finalize, through
`videoPartStartSec` (§5.4 mechanisms 2 and 3, the arithmetic `alignAudioPart`
already used). The camera is opt-in: `webcamDeviceId` defaults to `null`, because
opening one lights the hardware indicator and that should follow from a user asking.

## The event logs, in one paragraph

Every recording samples the pointer. `RecorderSession` starts an `InputSampler`
(§2.5, 120 Hz) at the **reference track's first frame** and stops it **before**
`store.close`, and `apps/main/test/recorder-events.test.ts` drives both through the
recorder itself. Two details are the whole of it. **It starts at the first frame, not
at `start()`**, because that frame _is_ the recording clock's origin (§5.4 mechanism 2) and §2.5 requires the log's `t` to share it — starting earlier would put `t = 0`
wherever `getDisplayMedia` happened to be in opening its stream, a constant few-tenths
lead on every generated camera move. **And it always asks for clicks**, never
conditioning the request on `AXIsProcessTrusted()`: `clicks: false` means "this caller
opted out" and reads back as `not-requested`, which is a lie about a grant the user
declined — the app asked for Accessibility on the promise of this log, so a denial must
reach `recording.json` as the tap's own `accessibility-denied`. Cursor position needs
no permission and is written either way; `clicks.ndjson` exists only once the tap is
live, and `available` is read from the sampler rather than inferred from the file,
because a dead tap and a quiet session produce the same empty log. Nothing in the
sampling path may reach the capture spine: the call is inside a `try`, the start is
never awaited, and every failure is a `console.error` and a recording that carries on.

**The origin is measured, and the residual is known.** `t0Us` is on the helper's
`CLOCK_UPTIME_RAW`, which nothing in Node can read — `process.hrtime` is
`mach_continuous_time`, the same _rate_ but a different epoch. So `readHelperClock`
takes one paired reading (a `probe`, fired at `start()` so its cost lands while the
stream is opening) and the origin is that reading plus the elapsed time to the first
frame, both measured on `process.hrtime`. Measured on a real synthetic-source run:
first sample at **t = 0.024 s**, log covering 3.87 s of a 4.05 s recording. **The
elapsed term is stamped where the frame arrives, in `onVideoChunk`, not where the
origin is used** — the first screen chunk is always held while its part is opened, and
`appendHeldChunks` replays it on the far side of an atomic `recording.json` write, so a
reading taken there would be measuring the disk. **And the paired reading takes `after`,
not the midpoint**: the helper stamps `tUs` in `probeReport()`'s dictionary literal,
after the tap create/enable/release and `measureDisplay`, so the stamp sits near the end
of the interval and there is no difference to split; `uncertaintyUs` is the full width
and a one-sided bound. What is _not_ measured is the encode and IPC between the screen
producing that frame and main receiving it, which makes the origin slightly late and
every sample slightly early — tens of milliseconds against §6.5's 600 ms pre-roll, and
in the _opposite_ direction to the probe bound, so the two partially cancel. **Closing
that gap is an open item**, in the carried-forward list below; it needs the capture
renderer's `performance.now()` related to main's clock, which is new IPC and new §5.4
arithmetic.

## The timeline model, in one paragraph

Report §3, and `packages/edl` is all of it. Two time domains — **source** (seconds
into the raw recording) and **timeline** (seconds into the edited output) — and the
clip list is the _only_ thing that maps between them; every object states its domain
and never straddles. Effect tracks are anchored in **source** time so trimming does
not re-time your zooms (§3.2, a deliberate divergence from Cap); tracks that describe
the _output_ set `domain: 'timeline'`. **The field is per-track and explicit — never
inferred, from the target or from anything else.** One primitive: four track kinds,
one keyframe, one channel. Tracks on the same `target` stack and the topmost with an
opinion wins — read per _channel_, so a zoom track carrying only `amount` leaves the
centre the track below it set. A channel is evaluated one of two ways and mixing them
inside one channel is a validation error: curves are pointwise, springs are
**precomputed on a fixed 8 ms grid at compile time** and sampled with an index and a
lerp. `compile()` once per edit (debounced 100 ms), `resolve()` once per frame —
preview and export both call it, which is why they cannot disagree. `resolve` returns
the `CompiledTimeline`'s **own** state object, overwritten in place; keep one with
`cloneResolvedState`. Undo/redo is the inverse-op stack in the editor
(`EditHistory`), over the same §2.7 op vocabulary that main journals — so an undo is
journalled, revisioned and crash-safe on exactly the path the edit it reverses took.

## Export, in one paragraph

Report §5. A hidden export window per job, owned by **main** and not by the editor
(§1.2), composites with the same `Compositor` and reads through the same
`SourceReader` the preview does — that is §4.2's whole point, and
`ExportRenderLoop.renderAt` is the one function from a timeline instant to pixels.
Two passes, **audio first** then video: audio is seconds of work against minutes
(§5.7), so a machine that cannot encode AAC fails in the first second rather than
after four minutes. Encoded chunks cross to main; main muxes. The output is a
**faststart** MP4 — `moov` first — which cannot be written in one pass, so
`ExportMp4Writer` streams each track to its own scratch file and assembles
`<name>.mp4.partial` behind the finished header, then `fsync`/`rename`/`fsync` the
directory exactly as `writeAtomic` does. A cancelled or killed export therefore
leaves **nothing**: §7.5 obligation 1 read the other way round, because a truncated
export is a shorter video that looks finished. Success is not "nothing threw" — it
is §7.5's five checks, answered off the disk by `apps/main/src/export/verify.ts`
(exists · non-zero · demuxes · duration within 100 ms · **the last frame decodes**,
plus a sha256), with the decode done in the export window because that is where a
decoder lives. **The duration is checked against the _edit_, never against the
writer**: `job.expectedDurationSec` is `exportFrameCount(timeline.durationSec, fps) /
fps` on the recompose path and the copy plan's own duration on the fast path, because
`FastStartWriter.plan()`'s tally is the number `mvhd.duration` was written from and a
check answered with it can only fail on header bytes the parse already rejected.
`exportFrameCount` lives in `@loom/ipc` so the window that produces the frames and the
main process that measures them cannot drift. A verified-good export then hands the
recording to **retention** (below); every failure path throws above that call, so a
failed export deletes nothing. It does remove its own failed
output: §7.5's order is rename-then-verify, so a file that fails the checks is already
in place under its real name, and a broken video the app knows is broken is worse in
the user's Exports folder than absent. **Every** failure is recorded in `project.json`,
not only a verification failure — "no record" and "a record saying it failed" are
different things to wake up to — and the only one that cannot be is main itself dying.
Captain decision 9 is the rest: the file is written to `settings.exportRoot`
(default `<recordingsRoot>/Exports`, changed by a picker and remembered, never
prompted for), put on the clipboard as a **file** via `NSFilenamesPboardType`, and
revealed in Finder. §5.3's stream-copy path is `apps/main/src/export/stream-copy.ts`
— eligibility is a pure predicate that returns _every_ reason so the UI can say what
to turn off, and the copy itself is byte ranges out of the `loom.index/1` sidecar
with no decoder anywhere. Audio is still mixed by the window on that path: §5.3's
condition list is entirely about pictures.

## Retention, in one paragraph

Phase 9, report §7.5, and `data/loom-scope/decision-loom-storage-retention.md` — the
captain chose auto-delete of the raw sources after export, was shown the contradiction
with his earlier "save everything", and confirmed. The **decision** is
`mayDeleteSources` in `@loom/format` (pure, beside `src/sync/` and for the same
reason: it is a reading of §2.2 fields), which reads the durable `ExportRecord` and
returns _every_ reason it says no — the `streamCopyEligibility` shape. It does **not**
re-verify anything: §7.5's five checks are phase 8's `verify.ts`, answered off the
bytes on disk, and a second opinion about "is this file good" would be a second thing
to keep correct with the wrong one doing the deleting. What it does instead is refuse a
record that does not _say_ all five passed, field by field rather than by
`error === undefined` — a record claiming four of five is one to refuse whatever else
it says. The **act** is `apps/main/src/export/retention.ts`, and it is §7.5's three
steps in §7.5's order: write `retention.sourcesDeletedAt` **first**, then unlink
`media/` and `events/`, then set `state: "exported"`. That order is the whole crash
story — there is no instant at which the library says `exported` beside media that is
still there, and none at which an editable recording has lost its sources with nothing
on disk saying a deletion began. `resumeInterruptedRetention`, called once at launch,
finishes what a crash interrupted; it is a **resume and not a sweep**, because the only
thing it can act on is a `retention` record and only a verified export writes one.
Deletion never fails an export: the file is written, verified and about to go on the
clipboard, and `#run`'s `catch` discards the output, so a cleanup error there would take
the user's finished video away. `ExportResult.sourcesDeleted` is what actually happened
and is **not** the negation of `sourcesKept` — an authorised deletion that failed
part-way is a third state, and a surface that inferred "final" from the checkbox would
be lying in both directions. That third state is `retentionError`, carried beside
`retentionReasons` for the same reason phase 8 carries the other three: a signal that
cannot be inspected is not a signal. The library says all three in
`apps/renderer/src/library/export-notice.ts` — pure, so what the user is told is pinned
by `npm test` rather than eyeballed — out of `RETENTION_COPY`'s `exported`, `kept` and
`deletionFailed`, which is where the before-the-export warning lives so the two cannot
drift. Telling someone their recording "was kept" when half its media is gone is worse
than silence: it is a false assurance they discover only when they try to edit.

**The gate is `apps/main/test/phase9-retention.test.ts`**: the real `ExportSession` over
a real bundle with real bytes in `media/` and `events/`, failed at **each** of
`VERIFICATION_FAILURES`'s ten members individually, with every source surviving each
one byte-for-byte. It is bound to that array rather than to a copy — the scenarios are a
`Record<VerificationFailure, …>`, so a new failure mode with no scenario does not
compile — because a retention gate covering nine of ten modes is exactly the shape of
bug that deletes someone's footage. Three things keep it from passing vacuously: the
inventory must be non-empty before each run, each scenario must produce _its own_
failure message, and an undamaged control must actually delete.
`apps/main/test/retention-crash.test.ts` is the other half: a real `SIGKILL` **aimed**
at each of the three steps through `RetentionPacing`, with a `contradictions()`
inspector that has its own control. Nine retention mutations in
`npm run verify:mutation` break the production source on disk — including making the
deletion unconditional, which is the mutation the gate exists for.

**Obligation 2's surface has never been observed rendering, and that is a hole in a
data-destruction safeguard rather than a documentation nicety.** The export sheet in
`apps/renderer/src/library/main.ts` _is_ §7.5 obligation 2 — the settled decision that
the user is **told** before their sources go, and that there is no silent destruction —
and `RETENTION_COPY.warning` is that promise in words.
`packages/format/test/retention.test.ts` pins the sentences,
`apps/renderer/test/export-notice.test.ts` pins which one is chosen, and `main.ts`
builds the nodes; none of that is the claim that a person can read the warning where it
is put. It is **one of four such surfaces**, and they are recorded together in § Four
surfaces nobody has watched render — what each one's absence costs, what _is_
established, why the human observation is missing, and the single signed-bundle pass
all four are discharged at. Do not restate any of that here: a second copy of it is a
claim to keep correct twice.

## Sharp edges — retention

- **`RETENTION_SOURCE_DIRECTORIES` is exactly §7.5's `media/` and `events/`.**
  `cursors/` (deduplicated bitmaps, kilobytes) and `thumbs/` (the poster an exported
  recording's library card still shows) are not named in the report and are not ours to
  add. Over-deleting is the one direction this may never err in, and the control asserts
  both survive.
- **Three independent guards, and they are not redundant.** `mayDeleteSources` refuses a
  record that does not say all five checks passed; `ProjectStore.deleteSources` throws
  `RetentionNotAuthorisedError` unless `project.json` already carries the retention
  record step 1 wrote; and `validateProjectDoc` refuses to write `state: "exported"`
  without one, so even a caller running the steps backwards cannot persist the forbidden
  document. Obligation 3 — _"an unexported recording is never auto-deleted"_ — is
  therefore a property of the method rather than of its callers.
- **The directories survive their contents.** `deleteBundleSources` unlinks entries and
  leaves `media/` and `events/` in place, so the §2.1 layout is valid at every instant
  and a re-run after a crash costs a `readdir`. Each directory is `fsync`'d after its
  entries go, because `unlink(2)` is no more durable than `rename(2)`.
- **`RetentionPacing` and `DeleteSourcesPacing` exist so the crash gate kills the real
  function.** Same bargain as `WriteAtomicPacing`, and the same justification: a harness
  that wrote §7.5's three steps out itself would keep passing after they were reordered.
  Production callers pass nothing.
- **Only `ENOENT` means "already deleted".** `deleteBundleSources` tolerates a directory
  that is not there — that is what makes the resume idempotent — and **raises everything
  else**. A swallowed `EACCES`/`EIO`/`ENOTDIR` reports a directory it could not read as
  one it emptied, and the caller's next act is `state: "exported"`: the library saying
  the recording is final beside every source still on disk. That is the first state
  `contradictions()` forbids and the only unrecoverable one, because
  `listInterruptedRetention` skips an `exported` recording and no later launch would
  look at it again. `retention-treats-an-unreadable-directory-as-an-empty-one` is the
  mutation.
- **Two exports of one recording are refused; two recordings sharing one _name_ are
  not.** `ExportSession.start` throws `ExportRecordingBusyError` when a live job already
  holds that `RecordingId` — claimed before the first `await` and before `openProject`,
  released in `#run`'s `finally` on every exit path. It is refused rather than made safe
  because the alternative is an invariant held across two jobs, a `rename(2)` and a
  deletion, guarding a case nobody wants. **What it does not reach**: two _different_
  recordings whose `safeFileName(project.name)` collides (two "Untitled"s) still resolve
  to the same `<name>.mp4`. Phase 8 accepted that knowingly in `discardExport`'s docblock
  — _"an earlier good export sharing the name is what that costs"_ — when it cost an old
  export; with retention it can cost a deleted recording's only file, because the second
  job's `rename(2)` replaces a verified export and its `discardExport` unlinks the shared
  path. `ProjectStore`'s destination claim only spans a **writer's** life, so it does not
  close it either. Recorded rather than fixed: it needs a durable claim on the output
  name, which is a decision, not a patch.

## The generators, in one paragraph

Report §6, and `packages/edl/src/generators/` is all of it. **Cursor-follow** is §6.1
conditioning (shake filter, decimation to 60 Hz, cursor-shape debounce) → §6.2's dead
zone → keyframes shifted `friction/tension` seconds earlier for §6.4's phase lead →
§6.3's spring, integrated by `precomputeSpring` at compile time and nowhere else. It
emits a **`center`-only** zoom track and takes the magnification it is framed for as a
parameter, because §6.2's rest box is a fraction of the _visible zoomed viewport_ and
§3.5's stack is read per channel — so anything above it keeps its own `amount`.
**Auto-zoom-on-click** is §6.5's five steps and emits `amount` + `center` with
`activeRanges` set to its merged segments, so between clusters the follow underneath
shows through. Both are ordinary `Track`s; `lifecycle.ts` is §3.5's other half —
staleness against the `GeneratorSpec` fingerprint, regeneration as `track.remove` +
`track.add` **at the same index**, and bake as one `track.patch` whose `remove`
survives `JSON.stringify`. **Clicks are not a stream, they are a `ClickSource`**: a
discriminated union, so "the tap was dead" and "nobody clicked" cannot arrive as the
same empty array — the one failure `@loom/sampler`'s `count: number | null` exists to
prevent, restated at the seam that consumes it.

## §6.6's budget, the ten real recordings, and the one divergence

`npm test` runs `packages/edl/test/phase10-gate.test.ts` over
`packages/edl/test/corpus/` — **ten real `.loomrec` bundles**, recorded on this
machine by `npm run record:cursor-corpus`. Everything below
`CGWarpMouseCursorPosition` is the shipping path (real `loom-input-sampler` at 120 Hz,
real `InputSampler`, real `createBundle`); the hand is a script by default and a
person under `--manual`, and `corpus/manifest.json` says which. Two controls make the
budget mean something: the same ten logs followed with §6.2 and §6.3 **removed** must
fail it, and the same generator with the rest box set to nothing must leave the target
still for less of the recording. Measured: 78–89% still with the box, 17–54% without.
The corpus was recorded with Accessibility granted, so its `clicks.ndjson` are real and
§6.5 is exercised against real `CGEventTap` output on all ten — the gate reads
`manifest.json`'s `clickCapture` and **fails loudly** if a future corpus is recorded
without the grant, rather than quietly becoming "auto-zoom declines politely ten
times".

**What that gate does not prove, and what does.** It proves the generators work over
real sampler output. It says nothing about the _product_ producing that output — and
for ten phases the product did not: `record-cursor-corpus.mjs` did the wiring
`RecorderSession` lacked, so the corpus could only ever have been made by the script
that makes it. `apps/main/test/recorder-events.test.ts` is the other half and is
deliberately built the opposite way round: every bundle in it comes out of
`RecorderSession`, and nothing in it constructs an `InputSampler` or writes a file.

**The comfort ladder is a settled divergence, not an open one.**
`data/loom-scope/decision-comfort-ladder.md` records the captain's decision and the
contradiction in §6 that forced it; the architecture report carries a matching
**Correction, 2026-08-05** which _governs where §6 conflicts with it_. Read both before
touching §6.2, §6.3, §6.5 or §6.6 — the §6 text is preserved as designed, so it still
reads as though the ladder were unnecessary.

What that settles, in one line each: `COMFORT_LADDER` in `cursor-follow.ts` tries
**§6.2/§6.3 exactly as rung 1** and only then softens the spring (ω₀ scaled, ζ kept, so
§6.4's lead follows) and caps the follow target's speed at 0.30 / 0.25 UV/s — a cap with
**no §6 counterpart**, and the accepted divergence. §6.5's `preRollSec`, `amountRange`
and `edgeSnap` are implicated by the same geometry and covered by the same acceptance.
The rung values and what each was measured to buy are at `COMFORT_LADDER` itself; do not
re-derive them here.

## Sharp edges — the generators

- **The budget is measured on the _visible_ centre, not the resolved one.**
  `sourceSampleRect` clamps the sampled rect into the frame, so at `amount = 1` every
  centre resolves to 0.5 and centre motion there is invisible. A `center`-only
  cursor-follow track measured on its own is therefore a **fictional** camera —
  `framingTrack()` is why `measureTrack` is not vacuous. `budget.ts` restates that
  clamp rather than importing `compositor` (which already depends on `edl`), and
  `packages/edl/test/budget.test.ts` pins the two against each other at every
  magnification.
- **A generated track has to survive `validateEditDocument`, not merely not throw.**
  The hostile fixtures' bar is the whole postcondition — finite, strictly ordered keys
  and a document that validates — because a `NaN` keyframe reaches `edit.json` and
  leaves a recording that stops opening. That is what the §6.1 sanity pass is for, and
  it is the _only_ place that decides what a usable sample is.
- **A log whose origin was never subtracted is refused, never rebased.** `t` is
  `(tUs − t0Us) / 1e6`; with `t0Us = 0` it carries machine uptime (2,678,930 s was
  measured). `compileChannel` refuses a spring channel past `MAX_SPRING_TABLE_SEC`, so
  a generator that emitted those keys would produce a track it could not then measure.
  `MAX_SOURCE_TIME_SEC` drops them in the sanity pass instead; rebasing would silently
  move every generated effect relative to the media.
- **The cursor-follow track's `blendMs` is 0 and auto-zoom's is 250, deliberately.**
  §3.5's crossfade is for a _handover_, and the bottom track of the stack spanning the
  whole recording has only the first and last instants as edges. A crossfade there is
  the camera sliding in from the frame centre over 250 ms — 0.25 UV in a quarter
  second is **1.0 UV/s** against §6.6's 0.35, on every recording, for no reason.
- **§6.5's `clusterBox` is a fraction of the frame.** Read against the _viewport_ as
  §6.5's prose says, the constraint is unsatisfiable for any width-dominant cluster
  (`targetFill ≤ clusterBox[0]`, i.e. `0.6 ≤ 0.5`). The constants settle it:
  `clusterBox[0] = targetFill / amountRange[0]` exactly. `auto-zoom.ts` has the
  arithmetic.
- **§6.5 step 1 is spatial as written, and needs a time criterion; `clusterGapSec` is
  derived, not chosen.** Clustering on the bounding box alone let one cluster span a
  whole recording — measured on the ten real logs as a single segment spanning nearly
  all of eight of them, with `mergeGapSec`, `minDurationSec` and the `activeRanges`
  handover to cursor-follow all inert. A click joins the current cluster only if it is
  under `clusterGapSec` after the **previous** click, and that is
  `preRollSec + postRollSec + mergeGapSec` = 2.6 s exactly: the gap at which step 1 and
  step 4 already agree, so a step-1 split below it is undone by step 4 and a join at or
  above it contradicts it. It has to be that sum rather than `postRollSec` alone, because
  a step-1 join is irreversible and re-derives `amount` from the joint bbox where step 4's
  merge only takes `max(amount)`. `auto-zoom.ts`'s header has the derivation, the
  argument that §6.5's own three parameters presuppose it, and the corpus numbers;
  `packages/edl/test/phase10-gate.test.ts` asserts the segment count the constant
  implies, on all ten.
- **`minDurationSec: 1.0` cannot fire, and is left at §6.5's value anyway.** The shortest
  segment §6.5 can produce is one click's `preRollSec + postRollSec` = 1.8 s, or 1.2 s
  where the pre-roll clamps at `t = 0`. Step 4's drop is dominated by `postRollSec` and is
  dead under §6.5's own numbers — a finding to record, not a number to tune.
- **§6.5's "four keyframes per segment" is three when the hold has no length.** A
  cluster of one click has `holdStart === holdEnd`, and §2.6 forbids a repeated `t`.
- **An auto-zoom segment's `activeRanges` runs `4/(ζω₀)` past its last keyframe.**
  §3.5's crossfade is only the no-op it is meant to be where the two sides _agree_ at
  the edge, and at a segment `end` they do not: the last keys say identity but the
  spring is still on its way there, so the window drags the difference to identity over
  `blendMs` and turns a 1.2 s post-roll zoom-out into a 250 ms one. Measured on the ten
  real recordings: with the tail removed the worst pan acceleration lands at a segment
  `end` on most of them and is several times what the tail leaves, while pan speed is
  the same either way — the crossfade was corrupting the acceleration, not the speed.
  The figures are at `auto-zoom.ts`'s module header.
- **Auto-zoom's own §6.6 figure is over budget, and it is geometry rather than a
  defect.** The legal centre at magnification `a` is `[0.5/a, 1 − 0.5/a]`, an interval
  that _opens as the zoom tightens_, so a centre edge-snapped for the segment's full
  `amount` slides outward while the pre-roll zooms in — and the deeper the segment
  zooms, the longer that slide. It is reported on `AutoZoomResult.budget` and **not
  gated**, because §6.6's remedy is a rest box and this generator has none. Slowing it
  means changing `preRollSec`, `amountRange` or the edge snap, all §6.5's specified
  numbers — covered by `data/loom-scope/decision-comfort-ladder.md`. The derivation and
  the measured corpus figures are at `auto-zoom.ts`'s module header; do not re-derive
  them here.
- **`arrayClickStream`/`arrayCursorStream` sort with `(a, b) => a.t - b.t`, which is an
  inconsistent comparator once a `t` is `NaN`** — the order is then
  implementation-defined, so a test that pins exact survivor counts on a log containing
  one is pinning V8's current sort. The generators are unaffected: both sanity passes
  re-filter and refuse anything non-finite or not strictly later. Left as it is on
  purpose — these are phase 7's shared stream contracts and phase 8 and phase 11 consume
  them too, so tightening the comparator is a later phase's call, not phase 10's.
  `packages/edl/test/auto-zoom.test.ts` states the order-independent invariant instead.
- **§6.7 is not here.** The cursor _sprite_'s own stiffer spring belongs to whatever
  composites the sprite; `Track` already carries `smoothing` and `clickSpring` for it.
- **The corpus driver warps, it does not post.** Measured on this machine with
  `AXIsProcessTrusted() = false`: `CGWarpMouseCursorPosition` moves the pointer and
  `CGEventPost(kCGEventMouseMoved)` does not — synthesizing an _event_ is gated by
  Accessibility, moving the _pointer_ is not. That is why a corpus can be recorded on a
  machine with no grant, and why clicks cannot be.

## The editor, in one paragraph

Report §8 has a phase for the timeline _model_ (7), the _generators_ (10) and
_annotations_ (11), and no phase that builds the window they live in; the captain
settled that in `data/loom-scope/decision-editor-scope.md` ("full editor", with
**track stacking and blending UI out of the MVP** and **manual zoom alongside the
automatic generators**). `apps/renderer/src/editor/` is the shell half: the window,
the preview host, playback transport, the timeline and trimming. The library's
**Open** button sends `loom.editor.open(id)`; `apps/main/src/editor.ts` shows the
`editor` role keyed by the recording — which is what §1.2's `multiple: true` already
meant by one editor per recording — and puts the id in the page's URL, so a window is
_told_ what it is showing. That module also owns the other half of the lifetime:
**closing an editor gives back the hold it took**, because `openProject` took the
bundle `.lock` and a lock held by a window nobody can see is a recording the app
cannot record over with nothing on screen to explain it. It is `releaseProject` and
**not** `close`: an export of the same recording holds the same project for a job
that outlives the window which started it (§1.2), and the library offers Open and
Export on the same row for the same `editable` state — so an unconditional close
there takes the lock and the `JournalWriter` out from under a running export, which
then cannot record its own result and discards a verified MP4 already on disk. The
two are indistinguishable in what a lone editor leaves behind, so
`apps/main/test/editor-window.test.ts` asserts the method rather than the outcome and
`closing-an-editor-closes-a-project-somebody-else-holds` is the mutation. It refuses
to open the bundle the recorder is using, and refuses to release that one, for a
sharper reason: `close()` aborts every media part still open, and those are capture's
own file descriptors — with counted holds that guard is defence in depth rather than
the only protection.

**The framework question `library/main.ts` deferred to "phase 6 or 7" is answered
here: vanilla TypeScript against the Pressroom design system, like the other four
windows.** The argument is in `editor/main.ts`'s header and is not only consistency —
the two things this window does sixty times a second are a WebGL draw and one style
write, and §4.3's first rule is that nothing allocates in the loop. `loom-p15`
inherits the choice; re-taking it is a decision to write down, not one to drift into.

**The timeline is drawn in _source_ time**, and that is the load-bearing layout
decision (`timeline-geometry.ts` argues it). Its full width is the recording as
captured; the trimmed-away head and tail stay on screen, dimmed, with the handles
still on them. §3.2 anchors effect tracks in source time _"so that trimming does not
re-time your zooms"_, so a timeline-time ruler would draw those tracks sliding under
a trim they are explicitly independent of — and a keyframe placed by hand, which is
`loom-p15`'s job, would not stay over the frame it was placed on. The playhead is
the one thing that crosses: it is drawn at `resolve(...).sourceTime`, and a scrub
converts back with `timelineTimeAt`. **A trim is `clips.set` with one clip and no new
primitive**, at `speed: 1` always — `trim.ts` says why a speed control is not a local
change.

**There is no audio, deliberately.** §5.4 mechanism 4 requires playback time to come
from the audio output's played-sample count and `PreviewLoop` accumulates
`requestAnimationFrame` deltas, so sound against that clock would walk away from the
scrub bar at the device's own error — 90 ms over thirty minutes at §5.5's 50 ppm.
`packages/format/src/sync/align.ts`'s table now records mechanism 4 as unimplemented
and says where it belongs; adding sound means implementing it first.

**The gate is `test/editor-gate.test.ts`**, a real Electron run: a real `.loomrec`
built from the committed H.264 fixture through the shipping writer, the real library
window, its real Open button, the real editor. Its one assertion worth the whole
gate: _trim two seconds off the front, and the picture at timeline 0 is
**byte-for-byte** the picture that was at source 2.0 s before the trim_ — with the
control beside it that source 0 and source 2.0 differ, or the equality would pass on
any recording of a still screen and on a preview that decoded nothing after its first
frame. `testsrc2` is what makes a pixel hash a fingerprint of a source instant. Five
`preview-*`/`a-trim-*`/`the-part-*`/`the-timeline-*` entries in `npm run
verify:mutation` break the production source on disk, and each names what has to
notice it — this gate for the two that move the picture, `editor-trim.test.ts` and
`track-reader.test.ts` for the three that do not. It deliberately does **not** time
the frame budget: §8's 16.67 ms is `test/phase6-gate.test.ts`'s, and a second opinion
about one number is a weaker one.

## Sharp edges — the editor

- **The editor reads its picture through `media/track-reader.ts`, not through anything
  of its own.** That is seam S4's bridge — `SourceReader` knows one part in
  **part-relative** time while `ResolvedState.sourceTime` spans the recording clock —
  and it is shared with the exporter on purpose (§4.5, above). Every method that
  crosses it — `frameAt`, `hasSourceFrameAt`, `selectionMicros`, `prime`, `release` —
  carries its own copy of `t - part.startTimeSec`, so each has its own assertion in
  `apps/renderer/test/track-reader.test.ts`: three of them were droppable with every
  other test in that file still green, which is what "ported a shim, not
  coverage" looks like from the inside. The way that was established is worth reusing
  — break the source ten ways and require each break to fail — because a test that has
  never been seen to fail is a claim, not a measurement.
- **`edit.output.size` is `[1920, 1080]` on every bundle and nothing sets it from the
  recording.** `newEditDocument()` is the only thing that writes it, so a 3456×2234
  capture previews — and will export — letterboxed into 1080p. The editor shows the
  number as a measured fact rather than overriding the document, which is how this was
  noticed at all. Whoever owns output settings has to decide it; do not paper over it
  in a renderer, because the exporter reads the same field.
- **An author `display` outranks the UA's `[hidden] { display: none }`.** Every panel
  in this window that toggles is a grid or a flex box, so without the `[hidden]` rule
  at the top of `editor.css` the refusal card and the empty trouble line sit over the
  editor permanently. `library.css` and `recorder.css` already carried the same note;
  the editor still shipped without it until a screenshot showed it.
- **`.stage` is `@loom/design`'s, not yours.** `components.css` owns a `.stage`
  primitive — the one dark, theme-invariant surface — and a second rule of that name
  in a page stylesheet takes its background depending on which sheet the bundler
  emitted last. The editor's mat is `.mat`.
- **A `<canvas>` cannot be fitted to a ratio in CSS alone.** It is a replaced element
  with an intrinsic size, so every "contain this ratio in that box" goes circular: the
  wrapper's size comes from the canvas and the canvas's percentage `max-*` resolve
  against the wrapper. `fitStage` in `editor/main.ts` measures the mat and sets the
  size in pixels; it is the one place that arithmetic lives.
- **The lane area is `overflow: hidden`, so both ends of the recording need an
  inset.** A trim handle centred on `x = widthPx` has half of itself — including its
  hit target — clipped away, and "trim the very end" is a grab that lands on nothing.
  `EDGE_PX` in `timeline-geometry.ts` is that inset. It was found by the gate dragging
  a real pointer, not by reading the stylesheet, which is the argument for the gate
  driving real input rather than synthetic events.
- **A failed `applyOps` is repaired by the next edit, not latched.** The editor
  applied the batch optimistically, so a send that failed leaves it one revision ahead
  of disk with no op that could reconcile it; §2.7's conflict path is the repair —
  main refuses the next batch and hands back what it holds. `EditorProject` remembers
  only which of the two happened, so the reload names a disk error as one instead of
  sending somebody looking for a second editor window that does not exist.
- **`window.__loomEditor` is a read-only probe, not a capability.** `editor/probe.ts`
  argues it: the gate has to be able to tell "the trim moved the picture" from "the
  playhead moved and the picture did not", nothing in the DOM can, and a frame counter
  counts a stale frame just as happily. A renderer can already read its own canvas, so
  it grants nothing. Keep it read-only.
- **The preview is rendered at `edit.output.size`, not at the window size.** CSS
  scales the element; the composite is what the exporter will encode, at the
  resolution it will encode it, and it does not change because somebody dragged a
  corner. It also keeps the frame budget off the window geometry.

## Annotations, in one paragraph

Phase 11 added **no primitive**: §3.3 already makes an annotation a `kind: 'object'`
track of spans with their own channels, and `compile`/`resolve` already produced
`ResolvedAnnotation`. What it added is the _reading_ — `packages/edl/src/annotations.ts`
says which channels each `type` uses (`from`/`to` for an arrow, `center`/`size` for
everything else, `opacity` for all), what each `style` key means, and what the numbers
are in; and `packages/compositor/src/annotations.ts` draws them. **Geometry is in
normalized _source_ coordinates**, the space `zoom.center` is in — §3.2's argument
about time, applied to space: an annotation is placed on content, so it must travel
with it. The privacy case settles it. Output-normalized geometry would let a zoom
slide the content out from under a blur and publish the thing the user hid, so the
compositor maps annotations through the _same_ `sourceSampleRect` the screen pass
samples with (`sourceToOutput`). Scalars — `strokeWidth`, `cornerRadius`, the arrow
head — are isotropic fractions of the frame **width**, because normalized source
coordinates are anisotropic; `blurPx` keeps §2.6's name and unit, **source pixels**.
Colours are read in the target's own encoding (hex ÷ 255, no linearisation): the whole
pipeline is display-encoded end to end. Spans draw in **document order with no
exceptions** — a blur after a rectangle blurs the rectangle. Text is the one part a
renderer decides rather than we do, so it comes in as a `TextAtlas` on
`CompositorFrames`, built once by `@loom/compositor/raster` and shared by preview and
export; `layoutText` (pure) owns everything downstream of the raster.

**Blur and mask fail closed, in three graded ways, and the line between them is who
decided.** An authored `opacity` of 0 draws nothing — that is intent, not failure. A
region that cannot be _read_ (missing/non-finite `center`, zero-area `size`, a
`blurPx` that would render as identity, a fully transparent `mask` fill) **throws out
of `render()`**: a frame whose redaction could not be placed must not be composited.
A region that is known but cannot be _blurred_ (σ past `MAX_BLUR_PASSES`, no scratch
target) is filled **opaque** and counted in `AnnotationPass.privacyFallbacks` — always
stronger than what was asked for, never weaker, which is why a huge blur does not
quietly become a small one.

**Refusing a frame is those two kinds' alone, and a refusal is survivable.** A `text`
span with no atlas does _not_ throw: text failing to render is cosmetic and visible,
where a redaction failing is invisible and publishes a secret, and treating them alike
made an unbuilt atlas refuse every frame of a preview with no editor open. The span is
skipped, the frame composites, and `AnnotationPass.textSpansWithoutAtlas` counts it —
`packages/compositor` is pure and cannot report anything itself, so `PreviewLoop` reads
the count after `render` and reports the first frame of a run through `onError`,
latched like `#stallReported` because sixty errors a second is its own defect. On a
genuine refusal `Compositor.render` **clears the target to the background before the
throw leaves**, so a caller that catches and still calls `present()` gets the letterbox
colour and never the unredacted picture; the throw itself still leaves, because an
export that cannot place a redaction must fail rather than encode. `PreviewLoop` is the
one caller that catches it: it reports (latched), drops its `VideoFrame` reference in a
`finally`, and keeps scheduling — a throw escaping the rAF callback left `#handle` null
while `#running` stayed true, which makes `start()` an early return and the loop
unrevivable, and that is a wedge rather than a safety property.

**The gate is `test/phase11-golden.test.ts`**, §4.5's golden-frame test extended:
24 fixed timestamps, the shipping `PreviewLoop` against the shipping
`ExportRenderLoop`, max per-pixel delta **0**. Equality alone is not the gate — a preview and an export
that both draw nothing agree perfectly — so every timestamp also renders a third frame
with the annotation tracks disabled and requires that the annotations changed the
picture, that every changed pixel is inside a box `test/golden/fixture.ts` computes
with **its own four lines of arithmetic** (sharing `sourceToOutput` would make the
expectation follow the defect), that each kind drew in its own box, that the mask's
centre is exactly the mask's colour, that the blur destroyed the region's variance,
and that a parked track drew nothing while a crossfading one drew _linearly in its
window weight_ — the `blendMs` half, which a "did it draw" check cannot see. Six
`annotation-*` entries in `npm run verify:mutation` break the production source on
disk and require the gate to notice. **The export path is phase 8's own**: the two-line
stand-in this gate carried while phase 8 was being built has been folded onto
`ExportRenderLoop.renderAt`, with every assertion left where it was — see § Sharp
edges' _"two golden-frame gates"_ for what each covers and what keeps this one on the
real loop.

## The live drawing overlay, in one paragraph

Phase 12. A transparent, full-screen, always-on-top window with
`setContentProtection(true)` (`drawing-overlay` in `windows.ts`), whose strokes are
appended to `events/drawing.ndjson` — §2.5's stream shape, **one line per stroke**
written when the pen comes up, plus `erase` and `clear` events — and imported at edit
time by `packages/edl/src/drawing.ts` as **one generated annotation track**. No new
primitive: a stroke is a `kind: 'object'` span of `type: 'stroke'`, placed by
`center`/`size` like a rectangle, with the polyline itself in `style.points`
(normalized `-1..1` inside the span's own box, so dragging or scaling the ink is
ordinary keys rather than a rewrite of every coordinate) and the reveal in a
`progress` channel the compositor truncates by **arc length**. Deleting it is
`track.remove`; there is no drawing-shaped special case, which is the whole of §8's
_"deletable in the editor"_. The reason strokes are logged rather than burned in is
the middle sentence of that gate: the overlay is out of the captured pixels, so the
editor re-composites the ink at full resolution over whatever zoom and trim the user
ends up with.

**The overlay is an accessory, and that inverts the priority blur and mask have.**
A pen that fails costs a pen; a recording that fails costs the thing the user pressed
record for. So `apps/main/src/overlay.ts` catches every failure on its path, turns it
into `OverlayStatus.error`, and never lets one reach `RecorderSession` — including
`finish()`, which the recorder awaits inside `finalize`. §7.3's _"an audio failure
never fails a recording"_ is the same argument one level up, and ink is further from
the point of a recording than audio is. `RecorderSession` with nothing attached
behaves exactly as it did before this phase.

**Click-through is two states and they are named.** The window is created ignoring
mouse events with `{ forward: true }` — the forwarding is the mechanism, not a
detail: it is what lets the page see the pointer arrive over its own palette while
clicks still fall through to the app underneath, and therefore what makes an overlay
that swallows nothing still reachable. It is armed only while the user has a pen in
hand. And it never activates: `focusable: false` on the role, `showInactive()` in
`OverlayController`, and `WindowRegistry.reveal` refuses to `focus()` any window whose
role declared itself non-focusable. The cost is that a non-activating window on macOS
receives mouse events and **not** keystrokes, which is why nothing here is dismissed
with a key — the palette's Done button, the HUD's Draw toggle and the recording ending
are the three ways out. The third is `OverlayController.finish()`, and it goes through
the same `setOpen(false)` the other two do rather than round it: one close path, which
is also the one that clears `#armed`, so the overlay cannot come back from a later open
still holding the last recording's mouse capture.

**A stroke's `t` is the recording clock minus an age, never a renderer's timestamp.**
The two processes share no time origin — a renderer's `performance.now()` starts when
its document did — so `StrokeMsg` carries `startedMsAgo`/`endedMsAgo` and main
subtracts them from `RecorderSession.sourceTimeNowSec()`. That reader _interpolates_
where `elapsedSec()` deliberately does not: the HUD's timer must stall when the
capture stalls, and a stroke stamped at the last frame's time would be most of a
second early on an idle desktop, where ScreenCaptureKit emits 1.4 fps.

**The gate is `test/phase12-overlay.test.ts`**, in a real Electron renderer in front
of a real window server, and it measures §8's first and third sentences. Live ink: real
`sendInputEvent` gestures into the shipping page, the canvas read back through
`getImageData`, with the inked box checked against where the hand went and a control —
the same gestures with the pen up — that must ink nothing. Deletable:
`packages/edl/test/drawing.test.ts`, through `applyOps` and `EditHistory`, with the log
the gate's real pen actually wrote fed back through the shipping importer. Ten
entries in `npm run verify:mutation` break the production source on disk, and each one
names what has to notice it — `apps/main/test/overlay.test.ts` for the window's own
rules, `drawing.test.ts` for the import, `stroke-pass.test.ts` and phase 11's golden
gate for the ink. None of them lands on the renderer gate itself: the one mutation that
needed it was `setContentProtection` at the role, and it left with the check.

**The middle sentence — absent from the capture — is `overlay-content-protection` in
`apps/main/src/verify/permissions-harness.ts`, and it is unwitnessed.** Measuring it
means capturing the screen, which needs the Screen Recording grant, so it lives where
phase 2 put the identical measurement of the HUD rather than in `npm test`: a harness
whose contract is that a check which cannot run reports `blocked` and says why. All
five readings and all three thresholds are phase 2's own, moved across unchanged —
`CONTROL_MIN = 0.5`, `PROTECTED_MAX = 0.01`, and a `BACKDROP_MIN = 0.99` derived rather
than tuned. **Content protection is an observation of pixels, not a TCC answer**; the
grant is only the camera the check holds while asking. It is sealed by `sealReport`
like everything else and is _not_ in `alwaysHonest`.

Two consequences, both recorded rather than papered over. `npm run verify:mutation` has
**no** entry for `setContentProtection` at the `drawing-overlay` role — the mutation
`the-drawing-overlay-is-not-content-protected` was removed with the check, because no
vitest file can catch it (`windows.test.ts` structurally cannot: the mutation leaves the
role still _declaring_ the flag and only skips the call), and a mutation reported as
caught when nothing caught it is worse than the gap. What guards the property now is the
harness check's own **control window**, which must show the marker before the protected
window's absence means anything. And the check has **never been run**: see the
`overlay-content-protection` row in § Phase 2 gate status.

**Absent from the capture is five readings, not one, because an absence is the easiest
thing in the world to fake.** The instrument is phase 2's, shared rather than
reimplemented (`apps/main/src/verify/marker.ts`). The figures below were measured on
this machine from an **unpackaged dev run**, by the vitest gate this check was moved out
of — not from a signed bundle, and not by the shipped check, which nobody has run. They
are kept because a dev binary's screen capture is a real screen capture and this is a
pixel observation rather than a TCC answer, so provenance does not taint them; they are
what the harness check should reproduce, not evidence that it has:

| reading                                                   |   value | what it rules out                         |
| --------------------------------------------------------- | ------: | ----------------------------------------- |
| control — same role, same page, same calls, flag NOT set  |  99.86% | the instrument cannot see a window at all |
| the overlay's own rectangle, overlay painted the marker   |  0.106% | the overlay is in the capture             |
| **the same rectangle, overlay hidden**                    |  0.106% | that residue being _ours_                 |
| **a marker window UNDER the overlay, seen through it**    |  99.86% | the overlay hiding anything               |
| whole-frame marker scan, against the control's 166,400 px | 166,409 | the overlay being elsewhere in the frame  |

The third row answers the only question the first two leave open. The protected
rectangle does not read exactly 0.0%, and what it reads is **whatever is on the user's
desktop behind an invisible window**: hiding the overlay leaves the reading and its
mean colour unchanged to three decimals. The fourth is the strong form of the claim
and the reason it exists — _"under 1% marker"_ also passes when the capture is dim,
the desktop is plain, or the rectangle is slightly wrong, so a marker-painted
**unprotected** window is placed under the overlay, the overlay is repainted a
non-marker colour, and the capture must come back holding the whole thing. Its 99%
floor is derived rather than tuned: the rectangle's perimeter is 1.01% of its area, so
a one-pixel resampled border is the most that can be lost.

**Two things this measurement got wrong before it got them right**, and both moved
with it into the harness. A control must differ from the thing under test in **exactly
one respect**, and the first version differed in three — window level,
`setVisibleOnAllWorkspaces`, mouse policy — because it was built from the role's
constructor options alone and never received the calls `OverlayController.setOpen`
makes; `applyOverlayWindowCalls` now makes them to both windows. And
**`setContentProtection(false)` does not un-hide a window that was already shown
protected**, which turned an experiment into hours of reading "the flag is off and it
is still absent" as a defect in the product — so do not try to test that end of it by
turning the flag off at runtime. Breaking the flag at the role is what would test it,
and there is no longer a mutation that does: the property's only guard is the harness
check's control window, and it has survived a version of this measurement whose control
was not a control.

## The disk monitor, in one paragraph

Report §7.2, phase 13, and it is deliberately three layers. The **decision and the
copy** are pure and live together in `@loom/ipc` — `DISK_THRESHOLDS`, `classifyDisk`,
`diskRefusesStart`, `diskRequiresStop`, `measureCaptureRate`, `DISK_COPY` — for
`exportFrameCount`'s reason (main acts on them, the HUD and library render them, and a
threshold with two copies is a banner saying one thing beside a monitor doing another)
and for `RETENTION_COPY`'s (the promise and the act read from one place). The
**measurement** is `ProjectStore.diskSpace()`, `statfs` on the recordings root, because
§0 rule 2 puts every syscall against the disk behind that class; `bavail` not `bfree`,
since the difference is root's reserve. The **act** is
`apps/main/src/recorder/disk-monitor.ts`, a 2 s poll wired into `RecorderSession` with
its reader injected — the default is the shipping `store.diskSpace()` and a test drives
it instead, which is the only way to watch a threshold being crossed without filling a
real volume. §7.2's stop is the **ordinary `stop()`**: the capture page flushes, parts
finalize from the end report, the bundle reaches `editable`, and that is what makes the
file playable rather than the half-written fragment the section exists to prevent. The
capture page therefore reports a perfectly ordinary `reason: 'stopped'` and only main
knows why — `Active.stopReason`, set at the instant the monitor decides, is what
`endReasonFor` reads, and it is what finally **produces** `PartEndReason`'s `disk-full`.
The preflight floor is enforced in `RecorderSession.start` and not only reported by
`recorder.preflight`: a refusal that lives in the advice alone is one a menu item or
`smoke-capture.mjs` walks past. It is carried on `PreflightReport.disk` rather than
folded into `blocking`, which stays permissions-only — a full disk has no pane to open.

**The monitor is an accessory and the recording outranks it**, the same rule §7.3 gives
audio and §7.4 the camera, applied to an instrument rather than a device: every callback
is wrapped, a `statfs` that throws becomes a reading of `level: 'unknown'`, and every
predicate answers "no" for `unknown` — so a volume this process cannot measure refuses
nothing and stops nothing. A monitor that could fail a recording would be a new way to
lose footage installed by the thing meant to prevent one.

**And every wait on the volume has a deadline on it**, `readSpaceBeforeDeadline`, shared
by the poll, by `RecorderSession.start`'s preflight and by `readDiskForPreflight` —
`recorder.preflight`'s own reading, which is the one a **window awaits**, so a hang there
is not a missing number but a reply that never comes: `refreshPermissions()` never
returns and the library sequences it ahead of `refreshRecovery()`, taking §7.1's recovery
banner down with §7.2's capacity line and logging nothing.
`the-preflight-reading-waits-on-the-volume-for-ever` is that mutation. A `statfs` that
never returns — against the volume being watched _because_ it is
in trouble — wedged the in-flight guard for good: every later tick returned immediately,
nothing was published, nothing was logged, and §7.2's stop became unreachable while the
disk filled. The deadline is half the poll interval (`diskReadDeadlineMs`), so a
timed-out read lands back inside its own interval and cannot stack polls; it bands the
volume `unknown` and **says so** in the log, because the silence was half the defect.
The guard is released on every exit and reset by `start()` behind a generation counter,
so a poll the previous recording left in flight neither swallows this one's immediate
reading nor publishes against it. `a-stalled-disk-read-switches-the-monitor-off` is the
mutation. `ProjectStore.diskSpace()` reads first and `mkdir`s only on `ENOENT` for the
same reason: on a path a data-loss safeguard polls, a reading `statfs` alone could have
answered must not be lost to a write failing.

**A deadline abandons a read; it does not retire one, so there is a second guard at a
second level.** The `fs` request the poll walked away from is still on libuv's
four-thread pool, which `ProjectStore`'s media writes share — so without
`SingleFlightDiskRead` a stalled volume would park one more request every 2 s until
`appendMediaChunk` queued behind them, the instrument slowing the recording it watches.
It holds **at most one** underlying read and later callers **join** it rather than
issuing a second, which is also what keeps the stop reachable: a stalled `statfs`
returns when the mount comes back and the poll waiting on it gets that answer in the
same tick. The two guards are at different levels **on purpose** — the poll's own flag
must keep clearing on every deadline or the paragraph above is undone — and
`apps/main/test/phase13-disk.test.ts` asserts both in one place so a future change
cannot trade one for the other. What it cannot do is recorded rather than papered over:
a volume whose metadata stays wedged while writes still succeed leaves the monitor
blind, because nothing in Node can retire the stuck request, and a blind instrument
beats a blocked capture spine. `abandoned-disk-reads-pile-up-on-the-threadpool` is the
mutation.

**The library walk behind the capacity estimate is started, never awaited.**
`store.list()` is `readdir` plus `stat` over every bundle, and on the volume this
feature is about those hang exactly as `statfs` does — so awaiting one in
`RecorderSession.start` would put the wedge back one line above the deadline that
closed it. It is `void this.measureLibrary()`, bounded by `LIBRARY_RATE_DEADLINE_MS`
(10 s, its own constant rather than §7.2's poll interval, which would abandon a walk
that was going to answer), and a walk that could not answer leaves whatever the last
one measured. `measureLibraryRate` returns `CaptureRate | null` for that reason: a hang
and a throw are the same "we do not know", and `captureRate()`'s
`libraryRate ?? REFERENCE_RATE` is the only place that decides what to say instead.
`the-library-walk-is-awaited-before-the-recording-starts` is the mutation.

**The capacity estimate is measured, and says whose measurement it is.**
`CaptureRate.source` is `measured` or `reference` and is never smoothed away: during a
recording the rate is that recording's own bytes (counted at the `appendMediaChunk`
seam, `Active.bytesWritten`) over its own media seconds past a 2 s floor; before one it
is `measureCaptureRate` over the user's own library, weighted by seconds; and
`REFERENCE_CAPTURE_RATE_BYTES_PER_SEC` — research §5.6's 76 MB/min — answers only a
first run. §5.6 measured a 35× spread between an idle screen and full-screen animation,
so a bare "≈ 42 min available" from that constant is a sentence about somebody else's
screen. The library rate is resolved **once per recording**, in `start()`, and reused by
every poll below the 2 s floor: `store.list()` is a recursive walk of every bundle on
disk and must never land on the 2 s poll path beside the media appends it would queue
with. It is an accessory like the rest — a library that cannot be listed costs the
_provenance_ of the estimate, never the recording. `DISK_COPY.capacity` is rendered on
the library's masthead, which is §7.2's estimate on a volume that is _not_ refusing:
the refusal banner covers the other end, and between them the sentence reaches a page.
It — and the HUD's own disk banner — is **wired and not yet watched rendering**;
§ Four surfaces nobody has watched render is where that stands.

**§7.2's "< 2 min of headroom" clause cannot fire, and is kept at §7.2's value anyway** —
the shape `minDurationSec: 1.0` already has in `auto-zoom.ts`. Two minutes of headroom
is below the 1 GB stop for any rate under 500 MB/min and §5.6's _worst_ measured content
is 146 MB/min, so the byte floors are always reached first. It is implemented rather than
dropped because it is the report's, and because a spec clause silently omitted is worse
than one that is inert and says so; `packages/ipc/test/disk.test.ts` pins both halves.

**The gate is `apps/main/test/phase13-disk.test.ts`**: the real `RecorderSession` writing
the real H.264 fixture through the real `ProjectStore`, with the volume's answer driven
down past 5 GB and then past 1 GB, ending `editable` with a part marked `disk-full`, a
`media/screen.000.mp4` `/usr/bin/avconvert` remuxes, and a frame index carrying every
frame that went in. **Eight controls**, because each assertion passes for a wrong reason
without one: a volume that never drops must not stop the recording and must write no
`disk-full`; that recording's file must play too, so playability is about the interrupted
run rather than the fixture; a reader that throws on every poll must leave the recording
running; the banner must have been _published_ below 5 GB and absent above it; a volume
that _answers_ must be read afresh every poll, or the single read the stalled scenario
asserts is a guard that stopped reading rather than the stall; a library with nothing in
it must report `reference`, or `measured` is the label that path always carries; a
library that answers must reach `measured`, or the `reference` a wedged walk reports is
the wiring rather than the wedge; and a preflight volume that answers must band `ok`, or
the `unknown` a stalled one reports is what that function always says. **Eleven**
`disk`/`preflight`/`monitor` entries in `npm run verify:mutation` break the production
source on disk — the six phase 13 shipped with, plus
`a-stalled-disk-read-switches-the-monitor-off`,
`the-first-seconds-of-a-recording-ignore-the-users-own-library`,
`abandoned-disk-reads-pile-up-on-the-threadpool`,
`the-library-walk-is-awaited-before-the-recording-starts` and
`the-preflight-reading-waits-on-the-volume-for-ever` — none of them guarded only by a
gate that can withhold.

## Crash recovery is told to the user, and where its numbers come from

Report §7.1 step 5 — _"Show the user: 'Recovered 4:52 of a 4:58 recording.' Never
silently discard, never silently pretend it was clean."_ The repair has run at launch
since phase 1 and reported to a `console.log` the user does not have, which is the
second half of that sentence reached by omission. `RecorderSession.recoverOnLaunch` now
**keeps** what it found (`recoveryReports()`), because the pass runs before any window
exists and there is nobody to push to; the library **pulls** it on load through
`library.recovery()`. `RECOVERY_COPY` in `@loom/ipc` is the words, and **every figure in
them is the repair's own** — `recoveredSec`, `frameCount`, `truncatedBytes`, measured by
scanning the fragments that survived. It states no loss window at all: this project's
guarantee is frame-level (the fragment writer holds one sample), a stale string claiming
otherwise has already had to be corrected here once, and both
`packages/ipc/test/disk.test.ts` and `apps/main/test/recovery-notice.test.ts` refuse one.

**The headline counts what was _repaired_, not what was looked at.** `recoverOnLaunch`
reports every crashed bundle it touched, repaired or not, so a heading over
`reports.length` announced "A recording was recovered after an unexpected quit" directly
above "could not be repaired: …" — _"silently pretend it was clean"_ phrased kindly,
which is the one thing this surface exists to prevent. All three shapes have their own
words (repaired-only, failed-only, and mixed, which names both counts), all three are
pinned in the copy test, and
`the-recovery-heading-counts-recordings-it-could-not-repair` is the mutation.

**Two library state notes were wrong about when recovery happens and are corrected.**
`needs-recovery` said the bundle would be repaired _"when opened"_; it is repaired at
launch, and a bundle still in that state when the library renders is one this launch's
pass began and could not finish — `recoverBundle` writes the state before it repairs
anything — so the next launch retries it. `recording` said _"was in progress when the
app last closed"_, which contradicted the pulsing record dot beside it. Both now say
what actually happened. `apps/main/test/recovery-notice.test.ts` is the gate, over a real
crashed bundle through the shipping pass, with the control that an ordinary launch has
nothing to say.

## Four surfaces nobody has watched render, and the one pass that discharges them

**Four user-facing surfaces now exist whose entire job is to tell the user something,
and no human has watched any of them appear on a screen. That is a hole in four
safeguards rather than in their paperwork.** The failure mode is the same in each case
and it is not cosmetic: a banner that does not open, or opens clipped, off-screen or
below the fold, leaves the user un-told while **every test stays green** — the sources
are deleted with no warning anybody saw, or the app stops cleanly at 1 GB with a good
file and the user never learns why, or is never warned early enough to act. A
protection nobody can read is theatre. §7.4's camera banner is the precedent that makes
that concrete rather than theoretical: it was correct in the DOM and had **zero pixels
on screen** for the whole of phase 4, which is what `test/hud-notice.test.ts` exists to
catch.

The four, and what each one's absence costs:

1. **§7.5 obligation 2's retention warning**, in the library's export sheet
   (`apps/renderer/src/library/main.ts`, `RETENTION_COPY.warning`) — the settled
   decision that the user is told **before** their sources go, and that there is no
   silent destruction. Unseen, the deletion happens anyway.
2. **§7.1 step 5's recovery banner**, in the library (`recovery-banner`,
   `renderRecovery`) — _"Never silently discard, never silently pretend it was clean."_
   Unseen, the app is back to the omission this branch fixed: a repaired recording that
   looks exactly like every other recording.
3. **§7.2's capacity line**, on the library's masthead (`disk-capacity`,
   `renderCapacity`) — the estimate that arrives while there is still time to delete
   something.
4. **§7.2's low-disk banner and the notice its stop leaves behind**, on the recorder
   HUD (`#disk`, `renderDisk`) — the warning during a recording, and then what the
   clean stop saved.

The first guards destruction; the other three prevent and report loss. The discipline
is the same either way.

**What _is_ established, so this is honest in both directions.** The pages that host
them load and render with this code without throwing: `test/editor-gate.test.ts` shows
the real library window through the real `WindowRegistry` role, the real preload and
the real `loom://app/library.html`, waits on `document.fonts.ready` and clicks its Open
button; `test/hud-notice.test.ts` does the same for `recorder.html` and then measures
§7.3's and §7.4's notices in **pixels** clipped to the viewport, with a `--no-fit`
control that must read zero. The HUD's shelf arithmetic already carries the disk line —
`reportNoticeHeight` sums it with the camera, revoked and error lines and
`WindowRegistry.fitHudNotice` sizes the window to the total, which is the mechanism
that gate measures for the other two. The copy is pinned:
`packages/format/test/retention.test.ts` and `apps/renderer/test/export-notice.test.ts`
for the warning, `packages/ipc/test/disk.test.ts` and
`apps/main/test/recovery-notice.test.ts` for `DISK_COPY` and `RECOVERY_COPY`. And
`packages/design/test/no-generic-look.test.ts` walks `apps/renderer/src`, so it passes
over `library.css` and `recorder.css`; all four surfaces reuse existing tokens and
component classes.

**What is missing is specifically the human observation, and it is missing for all
four.** No `npx electron scripts/screenshot.cjs` run was made on the branch that built
the last three. Every gate named above renders them **hidden**, or does not open a
window at all: `test/editor-gate.test.ts` builds its `registerIpc` with no `recovery`
function and no `PermissionManager`, so `library.recovery()` answers `[]` and
`recorder.preflight()` has no handler — both library banners stay hidden and the export
sheet is never opened; `test/hud/main.ts` sends `disk: null, diskStop: null`
deliberately, so the HUD's disk line is never given text; and
`apps/main/test/phase13-disk.test.ts` and `apps/main/test/recovery-notice.test.ts` mock
`electron` outright. Copy pinned in a test and copy read by a human are different
claims.

**The reason is environmental.** `scripts/screenshot.cjs` boots the real
`dist/main/index.cjs`, whose recordings root is `homedir()` with no override but
`--verify-permissions` (`apps/main/src/index.ts`), so it could not be pointed at a
scratch library, and seeding the captain's real recordings root from a task worktree
was not acceptable. Three of the four need state on top of that which a dev run cannot
manufacture honestly: an export that has just deleted its sources, a bundle genuinely
crashed mid-recording, and a volume genuinely inside §7.2's bands.

**Where all four are discharged: the project's single signed-bundle end-to-end pass**,
the one run once and deliberately at the end because packaging and re-signing void the
captain's grants and cost a full re-grant cycle (§ Sharp edges — permissions). They
belong to it beside `microphone-revocation` and `overlay-content-protection`, which
report `skipped` in § Phase 2 gate status for that same reason — items on a known list,
not orphans.

**And none of them may be upgraded to verified on the strength of a test.** No number
of passing assertions about the copy discharges one; only a human seeing that surface
rendered in a running app does.

**They are recorded here rather than in § Carried forward on purpose, and should
stay.** That list is obligations on phase 2's signed-bundle gate, and none of these is
one — moving them there would dilute what that list means. For the same reason there is
**no row for them in § Phase 2 gate status**: that table is
`apps/main/src/verify/permissions-harness.ts`'s checks, and a surface waiting on the
same pass is not a check that harness runs.

## Sharp edges

- **Audio and video capture clocks do not share an epoch.** Measured by
  `scripts/smoke-capture.mjs`: video frames timestamped from zero, audio buffers from
  2,678,930 s — the machine's uptime. `startTimeSec` is therefore _not_ a subtraction
  of the two raw timestamps; `TrackEpochEstimator` relates them through the one clock
  both are observed on (arrival time), and the residue is removed by the §5.4
  mechanism 3 snap. Sample timestamps themselves are still never wall-clock derived.
- **AAC has 2112 samples of encoder priming**, and AVFoundation trims it by default
  while libavformat does not — 44 ms apart, twice the sync budget. The writer states
  the trim in an `elst` edit list so both agree; a reader that pulls raw chunks out of
  a part instead of demuxing it has to apply `parseAudioInitSegment().encoderDelaySamples`
  itself. **In a finished export, `mvhd.duration` and the audio `tkhd.duration` are two
  statements about the same trim and must agree**: both come from
  `FastStartWriter`'s `#audioPresentedSec()`, which is the sample tally _minus_ the
  priming. A `mvhd` written from the raw tally describes a movie 44 ms longer than
  anything plays, and §7.5's fourth check compares that number against the timeline
  inside a 100 ms budget — so it was spending nearly half the budget on sound nobody
  hears, and a job that fails verification has its finished file discarded. Pinned two
  ways in `packages/mux/test/export-movie.test.ts`: the header against itself
  (`movie.durationSec` vs `MovieTrack.presentedSec`, both read off the disk) and
  `/usr/bin/afinfo` against the **timeline** — AudioToolbox answers from the audio
  track and its `elst` rather than from `mvhd`, so it is a genuinely separate reading
  rather than a second look at ours.
- **A track's in-flight state is registered before the first `await`, not after.**
  Opening a part is two awaits long and frames keep arriving across them — that is
  what `MAX_HELD_CHUNKS` is for. If the announcement path and the chunk path can each
  create the state, the announcement finishes by publishing one whose held-chunk
  buffer is empty and every frame that arrived while the file was being created is
  gone: a second of footage per part, silently, with the recording simply starting
  late. `videoTrack()` in `session.ts` is the get-or-create that closes it, and
  `held-frames-dropped-while-a-part-opens` in `npm run verify:mutation` keeps it
  closed. **The export writer has the same shape and the same reason**: the encoder
  announces its `decoderConfig` and emits its first chunk in one callback, so `meta`
  and the first `chunk` are one IPC message apart while opening the output file is
  two awaits long. `ProjectStore.openExports` therefore holds a **promise**,
  registered before the first `await`, and an append queues behind it. Registering
  late loses exactly one chunk — the video's first keyframe — and produces a file
  that demuxes, reports the right duration, passes four of §7.5's five checks and
  cannot be decoded from the front. Kept closed by
  `export-writer-registered-after-it-opens`.
- **`frameAt` is hold-last _within the ring_, which a preview wants and an export must
  not accept.** `FrameRing.frameAtMicros` returns the newest frame it holds at or
  before the requested time, so a reader whose decode has not caught up hands back an
  **older frame rather than `null`**. In preview that is §4.3 exactly — hold the
  previous picture for a tick. In an export it is a wrong frame written into a file,
  and because nothing else asks the ring to move, the picture stays stuck there for
  the rest of the recording; the file plays, is the right length and shows the wrong
  thing. So `ExportRenderLoop` primes **before** every read rather than only after a
  miss, and compares the frame it was handed against `selectionMicros(t)` — the
  index's own answer, which is why that method is public on `SourceReader` and
  `TrackReader`. This was a real bug, caught by the phase-8 gate's decode of the
  finished file; `export-composites-a-stale-frame` keeps it caught.
- **Every track announcement is a read-modify-write of one `recording.json`.** Every
  encoder — three, or four with a camera — announces itself within milliseconds of the
  others, so `RecorderSession` serializes them on `metaChain`; without it the second
  write drops the first track, which is exactly what happened and what the smoke
  script caught.
- **An audio failure never fails a recording.** §7.3: a microphone that is refused,
  vanishes or cannot be encoded costs its own track and nothing else. The screen is
  what the user pressed record for. The one exception is a grant the user _withdrew_
  mid-recording, which stops it — see § A revoked Microphone.
- **Bracket notation is deliberate.** `tsconfig.json` sets
  `noPropertyAccessFromIndexSignature`; `doc['schema']` is how this codebase says "this
  key may not be there".
- **The preload is CommonJS.** A sandboxed preload has to be. `main` is bundled to CJS
  to match.
- **There is no dev server.** Windows load from `loom://app` in development exactly as
  in a packaged app, so origin, CSP and asset paths cannot differ between them.
- **Every `edit.json`/`project.json` write is serialized** through `ProjectStore`'s
  per-project queue. Checking a revision outside it lets two batches both read
  revision _n_ and both append as _n + 1_. **Media appends are a separate queue**, per
  part, on purpose: they share no revision, write a different file, and must not be
  able to queue behind a snapshot's recursive bundle-size walk — anything queued in
  memory is exactly what a crash costs.
- **`close(id)` is unconditional; `releaseProject(id)` is the counted one.** Every
  `openProject` is one holder, and most never let go — an editor holds its document
  until the window or the app goes — so a holder that took a project for the length of
  an async job (an export, whose window outlives the editor by §1.2) gives it back
  through `releaseProject`, which closes only at zero. A bare `close()` there would pull
  the `.lock` out from under an editor with the same recording open. `close` itself is
  left alone because `trash`, `recoverBundle`, the recorder and `closeAll` all need the
  unconditional one.
- **The one `rm` that points outside a bundle is keyed by job id, not by path.**
  `discardExport(jobId)` removes only what `finalizeExport` recorded as renamed for
  that job — and the writer's `renamed` flag is set at the `rename(2)` itself, not when
  `finalize` returns, because the directory `fsync` after it is in the same `try` and
  can throw with the file already in place. A path argument would put "never delete
  something we did not just write" in the caller's hands, and the caller is reachable
  from IPC; an earlier good export sharing the name is what that costs.
- **A renderer cannot name an export's destination.** `ExportSettingsOverride` is
  `ExportSettings` minus `outputDir`, `requireExportSettings` refuses the key outright,
  and `ExportSession.start` refuses it again where the path is composed. The directory
  is `settings.exportRoot`, changed only by `export:chooseFolder` — a native dialog main
  opens — and `resolveExportPath` `realpath`s it the way `resolveBundleFile` does. The
  `name` override stays: `safeFileName` turns every separator into a space, so it cannot
  be more than one path segment.
- **Stop the sampler, then close the project — in that order.** `ProjectStore`'s
  event-log and cursor-bitmap writes require the project to be open and throw
  `UnknownRecordingError` otherwise; they never open a bundle on the caller's behalf,
  because they are driven from the sampler's timers rather than from a user action.
  Closing first therefore turns a straggling write into a loud, typed refusal rather
  than a silent re-open that re-takes the bundle `.lock` and holds a closed recording
  for the rest of the session. `applyOps` is the deliberate exception and still opens
  a closed project: it is a renderer-driven user action, not a background timer.
  `RecorderSession.finalize` is where the order is kept — `stopSampling` before
  anything else touches the bundle, not in the `finally` beside `store.close` — and
  `sampler-stopped-after-the-bundle-is-closed` in `npm run verify:mutation` is what
  keeps it kept.
- **A spawned helper is not asar-aware.** Electron patches `fs` to read through
  `app.asar`; `child_process.spawn` hands the literal path to `uv_spawn`, which does
  not. Anything executable resolved under `dist/` goes through
  `unpackedHelperPath()`, or a packaged build reports the binary missing when it
  shipped correctly.
- **A crash test that does not kill production code proves nothing.** Phase 0 shipped
  one that killed a copy of `writeAtomic`. Both gates now kill the real path, both
  have a control that must fail, and `npm run verify:mutation` breaks the writer on
  disk and requires the tests to notice. Add a mutation when you add a property.
  The kill waits for the stream as well as the clock: a `SIGKILL` costs a _constant_
  one or two frames, not a proportion, so ≥95% recovered is only a claim about the
  writer once ~60 frames are behind it. Killing purely on a 400 ms timer gave ~80
  frames on an idle machine and ~36 under the full suite, where two lost frames is
  5.6% and the gate failed on arithmetic. See `MIN_HANDED_FRAMES`.
- **`npm run verify:mutation` edits the production source on disk while it runs, and
  restores what it read.** So do not touch a source file while it is going: the
  restore puts back the bytes it read at the start, silently reverting anything you
  changed in between. It handles `SIGINT`/`SIGTERM` and restores in a `finally`, so
  killing it is safe — but a concurrent edit is not. Run it, or edit; not both.
  **And the same window will put a mutation into a commit.** `git add` taken while it is
  going stages whichever source it has broken at that instant, and the restore afterwards
  cannot un-commit it. That is not hypothetical: `2b658e3` on
  `fm/loom-gate8-instrument-validity` committed and **pushed**
  `audio-gaps-closed-instead-of-reproduced` into `packages/format/src/sync/align.ts` —
  verbatim its registry `find` → `replace` — and CI run 31101555081 caught it at the
  phase-3 A/V sync gate reading **-500.5 ms** against a ±20 ms budget. So: never commit
  from a tree while a mutation run owns it, and if a commit's diff touches a production
  file the change had no business in, check it against the registry before anything else.
  A `find` string missing from a source file is the signature.
  **What catches a restore that did not happen is `test/mutation-registry.test.ts`, on
  every `npm test`.** `MUTATIONS` is exported from `mutation-check.mjs` behind a
  main-module guard, with its shape pinned in `scripts/mutation-check.d.mts` so a new
  field is a compile error rather than an unchecked property, and every entry's `find`
  — the _original_ text — must occur in its file exactly **once**. Zero occurrences is
  the loud case: the mutation is committed into the production source, which no other
  mechanical check can see (nothing was deleted, the tree typechecks, and the suite is
  green because a mutation is by construction the kind of change only its own gate
  notices). More than one means the entry cannot say which line it breaks. It also
  refuses a replacement equal to its target, a `mustFail` file that is not there, and a
  duplicate name, which is how an entry stops proving anything quietly.
- **The mutation proof has three outcomes, and its old two over-claimed.** A gate that
  withholds its verdict exits 0 exactly as one that ran and noticed nothing does, so
  `runTests` reads vitest's per-test statuses rather than the exit code alone: a guard
  where **every** test withheld is `NO VERDICT`, which is neither proof nor hole and does
  not fail the run. The half worth remembering is what the _previous_ two outcomes did —
  everything that was not a clean pass counted as `caught`, so a gate that died of a lost
  GPU context was credited as detection. **An "all N caught" recorded before that third
  outcome may include false catches and is not evidence the gates in it measure anything;
  those counts have not been re-audited.** Quote a run, not a number. The script's own
  header carries the measurement that established it.
  **`WITHHOLDABLE_GUARDS` is the structural half**: a mutation guarded _only_ by a gate
  that can withhold is unproven rather than caught whenever that host's instrument fails,
  and no single run looks wrong when that repeats — so it is printed on **every** run
  straight off the registry, deterministic and identical on every host, rather than
  counted over time. One mutation is on that list today
  (`export-writer-registered-after-it-opens`, guarded only by the phase-8 gate) and the
  fix for it is a second guard that cannot withhold, never a retry.
- **Playability is checked with `/usr/bin/avconvert`**, which is AVFoundation and
  ships with macOS, so the check runs on a CI runner with no ffmpeg. ffprobe is used
  additionally when the machine happens to have it.
- **`fsync` on macOS is not `F_FULLFSYNC`.** What `writeAtomic` promises is that a
  _process_ death leaves the old bytes or the new ones, never a mixture — proved by
  `packages/format/test/kill-mid-write.test.ts`, which includes a naive-writer control
  so it cannot pass vacuously.
- **Never `flush()` a `VideoDecoder` mid-stream.** Chromium requires a keyframe as the
  first chunk after `configure()` _and after every `flush()`_, so flushing to learn
  that outputs have landed forces a re-seek and a whole re-decoded GOP on the next
  frame of ordinary playback. `flush` is deliberately absent from `VideoDecoderLike`;
  `SourceReader` waits on the output callback instead.
- **Waiting on a WebCodecs callback is only safe with a deadline on it, and both ends
  of the export needed one.** §5.3's backpressure line waits on the _encoder's_ output
  callback rather than on a clock, which is right — until the backend goes away.
  Chromium exits the GPU process when a context is lost, and that takes VideoToolbox,
  the queue and the `error` callback's pipe together: the encoder then calls neither
  `output` nor `error`, and an unbounded `await` there is §10.2's named symptom
  verbatim, _an export that hangs with no error_. It cost the phase-8 gate a 480 s CI
  timeout that reported nothing at all, on a run whose 24 timestamps had already
  compared at delta 0. `ENCODE_STALL_TIMEOUT_MS` bounds the drain and the `flush` —
  the counterpart of `ExportRenderLoop`'s `STALL_TIMEOUT_MS` on the decode side — and
  `apps/renderer/test/export-encode.test.ts` pins both halves with a working-encoder
  control beside each, because a watchdog with no control is just a shorter export.
  The gate then relaunches **once**, for a lost context and nothing else
  (`test/export-golden/relaunch.ts`, fenced by `test/relaunch-policy.test.ts` exactly
  as phase 6's is). **Closing a path is not releasing it** — `Compositor.dispose()`
  deletes the program, the textures and the render target, and the _context_ lives on
  until the canvas is collected, which is why the GPU still had four to lose (one
  `CONTEXT_LOST_WEBGL` each) when it exited on two consecutive runs. `disposePath`
  hands each one back with `WEBGL_lose_context`, and a release the harness asked for is
  kept out of `contextLost` by name rather than by inference.
- **The phase-8 golden harness dies on CI when the GPU process cannot allocate. Asking
  the GPU for less thinned it out; tuning a switch did nothing; and it is still not
  closed.** Always the same instant, within a second of `export writer open`: an
  allocation the GPU process cannot satisfy, then
  `Restarting GPU process due to unrecoverable error` and `abnormal-exit (exit 8704)`.
  **Which allocator reports it is not part of the signature.** Some runs say
  `Failed to allocate texture` inside `Skia_Wrapped_YUVPlane`
  (`dawn_context_provider.cc:120`); others say `Failed to allocate host memory` out of
  ANGLE-Metal's `mtl_resources.mm`, as a `GL_OUT_OF_MEMORY`. What runs out is **host**
  memory, so the site named is whichever allocation happened to be next rather than the
  one that is too large.
  Two things were tried first and neither closed it, both worth knowing because both
  _sound_ decisive. **One:** `--force-gpu-mem-available-mb` overrides Skia's GPU
  resource-cache budget, so phase 6's `2048` tells the driver it may hold two gigabytes
  before purging one — a claim phase 6 can make (it uploads a frame and draws it) and
  this gate cannot, since every composite here is a YUV→RGB conversion of a
  software-decoded source _plus_ a `new VideoFrame(canvas)` for the encoder.
  `test/export-golden/main.ts` leaves it unset and says so, which is still right; the
  crash came back anyway. **Two:** releasing each finished path's context before the
  end-to-end pass — also still right, also not sufficient, because a release is a
  message to another process and the allocation that failed was the very next one.
  What answered it is the peak itself: the run opened **four** paths (preview, export, a
  third for the divergence controls, a fourth for the export pass) over a 1920x1080
  source, and created that fourth context at exactly the moment three released ones
  were still resident. It now opens **two** and reuses them — the controls run on the
  export path, and so does the export pass. **The resolutions are that same knob, turned
  twice:** 1920x1080 into 1280x720, and then — when the crash came back on five of six
  runs, once at output frame 112 of 168 and once on both of the two launches a lost
  context earns — 1024x576 into a 768x432 output. Both axes stay a whole number of
  macroblocks (16:9 on a macroblock is `256k x 144k`, so the sizes are rungs of one
  ladder) because `readBackFrames` reads the frame code out of an _encoded_ picture. Not
  one assertion moved. The knob on a virtualised runner is the GPU bytes a frame of the
  export pass moves — **source area, output area, and the number of live contexts** —
  not the cache budget.
  **Two turns of that knob did not close it, and there is no third.** Measured on
  `fm/loom-gate-instrument-validity`, at 1024x576 into 768x432: three of seven CI runs
  died the same way — `31094399329`, `31100718641` and `31102224786`, each within a
  second of `export writer open` and each exhausting **both** launches
  `shouldRelaunchGolden` allows, so the gate reported a phase-8 failure about a run that
  produced no reading. The first two reported `Failed to allocate texture` inside
  `Skia_Wrapped_YUVPlane`; the third reported `Failed to allocate host memory` out of
  ANGLE-Metal and carried no Skia line at all, which is the measurement behind the
  sentence above that the allocator is not the signature. A third turn — 768x432 into
  512x288, 44% of the area — was applied as a CI auto-fix on `0e2c49e` and **reverted**
  on `8a421b4`. Read _"Not one assertion moved"_ two paragraphs up in that light, because
  it is the sentence every reduction is defended with: a fixture size is a **constant, not
  an assertion**, so shrinking one survives a zero-deleted-`expect` audit while making a
  gate whose whole job is per-pixel identity materially worse at it. It is a weaker
  guarantee than it reads as. Turning this knob again is a change to what phase 8
  establishes and needs the same scrutiny as deleting one of its checks.
  **What closes it is the third outcome, and it has landed.** A run whose every launch
  lost the context measured nothing, and a gate that calls that a failure is reporting a
  verdict it never reached — what `instrumentOutOfCalibration` answers for phase 6's
  frame budget and now for phase 8's too, so this crash no longer turns the gate red: it
  reports **skipped** under a `NOT JUDGED` banner. § The phase-8 gate has three outcomes,
  below, owns that mechanism. So a `test/phase8-gate.test.ts` whose log carries
  `GPU process gone: abnormal-exit (exit 8704)` within a second of `export writer open`
  on **both** launches is this known crash rather than a regression to chase, and the run
  now says so itself; the answer is still neither a smaller fixture nor a third launch.
  **Match on that pair and not on the allocator**: this rule used to read
  `Failed to allocate texture`, which run `31102224786` — the first run after the revert,
  and the one that turned this branch red — does not contain anywhere in its log. A
  recognition rule that fails to recognise the run it was written for sends the next
  reader chasing a regression, which is the one thing this entry exists to prevent.
- **A lost context the export loop notices first still has to reach
  `report.contextLost`.** `ExportRenderLoop` consults `Compositor.contextLost` before and
  after every composite, so when the GPU process dies mid-export it throws
  `ExportContextLostError` in the same turn — ahead of the `webglcontextlost` event and
  of any `checkContext` in the harness. The report then said `contextLost: false` about a
  run whose context was gone, `shouldRelaunchGolden` never fired, and a run that produced
  no reading was judged as a phase-8 failure. `contextWasLost()` asks the live contexts
  themselves (minus the ones `disposePath` handed back), and main folds in the
  GPU-process exit it watched. The predicate is untouched and nothing is widened: the
  relaunch condition is still `report.contextLost` alone. What a run that loses the
  context on **every** launch earns is not that first assertion but no verdict at all —
  `instrumentOutOfCalibration` in `test/export-golden/verdict.ts`, and § The phase-8 gate
  has three outcomes, below.
- **`prime()` is called ~60×/s and must not disturb decode that is already running.**
  A prime whose range is already requested rides along with the in-flight one rather
  than superseding it, and "the ring does not hold `t`" only means re-seek when the
  ring has moved _past_ `t` or the decoder has gone idle. Getting either wrong turns
  every rendered frame into a seek that discards the decode it just started.
- **Every `SourceReader`/`PreviewSource` method is in _source_ time, and §4.3's
  pseudo-code says otherwise.** `frameAt`, `prime`, `release` and `hasSourceFrameAt` all
  ask about the media, so all four take `resolve(...).sourceTime`; a loop's own
  playhead is _timeline_ time and `packages/edl/src/clips.ts` is the only map between
  them. The report's §4.3 block mixes the two — `frameAt(state.sourceTime)` above
  `prime(t, 0.5)` — and **§4.3 needs the correction the docblock in `preview-loop.ts`
  now carries**; it was written before §3.1 had a clip list to disagree with. Nothing
  catches this by accident: the two numbers are equal over an identity clip list, which
  was every document this app produced until the editor shipped a trim, and both golden
  and phase-6 gates stub the reader so the argument is discarded. The regression test
  that does catch it is the `SOURCE time` describe in `apps/renderer/test/preview-loop.test.ts`
  — a real `compile` over a non-zero `sourceStart`, asserting the argument the reader
  was handed. Any new consumer of a `SourceReader` gets the same test or the same bug.
- **Anchoring `prime`/`release` in source time makes their _windows_ source seconds too,
  so clip speed scales the buffer depth — and this is not `PreviewLoop`'s to fix alone.**
  `SourceReader.prime` covers `[t, t + aheadSec]` in source time
  (`packages/decode/src/source-reader.ts:254`), so the default `lookaheadSec: 0.5` buys
  0.25 s of playback ahead on a 2× clip — half of §4.2's target — and 1.0 s on a 0.5×
  one; `retainBehindSec: 0.1` scales identically, keeping 0.05 s behind at 2×. The
  editor is the first UI that writes a clip list and it writes `speed: 1` only, with no
  speed control — `apps/renderer/src/editor/trim.ts` records that as a scope statement
  rather than a placeholder. That, and only that, is why nothing regresses today; the
  first speed control makes it live. **Do not compensate here.** §4.5 puts preview and
  export on the must-be-identical list, so scaling the window in `PreviewLoop` alone
  manufactures exactly the divergence phase 8's golden-frame gate exists to catch — a
  new defect, not a partial fix. Any change is one decision for both §4.5 paths
  together, and it needs `CompiledTimeline.clips.speeds`, which is `@internal` to
  `@loom/edl` — a cross-package API call, not a local tweak.
- **`Compositor.render` does not clear when it is handed no frame — it returns.** §4.3's
  "a miss holds the previous frame" is kept by leaving the render target alone; a clear
  before the null check turns every backward scrub into a black flash. The loop cannot
  hold instead, because the frame it would keep belongs to the ring and the seek closes
  it. The target is filled with the background at construction and on `resize`, which is
  where the first composite gets its background from.
- **The `VideoFrame` → texture upload is the whole frame budget, off hardware decode.**
  ANGLE binds an IOSurface for free (§12.4, 0.000 ms) only when the decoder is the
  hardware one; on any VM — so on CI — frames are CPU-backed and the same
  `texImage2D` converts and uploads 30 MB, measured at 4.8 ms of a 16.7 ms budget
  while the draw and the blit cost 0.01 ms. `Compositor.render` therefore uploads once
  per frame _of the recording_, not once per composite, and `texSubImage2D` into a
  pre-sized texture is 2.6× slower, not faster — it misses Chromium's fast path.
- **The phase 6 gate is `npm test`, in a real Electron renderer.** `test/gate/` builds
  a harness with esbuild, launches Electron, encodes a 4K VFR fixture with
  `VideoEncoder` and plays it through the shipping `PreviewLoop`. The fixture's frame
  number is painted into every frame and read back out of the framebuffer, so a fast
  blank screen cannot pass. `test/phase6-gate.test.ts` prints the numbers even when it
  passes, and judges the 16 ms budget on **the single worst frame, with no allowance**.
  **What it claims, and on what hardware.** CI verifies **correctness and
  regression-detection**; it does **not** certify the frame budget. The budget is
  certified on **target hardware**, where it holds with roughly **50× margin** —
  0.20–0.30 ms per frame against 16.67 ms. The reason is structural, not runner speed:
  every Mac this ships to has a hardware H.264 decoder and ANGLE-Metal binds the decoded
  frame's IOSurface rather than copying it (§12.4, 0.000 ms), while a virtualised runner
  has no hardware decoder at all and every composite there carries a ~30 MB CPU-backed
  `texImage2D`. That is a **different workload, roughly 25× heavier per frame, that no
  user of this app will ever run** — not a slower version of the product's frame — so how
  often it trips 16.67 ms says nothing about the compositor.
  **`FRAME_BUDGET_MS` and §8's four assertions are untouched, and strict on any host that
  can represent the product** — which is every machine a contributor runs `npm test` on. A
  phase is deferred instead only where the host structurally cannot: no hardware-backed
  decode **and** a per-frame GPU composite above a tenth of §8's whole frame. That branch
  is not a pass. It detects regressions by **rate** — the compositor may miss the budget no
  oftener than the host missed it in the same frames — and bounds single frames only by
  §8's frame scaled by the per-frame work this host was measured doing.
  **The derivations are not repeated here.** `test/gate/budget-control.ts`'s module
  docblock and its per-constant comments own them: the deferred branch's two doors and why
  they carry different bounds, the scaled envelope and the regression class it cannot
  catch, the spin-resolution floor that must never be pinned to a number, the end-stamped
  control pacing every asserted sample count is read off, and why none of these is a
  threshold tuned to a run. Read it before touching any of them;
  `test/budget-control.test.ts` pins the policy — including that a real regression fails on
  both branches — and `test/phase6-gate.test.ts` judges the run.
  **A control that missed its own budget yields no verdict at all**, which is a third
  outcome beside strict and deferred rather than a widening of either:
  `instrumentOutOfCalibration` keys it on the control's own measured overrun and on
  nothing else, the phase is reported through `withheldJudgement`, and the gate reports
  **skipped** — never passed, because this test's name is a claim and a green tick beside
  it asserts what a broken stopwatch did not establish. Its load-bearing assumption is
  that a slow compositor cannot cause it: the spin runs _after_ the measured frame body in
  the same synchronous scheduler dispatch (`counting()` in `harness.ts` —
  `callback(nowMs); afterFrame();`) on the one renderer thread, and `burn` reads its own
  clock, so a slower compositor delays the spin and cannot lengthen it. The harness
  measures that on every run — the slow-compositor phase burns four whole budgets inside
  `render` beside this same control — and the readings are at
  `instrumentOutOfCalibration`, along with the scope of what they cover: that phase's
  source is `frameAt: () => null`, so its frames carry `burn` and no GL traffic, and the
  readings are evidence about synchronous cost specifically. Deferred cost — a GC pause,
  driver-side backpressure landing inside a later spin — is carried by the serialisation
  argument rather than by the experiment. `test/budget-control.test.ts` reproduces both
  red runs as withheld and constructs the counter-case from them by substituting the
  control's _health_ only, each run keeping its own spin count; the over-budget share is
  proved separately, against a reachable regression at a shape a real run produced. Both
  properties are broken on disk by `npm run verify:mutation`:
  `the-over-budget-share-is-never-compared` deletes the share comparison in
  `expectTracksControl`, and `a-dead-control-withholds-the-verdict` widens
  `instrumentOutOfCalibration`'s keying so a control that measured nothing withholds
  instead of being judged.
  **A stalled control cannot be reproduced on this machine, so do not try to get there
  with load.** `scripts/gate-load.mjs` at 20 and at 64 spinners (load average 18.5 on 18
  cores) left the control at 8.40 ms both times, unchanged from quiet: macOS keeps
  scheduling the Electron renderer whatever else is asked of the box, which is precisely
  why the paravirtual runner's 22–26 ms spins are a statement about that host. To exercise
  the withheld branch end to end, widen the control's own target for one run
  (`new EnvironmentControl(FRAME_BUDGET_MS * 1.5, CONTROL_PERIOD_MS)` in `harness.ts`) and
  revert it — the same shape as overriding `gpuCost` for the deferred branch below.
  **That recipe silently disarms one assertion, so a widened run is not a run of
  everything.** The gate constructs **one** `EnvironmentControl` and re-arms it for scrub,
  play _and_ the slow-compositor phase, so widening its target widens that phase's control
  too. `environmentSustainsBudget(slow.control, FRAME_BUDGET_MS)` is then deterministically
  false, `test/phase6-gate.test.ts` takes the else branch, and the slowed path's
  control-of-the-control — `expect(() => expectTracksControl(slowEvidence)).toThrow(…)` —
  is **reported as a shortfall rather than required**. §8's own absolute pair against the
  slowed path (`slow.frames.overBudget > 0`, `slow.frames.maxMs > FRAME_BUDGET_MS`) runs
  unconditionally either way, so nothing goes unmeasured — but on an **ordinary,
  unwidened** run on this machine that control reads 8.40 ms,
  `environmentSustainsBudget` is true and the required throw does fire. A widened run and
  an ordinary run **together** cover both branches, and neither alone does. The shape that
  would cover both in one run is giving the slow-compositor phase an `EnvironmentControl`
  of its own; it is **not attempted** — that is a code change to a sensitive harness, what
  was found was this record overclaiming rather than the harness being wrong, and this is a
  documentation commit — and is written down so the coupling is inherited rather than
  rediscovered.
  **That has been run, on `e7f06a3`**, and the head is named because it is what makes this
  falsifiable later: a reader on a diverged head can see the observation may no longer
  apply, where an undated "it works" cannot go stale visibly. Observed — the banner
  printed; both phases reported `NOT JUDGED`, scrub over 20 spins and play over 125, each
  naming the control's own overrun; and vitest reported `1 skipped` with the reason
  `§8's frame budget was NOT JUDGED and this is not a pass…`, not a pass. Every non-timing
  assertion ran and held first, which is what the `skip()` being last is for — with the one
  exception the coupling above forces: in that run the slowed path's own
  control-of-the-control was reported as a shortfall rather than required, while §8's
  absolute pair against the slowed path held.
  **What it establishes and what it does not**, because the difference is the whole value
  of the record: it exercises the _reporting_ path — `withheldJudgement`, the banner and
  the `skip()` — against a control that genuinely exceeded the budget, so
  `instrumentOutOfCalibration` fired for its real reason. It does **not** reproduce a
  stalled host: the spin was long because it was asked for more work, not because the
  scheduler took the thread away. Everything downstream of `control.maxMs` is identical on
  both, and nothing upstream of it is exercised here.
  **Two facts no file owns.** The deferred branch **cannot be exercised end to end on
  Apple Silicon**: `--disable-accelerated-video-decode` flips the decode probe, but
  ANGLE-Metal binds decoded frames as IOSurfaces whatever the decode preference, and four
  levers up to `use-angle swiftshader` failed to reproduce the runner's frame — do not go
  looking for a fifth; override the harness's reported `gpuCost` medians for one run
  instead. And the surviving gap under sustained load, where the tracking ceiling rises
  with the regression it judges and the host's own over-budget share outruns the
  regression's, is filed as `loom-gate-exposure-matched-control` — **do not close it with a
  factor on the share**, which is that same circularity one level up.
  **Load this gate's box with `scripts/gate-load.mjs` and never with an ad-hoc
  `while :; do :; done &`.** Every reading taken under load needs the box saturated on
  purpose, and the ad-hoc version of that once left 42 orphaned spinners pinning this
  shared machine for nine hours and put a fabricated flake rate in this file — which the
  re-measurement, nine consecutive quiet runs and nine passes, retracted. A `trap` does not
  cover it, because the failure case _is_ the parent dying before its cleanup runs; the
  helper's spinners each carry their own deadline and exit on it unwatched.
- **Test files run one at a time, and anything measuring the machine measures it
  twice.** Three gates time the box they run on: the phase-5 sampler's 120 Hz, phase
  6's worst-frame budget, and phase 3's twenty-minute A/V sync, which saturates the
  machine for the better part of a minute. `vitest.config.ts` sets
  `fileParallelism: false` so they cannot measure each other. The other half is
  `packages/sampler/test/rate-control.ts`: a rate is only comparable to a control
  measured **across the same window**, never before or after it — the same no-op timer
  has reported 25.4 Hz beside one run and 80.7 Hz beside the next, and CI once failed
  a sampler handed 44 Hz against a control that found 69.5 Hz in a lull moments later.
  The same rule holds **one level out, in the workflow**, and was being broken there
  while it was kept here: `push: ['**']` beside `pull_request` started two full runs of
  `ci.yml` per commit on any branch with an open PR, in two different `concurrency`
  groups (`refs/heads/<branch>` and `refs/pull/<n>/merge`), so neither cancelled the
  other and both ran the phase-6 gate simultaneously against one shared pool of macOS
  hosts. Both runs of d26016c overlapped for the whole of both gates and each reported
  one frame over budget — 21.3 ms and 123.6 ms against p99s of 3.5 ms and 6.2 ms. A
  branch is now covered by its `pull_request` run alone (`synchronize` fires on every
  push, and it measures the merge result); `push` is kept for `main`. The last overlap
  was inside one run: `ci.yml`'s own `mutation` job started at the same instant as
  `verify` and spends its life launching Electron — the crash gate ten times, A/V sync,
  the camera unplug, both golden gates — against the same shared pool of macOS hosts.
  It now carries `needs: verify`. Measured on 2026-08-06: it entered
  `npm run verify:mutation` 17 s before the phase-6 gate's window and the gate reported
  one frame at 29.10 ms, against a p99 of 1.80 ms and a 2.20 ms worst frame on the run
  before it, with the gate's own pure-arithmetic host control stretched from 8.50 ms to
  11.40 ms in those same frames. A second reading of the same overlap, run 31074470239,
  shows it is not only a CPU effect: there the **GPU** composite came back at 18.08 ms
  median scrubbing and 22.97 ms playing against 2.37–2.48 ms on three previous runs of
  the same gate on the same runner class, while the CPU frame body stayed inside §8's
  budget — and what failed was not a time but the picture, one playback readback
  holding an all-dark frame-code band between two correct ones with no miss and no seek
  in that phase. Serialising also costs nothing that was worth having: a mutation proof
  over a red tree is vacuous, because `mutation-check.mjs` reads a non-zero exit as
  "caught". **Never add a second macOS job that runs concurrently with `verify`**:
  these three gates cannot tell a busy host apart from the defect they exist to catch,
  and a job we start on purpose is a busy host we chose.
- **An annotation pass must not blend the destination alpha, and `half` is a reserved
  word.** The first is load-bearing: the annotation passes run over a target the screen
  pass wrote opaque, and an ordinary `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` also
  blends _alpha_, leaving `1 − a + a²` wherever a span is semi-transparent. That is
  invisible on screen and a per-pixel difference the moment one path reads the
  framebuffer and the other reads a canvas that forces alpha to 1 — a §4.5 divergence
  living entirely in a channel nobody looks at. `blendFuncSeparate(SRC_ALPHA,
ONE_MINUS_SRC_ALPHA, ZERO, ONE)` is the fix and the golden gate is what found it. The
  second is a two-minute trap worth not paying twice: `half` (with `float`, `int`,
  `sampler` and friends) is reserved in GLSL ES 3.00, so `vec2 half = u_box.zw;` fails
  to compile with _"Illegal use of reserved word"_ on ANGLE and nowhere in the JS.
- **A lost WebGL context is silent, and reads as data.** Every GL call becomes a
  no-op, `getParameter` answers `null`, and `readPixels` leaves the caller's buffer
  untouched — so a reused scratch array keeps the last picture it really read and
  `Compositor.readPixels`'s in-place flip turns every other reading upside down. That
  is how one GitHub macOS runner ("Apple Paravirtual device") produced a set of
  plausible-looking wrong frame numbers and a control that could not see its own
  black, on a commit whose other run of the same SHA passed. `readPixels` now throws
  instead (an exporter would otherwise encode fabricated frames), the gate harness
  aborts the run at the first sign of it, and `test/phase6-gate.test.ts` re-launches
  **only** for that — never for a run that measured and came out over budget. Both
  halves are pinned by tests rather than by comment:
  `packages/compositor/test/context-loss.test.ts` (with a control proving the fake
  really does model the silent no-op) and `test/relaunch-policy.test.ts`, which
  enumerates every bad-run shape and requires that none of them earns a second launch.
  A retry around an acceptance gate is how a real defect gets to look like weather;
  it stays defensible only while it stays this narrow. The other half of "silent" is
  that the event carries **no reason**, and one of the reasons was ours to remove:
  Chromium's GPU watchdog kills the GPU process when a call has not come back inside
  its timeout, and every context in it goes too. In a browser that is a tab staying
  responsive; here it is a slow host pre-empting the measurement that exists to catch
  slowness — CI lost the context on both launches of one job while the same commit
  passed in another, on runners that vary by 5× (a 24.5 ms warmup frame and a 4.1 ms
  composite on one, 4.7 ms and 1.9 ms on another). `test/gate/main.ts` therefore runs
  with `--disable-gpu-watchdog`, so a frame that takes too long arrives as a number
  over budget rather than as a run that measured nothing, and notes
  `child-process-gone` so a context that goes anyway names what died. The gate prints
  its own log on a bad run for the same reason: how far it got is the difference
  between a host that took the instrument away and a defect that always will.
  **That note has since earned its keep, and it moved `GATE_ATTEMPTS` from two to
  three.** The mechanism it named — `abnormal-exit (exit 8704)`, Chromium's GPU process
  _exiting_ on a context loss rather than the watchdog killing it — makes a launch that
  starts seconds after it a second reading of one host in one state rather than the
  independent sample "a second loss in a row" was read as. The count lives beside the
  predicate in `test/gate/relaunch.ts`, whose docblock owns the derivation and the
  measurement it rests on, and `test/relaunch-policy.test.ts` pins the value — so raising
  it again fails a test and costs a measured demonstration of the same kind rather than a
  nudge in a gate file. The predicate did not move and must not: `shouldRelaunch` is
  `report.contextLost` and nothing else, and three consecutive losses still fail the gate.
- **A pre-empted renderer is not a slow frame, and the instrument cannot tell them
  apart.** The frame budget is `performance.now()` around the frame body, so anything
  the OS scheduler takes away lands on whichever frame it interrupted. Chromium
  deprioritises a renderer it believes nobody is looking at — and on a CI runner there
  is no display to be visible on, so the gate's window qualifies and its process drops
  to background priority on a shared runner. Setting `backgroundThrottling: false` in
  `webPreferences` does not cover that; it is Blink's timer and rAF throttling, not the
  priority the OS scheduler reads. `test/gate/main.ts` therefore also runs with
  `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows` and
  `--disable-background-timer-throttling`. How it was identified, and the shape to look
  for if it comes back: time the frame body segment by segment and the pause turns up
  **inside calls that cannot spend a millisecond** — 10–20 ms readings inside
  `drawArrays`, inside `present`, and inside `resolve()` (0.2 µs of work, pinned by
  `packages/edl/test/hot-path.test.ts`). That last one is phase 7's: the measurement was
  taken on `fm/loom-p7`, and on a branch before it the equivalent segment is the four
  state assignments `PreviewLoop` makes where phase 7 calls `resolve(compiled, t)`. CI
  reported the same event on a slower host as one 177 ms frame against a p99 of 7.9 ms,
  on the commit whose other run of that SHA passed. Thirty runs with hardware decode disabled — so every frame carries CI's 30 MB
  CPU-backed upload — then held 2.6 ms worst with no run short of a frame, against
  three pauses in thirty-odd runs of the same arrangement without them. None of this
  makes anything faster or measures anything different: work still arrives as a number
  over budget, on the worst frame, with no allowance.
- **Test from a signed bundle at least once** before trusting anything permission
  related: in development, TCC is inherited from the terminal (research report §7,
  trap 6). The one way to shed that inheritance in a test is
  `loom-input-sampler spawn-disclaimed`, which makes the child answer for its own code
  identity — that is how the phase-5 gate exercises "Accessibility revoked" on a
  machine whose terminal is trusted. For the app itself that is
  `npm run verify:permissions`; § Phase 2 gate status below is its standing record.
- **A permission that fails silently must be reported, never inferred.** Clicks need
  Accessibility, and without it `CGEventTapCreate` has been seen both to return NULL
  and to return a port that reports success and never fires — so the sampler gates on
  `AXIsProcessTrusted()` _and_ `CGEventTapIsEnabled`, watches for
  `kCGEventTapDisabledBy*`, and re-checks at 1 Hz. Downstream, "no clicks happened"
  and "the tap was dead" are kept apart by `capability.count` being `null` rather than
  `0`, and by `clicks.ndjson` existing only once the tap is live. Phase 10's auto-zoom
  is the consumer that breaks silently if either collapses.
- **Never integrate the spring at frame rate — anywhere, including a preview fast
  path.** Report §3.4 measured the alternative at 82.6 px of divergence at 3456 wide,
  which is a 60 fps preview and a 30 fps export framing the shot differently and one
  dropped preview frame shifting it permanently. The grid is 8 ms, the solution is
  **analytic** (three closed forms, one per damping regime — not Euler, not RK4), and
  `verify:mutation` breaks both on disk and requires `packages/edl/test/` to notice.
  The tail past the last key runs `16/decay`, not §6.3's settling rule of `4`: what
  matters there is the _permanent_ error, and a critically damped response still holds
  3×10⁻³ of its step at `8/(ζω₀)` — ten pixels, forever.
- **`resolve` hands back the same `ResolvedState` object every call.** That is how
  §3.6 gets "no allocation", and it means a caller that stores one is storing a
  reference to next frame's state. `cloneResolvedState` is the way out. Measured at
  0.08 µs for an identity timeline and 0.3 µs for a 30-minute, 3000-key one, against
  §8's 16.67 ms frame — four orders under it, and flat in the length of the recording,
  which is the half that matters. Not against a phase-6 CI reading: that gate
  certifies the budget on target hardware, and its CI frame is a different workload.
- **Track order is stacking order, so an inverse op has to preserve it.** `track.add`
  and `span.set` carry an optional `at` for exactly that: undoing the removal of a
  middle track by appending leaves a valid document and a wrong picture, which is the
  hardest kind of bug to see, and both refuse an out-of-range index rather than
  appending quietly.
- **An undo has to survive `JSON.stringify`, so `track.patch` removes by name.** The
  inverse of adding a `generator` block is a document _without_ one, and the obvious
  way to say that — a key holding `undefined` — is dropped by `JSON.stringify`: it
  applies in the editor and reaches `edit.journal.ndjson` as `"patch":{}`, so a crash
  before the 250 ms snapshot replays the undo as a no-op and the key comes back.
  Removal is `patch.remove`, a list of key names, restricted to `Track`'s _optional_
  fields (`REMOVABLE_TRACK_KEYS`, derived from the type so a new optional field is a
  compile error rather than a silent gap) — and `applyOpInPlace` refuses a patch value
  of `undefined` outright, so there is only one representation to get right.
- **A window that declares `focusable: false` must not be focused by the thing that
  opens it.** `WindowRegistry.reveal` is where that lives, and it covers the
  countdown as well as the drawing overlay. The registry used to call
  `window.focus()` unconditionally, which would undo the overlay's whole
  non-activating arrangement from the outside, on a line nobody reading the §1.2
  table would think to check.
- **A transparent role needs `backgroundColor: '#00000000'` of its own.** The
  registry paints every window `groundColor()` so a first paint is never a white
  flash; on a full-screen transparent window that is a sheet of paper over the
  desktop.
- **Two renderers draw one stroke, and only one of them is on §4.5's list.** The
  overlay's live canvas is a 2D `CanvasRenderingContext2D` and the editor's is the
  WebGL2 stroke pass. §4.5's must-be-identical rule is about _preview and export_,
  which are both the second one; the live pen has to be in the overlay because that
  is what the presenter is looking at. They are held to agreeing on the _shape_ of a
  line — round joins, round caps, `strokeWidth` as a fraction of the frame width —
  and nothing tighter.
- **An empty `activeRanges` means never active, and "always" is `[[0, 1e9]]`** — the
  idiom §2.6's reference document uses. That is the literal reading of §3.5's "0
  outside activeRanges", and it is what lets a track be parked without deleting it.
- **A lost GL context is silent, and an export must refuse rather than encode through
  it.** Every GL call becomes a no-op and the canvas keeps its last contents, so the
  preview holding a stale picture for a tick (§4.3) becomes, in an export, black or
  stale frames handed to `new VideoFrame(canvas)` and written into a file that then
  passes all five of §7.5's checks and is recorded verified-good. That is the one
  failure the captain's retention decision cannot survive: phase 9 deletes the user's
  **only** copy of the raw sources on the strength of that record.
  `Compositor.readPixels` already refuses for the same reason; the export path never
  calls it, so `ExportRenderLoop` consults `ExportCompositor.contextLost` before and
  after **every** composite and fails with `ExportContextLostError`. The check is
  **sticky** — a context never recovers, and a loss landing between two reads must not
  slip through a later one that happens to read healthy. Pinned by
  `export-encodes-through-a-lost-context` and by a control proving the fake really
  models the silent no-op. Note the golden gate's relaunch predicate does **not** cover
  this: that protects the _gate's measurement_ from a runner whose GPU process dies,
  and a real user has no second attempt and no comparator.
- **The export encoder runs `latencyMode: 'realtime'`, and that is not a leftover.**
  Quality mode lets VideoToolbox reorder frames; a reordered stream needs a `ctts`
  table, `FastStartWriter` writes none, and the failure mode is a file that presents
  its frames in the wrong order silently. So realtime mode is what makes decode order
  and presentation order the same thing — the assumption the muxer is built on — and
  `addVideoSample` refuses a backwards timestamp rather than writing a table that
  cannot express it. §5.2 already states the rate-control trade this project accepts.
- **The export's video timescale is `fps * 1000`, so every CFR frame is 1000 units.**
  A microsecond timescale would put 33333.333 µs frames in a 30 fps file and
  accumulate a millisecond every hundred seconds. The stream-copy path is the
  exception and uses microseconds, because there it is carrying the _source's_ timings
  and `DemuxIndex` answers in µs whatever timescale the part was written with.
- **There are two golden-frame gates and neither subsumes the other.**
  `test/phase8-gate.test.ts` (harness in `test/export-golden/`) drives the shipping
  `PreviewLoop` and `ExportRenderLoop` over a real decoded VFR stream, in **two**
  WebGL2 contexts with **two** readers, and then decodes the finished MP4 to check the
  pictures reached the file. Phase 11's `test/phase11-golden.test.ts` (harness in
  `test/golden/`) checks the other axis — that annotations are not vacuous — over one
  painted frame. **Both now drive the same export path**: `ExportRenderLoop.renderAt`,
  which takes a timeline instant rather than a frame number precisely so a golden
  harness need not round §4.5's timestamps onto a CFR grid. Phase 11 carried a
  documented two-line stand-in there until phase 8 landed; folding it on changed no
  assertion, because they were written against that seam from the start. They still
  declare separate window globals — `window.exportGolden` and `window.golden` —
  because both harnesses are in one TypeScript program and one name cannot hold two
  shapes.
  **What keeps phase 11 on the real path is a mutation, not a comment.** Every other
  reading it takes is a reading of pixels, and a stand-in produces exactly the same
  pixels — which is what made the stand-in viable and what would make a slide back to
  one silent. So `phase11-golden-reaches-the-export-loop` in `npm run verify:mutation`
  pins `renderAt` at `t = 0` and requires phase 11 to go red, and the gate reads
  `ExportRenderLoop`'s own `framesRendered`/`drawnFrames`/`heldFrames` out of the
  report — the one thing in it a stand-in cannot produce.
- **The phase-8 gate has three outcomes, and the third is not a pass.** Where **every**
  launch had its WebGL contexts taken away before anything was compared, §4.5's
  per-pixel zero was neither met nor missed — it was not measured — so the run reports
  **skipped** under a `NOT JUDGED` banner rather than failing on
  `expect(report.contextLost).toBe(false)` over a report reading `samples n=0`,
  `identity max delta=-1`, `export did not run`. `instrumentOutOfCalibration` in
  `test/export-golden/verdict.ts` is the condition, and it borrows phase 6's vocabulary
  on purpose while staying a separate, differently-typed function for the reason
  `relaunch.ts` gives about the two gates' relaunch predicates.
  **`shouldRelaunchGolden` is untouched and still `report.contextLost` alone, and
  `GATE_ATTEMPTS` is still two** — more retries around a crash is the move this project
  keeps refusing.
  **The branch runs before every assertion, which is the opposite of phase 6's ordering
  and needs its own safety.** Phase 6's `skip()` is the last statement in its test, so a
  withheld verdict is structurally unable to suppress a real one; here a lost context
  empties the report, so everything below would fail on the absence and the branch has to
  come first. The safety is therefore the predicate's: `readingsTaken` enumerates every
  reading _of the subject_ a `GoldenReport` can carry, field by field, and **one of them
  refuses to withhold** — `mayDeleteSources`'s discipline applied to a verdict instead of
  a deletion. `fixture` and `environment` are excluded from it deliberately — they
  describe the input and the host, not the subject — and the reason is at `readingsTaken`
  itself; it is not a list to finish. `test/golden-verdict.test.ts` is the fence, `test/relaunch-policy.test.ts`'s
  sibling; three `verdict.ts` entries in `npm run verify:mutation` break it on disk.
  **The hazard it would be unsound without is a defect in the export path provoking the
  context loss itself**, and it is ruled out structurally rather than statistically:
  `Compositor` allocates in its constructor and nowhere else, `GpuTimer` reuses one
  query, `ExportRenderLoop.renderAt` allocates nothing, `VideoExportEncoder.encode`
  closes its `new VideoFrame(canvas)` in a `finally` in the same statement, and a decode
  leak trips `FrameLedger` in JavaScript on the _first_ frame past the ring cap. The
  argument, the three CI readings that agree with it, and what would re-open it are at
  `instrumentOutOfCalibration`'s docblock — do not re-derive them here.
  **All five outcomes were observed end to end** against the real gate on 2026-08-06
  (deliberate injections, reverted): agree → pass; disagree → **fail**; lost once then
  agree → pass; lost once then disagree → **fail**; lost on both launches → skipped with
  the banner. The recipe is in the PR; the point of recording it is that a branch on
  which an acceptance gate does not go red is worth watching go red first.
  **And `npm run verify:mutation` has the same third outcome, because it had to.** A gate
  that withholds exits 0, exactly as one that ran and noticed nothing does, so the first
  run of the mutation proof after this branch read a skipped phase-8 gate as `SURVIVED`
  and reported a hole in a gate that had never been given an instrument (CI run
  31099311259 — the same run's `verify` job skipped that gate for the same lost contexts).
  `runTests` now reads vitest's own per-test statuses: a file where **every** test
  withheld is `NO VERDICT`, which is neither proof nor hole and does not fail the run,
  and a mutation is only `no verdict` where no file judged it — one gate that judged and
  did not notice is still a hole and still exits non-zero. Do not widen that to "a skip
  happened": `av-sync.test.ts` and `recorder-events.test.ts` skip single tests routinely
  on a host without `afconvert` or the Accessibility grant, and counting those would
  quietly stop proving the mutations they carry.
- **Phase 8's `delta 0` covers two of §4.5's four "must be identical" rows, and says
  so.** Frame selection and the zoom state are each perturbed by a control that must go
  non-zero; **the webcam bubble and the cursor are not exercised at all**, because
  neither has a compositor pass — `Compositor.render` throws when handed a `webcam` or
  a `cursor` frame and `ExportRenderLoop`'s `CompositorFrames` is
  `{ screen: null, textAtlas: null }`, which carries neither key —
  so both paths draw nothing and agreeing about nothing is not evidence. The split is
  `COVERAGE` in `test/export-golden/harness.ts`, printed on every run including a
  passing one, and it is kept honest by a **tripwire**: `probeCoverage` hands the real
  compositor a `webcam` frame and a `cursor` frame and requires it to refuse both —
  **with the refusal that names the missing pass**, not merely with a throw, because
  `render` calls `#assertLive()` first and a dead context would otherwise report the
  passes absent for a reason that has nothing to do with them. It runs mid-run on a
  live context, against a `render({ screen: null })` control that must not throw.
  Building either pass makes the gate go red, in the same change that makes the
  coverage list wrong. Do not "fix" that by deleting the assertion; extend the gate to
  perturb the row instead.
- **An export draws annotation shapes and redactions with no export-side wiring;
  annotation _text_ needs one object handed across, and half of that is now in place.**
  `Compositor.render` takes annotations off the `ResolvedState` both loops already
  compute, so blur, mask and the four shapes reach an export for free. Glyphs are the
  exception: they need a `TextAtlas` on `CompositorFrames`, and a `text` span with no
  atlas is skipped and counted (`AnnotationPass.textSpansWithoutAtlas`) rather than
  refused — `PreviewLoop` reports that count through `onError` and the export loop does
  not read it. **`ExportRenderLoop` now takes a `textAtlas` option** — the seam
  `PreviewLoopOptions.textAtlas`'s docstring always assumed and nothing could satisfy —
  and phase 11's golden gate hands both paths the same object, so §4.5's per-pixel zero
  now covers glyphs. **What is still missing is the export _window_ building one**:
  `apps/renderer/src/export/main.ts` rasterises nothing, so a real export job still
  passes no atlas. Nothing authors an annotation today — the editor shell has no
  annotation tools, and they are `loom-p15`'s — so whatever ships the first one has to
  give `ExportSession`'s window the preview's atlas and pass it through that option.
  `the-export-path-draws-text-from-no-atlas` in `npm run verify:mutation` guards the
  half that exists.

## Carried forward: four closed, six still open, one from phase 2 and one from the event logs

Phases 1, 3, 4 and 8 shipped nine things **unverified**, not verified-and-passing, as
obligations on phase 2's signed-bundle gate. Three are now closed on real measurements
from a granted, signed bundle; six are not, and **phase 2's harness does not cover
them** — its only audio check is `microphone-revocation`, which is about a grant being
withdrawn rather than about any of these, and it has no camera and no export checks at
all, so nothing here has looked at them. Until something does, no report may describe
them as working. Phase 2 then left one of its own (item 10, still open) and phase 10
one of its own (item 11, now closed on real measurements — see the click-capture
section below).

**Closed** (see the gate status below for the figures):

1. ~~`desktopCapturer` screen enumeration.~~
2. ~~`setDisplayMediaRequestHandler`'s frame authorisation.~~
3. ~~`setContentProtection(true)` keeping the recorder HUD out of captured frames.~~

**Still open, and still nobody's evidence:**

4. **`audio: 'loopback'` reaching a real speaker output**, and whether macOS honours
   the AEC/NS/AGC-off stereo constraints on the track it hands back (research trap 3).
   The code asserts the constraints and records what was actually applied in
   `recording.json`; only a machine with the grant can say what that is.
5. **A real microphone's `startTimeSec`.** The epoch correction is exercised against
   Chromium's own clocks by `--synthetic`, and the residue snapped to zero there — but
   a real device has its own latency, and only a granted run can show it.
6. **A real camera's `startTimeSec`, and its epoch.** `test/phase4-gate.test.ts`
   drives the shipping capture page on a driven clock and a deliberately different
   epoch, so the arithmetic is exercised; what no dev run has seen is what Chromium
   stamps a real `getUserMedia` video track with, or how far a real camera opens
   behind the screen. If that offset is larger than one audio buffer it will not snap,
   and the bubble will be visibly late.
7. **A physical unplug.** The gate's device loss is `ended` on a real `EventTarget`
   and its reconnect is a real `devicechange` — the events macOS delivers — but
   nothing has yet pulled a cable. What that would prove beyond the gate is the
   platform's own behaviour: whether `ended` fires at all for the built-in camera,
   how long `getUserMedia` refuses a device that has just re-enumerated, and whether
   the same `deviceId` really comes back.
8. **The clipboard, from a signed bundle.** Measured by hand on this machine with
   Electron 43 — writing the `NSFilenamesPboardType` plist makes
   `osascript -e 'clipboard info'` report `«class furl»` and
   `the clipboard as «class furl»` return the file, which is a file reference and not
   text. That is the mechanism captain decision 9 requires. What no run has watched is
   the paste landing in Slack, Messages or Mail as a video, and a pasteboard is global
   state so no automated test writes to it: `export-clipboard.test.ts` asserts the
   payload's _content_ and injects the one platform call.
9. **An export of a recording with real audio.** `test/phase8-gate.test.ts` exports
   video end to end and `packages/mux/test/export-movie.test.ts` muxes a real AAC
   track from `afconvert` — but no run has taken a `.loomrec` with a mic _and_ a
   system track through `AudioSourceTrack`'s decode-mix-resample path and listened to
   the result. The arithmetic each step rests on is covered (`packages/format/test/
sync.test.ts`, and `verify:mutation`'s four audio mutations); the composition of
   them at length is not.

None of the six is answered by an ordinary `npm run verify:permissions`: the two audio
ones need `node scripts/smoke-capture.mjs` without `--synthetic` on a granted machine,
the two camera ones need a real camera and a real cable, and the two export ones need a
paste into a real app and a `.loomrec` with real audio taken through the export path.
Do not read the gate's green rows as covering them.

What _is_ covered without the grant: `node scripts/smoke-capture.mjs --synthetic`
replaces only the _source acquisition_ — `getDisplayMedia` and `getUserMedia` — in the
real capture page, and drives the shipped `MediaStreamTrackProcessor` →
`VideoEncoder`/`AudioEncoder` → encoded-chunk IPC → `ProjectStore` → fragmented MP4 and
M4A → finalize path end to end, on Chromium's real capture clocks. Without
`--synthetic` the script refuses to start when the grant is missing and names what to
grant, rather than failing three layers down in `desktopCapturer` with "Failed to get
sources". Run it after any change to capture: it is the only thing that watches the
two clocks — three, now that it reports the cursor log's sample count and whether the
click tap was live — and it is what caught both of phase 3's real bugs.

**And one phase 2 opened, now closed in code and open on hardware:**

10. ~~**A revoked Microphone is recorded as a lost device.**~~ Fixed — see § A revoked
    Microphone, below. What is **still owed** is the same kind of evidence items 4–9 are
    owed: nobody has watched a real grant move under a signed bundle.
    `node scripts/verify-permissions.mjs --mic-revocation` is the check that would, and it has
    **never been run**, because running it repackages and re-signs the bundle and that
    costs the captain his grants. Its row therefore reports `skipped`, which is the
    honest answer and not a pass.

## A revoked Microphone, and why it is not the webcam path

A device that vanished may come back and is worth waiting for; a permission the user
withdrew will not come back without their action. The app was reporting the second as
the first. The captain settled it in `data/loom-scope/decision-mic-revocation.md`:
**"stop recording and tell the user to re-grant"** — a deliberate divergence from
§7.3's own _"Microphone revoked → keep recording screen and system audio"_, on grounds
§7.3 does not consider. Say so when you touch this; do not quietly re-align with the
report.

The two paths are now **explicit**, not implicit, and that is the point of the shape:

- The capture page reports the **observation** and never the cause —
  `AudioSink.ended` → `capture.audioEnded`, sent the moment a track stops rather than
  in the end report. `reportOf` no longer names an `endReason` at all; it used to say
  `device-lost` for every track that ended, which _was_ the bug.
- Main decides, in `audioEndReasonFor` (`recorder/session.ts`), the audio counterpart
  of `endReasonFor` and the only place the distinction is drawn. Reading TCC is main's
  alone (`apps/main/src/permissions.ts`'s header), so the renderer structurally cannot
  get this wrong again.
- **The evidence is perishable.** What TCC says at the end of a twenty-minute
  recording is not what it said at minute two, so the answer is decided when the track
  stops and kept in `Active.audioEnd`; finalize only classifies what it has no answer
  for.
- Which grants stop a recording is **data**, not an `if`: `revocationStopsRecording`
  in `packages/permissions/src/kinds.ts`, beside `whenRevokedMidRecording`, the
  sentence every surface renders. Screen and Microphone stop; Camera and Accessibility
  do not (§7.4).
- Stopping is the **ordinary** `stop()`: the capture page flushes, the bundle
  finalizes to `editable` with what it has. Nothing is discarded — decision 5 deletes
  raw sources after an export, so a partial recording thrown away here is gone for
  good.
- The notice is `RecorderStatus.revoked`, not `error`: the recording stopped, it did
  not fail. It lives on the session rather than on `Active` because it has to outlive
  the recording it describes — by the time anyone reads it the recorder is `idle` —
  and `start()` is what clears it.

Covered by `apps/main/test/recorder-session.test.ts` (both controls: a device that
merely went away must _not_ stop the recording, and an encoder failure is not a
revocation), `apps/renderer/test/capture-session.test.ts` (the renderer names no
cause), `test/hud-notice.test.ts` (the notice measured in pixels, with the same
no-fit control §7.4's banner has) and two mutations in `npm run verify:mutation`.
What none of them can establish is on hardware — see carried-forward item 10.

**And one phase 10 opened and closed:**

11. ~~**Post-grant click rate and latency are unmeasured.**~~ Closed. The captain's
    accessibility decision recorded them as unverified and said _"Validate during the
    build"_; phase 2 confirmed the tap was live from a signed bundle but nobody clicked
    during its window. Phase 10 built the instrument — `scripts/record-cursor-corpus.mjs`
    posts clicks with `CGEventPost` stamped from `CLOCK_UPTIME_RAW` and
    `loom-input-sampler.m` stamps every line it emits from the same clock — and
    **measured 2026-08-05 with the grant in place**, across the ten corpus recordings:
    158/158 clicks delivered, latency min 0.177 ms, 0.389 ms as the mean of the
    per-recording medians, 7.711 ms as the mean of their p95s, max 20.520 ms.
    `packages/edl/test/corpus/manifest.json` carries the figures under `clickCapture`
    with `measured: true`, and the phase-10 gate reads that field and fails loudly if a
    future corpus is recorded without the grant. The reading, what the instrument refuses
    to report and why, are in § Post-grant click rate and latency — measured, below.

**And one the event-log wiring opened:**

12. **The cursor log's origin carries the first frame's encode and IPC latency.**
    `RecorderSession` names the recording clock's origin on the helper's clock from a
    paired `process.hrtime`/`CLOCK_UPTIME_RAW` reading and the elapsed time to the
    first screen chunk. That elapsed term is now stamped in `onVideoChunk`, where the
    chunk enters main, so it no longer carries the part-open write — but "arrives in
    main" is still later than "the screen produced it", by that one frame's encode
    plus IPC. The origin is therefore slightly late and every cursor sample slightly
    early. Measured indirectly at 24 ms of total lead-in on a synthetic run; not
    measured directly, because doing so needs the capture renderer's
    `performance.now()` related to main's clock — the same `TrackEpochEstimator`
    problem one process out, and new IPC plus new §5.4 arithmetic rather than a
    constant. Tens of milliseconds against §6.5's 600 ms pre-roll, so it is recorded
    rather than guessed at.
    **The probe bound runs the other way, and is measured.** `readHelperClock` takes
    `after` as `atUs`, which is at or after the instant the helper stamped, so the
    origin is slightly _small_ and samples are labelled _late_ — the opposite sign to
    the encode+IPC term above, so the two partially cancel rather than add. Its bound
    is the full probe width `after - before`, measured over the real
    `dist/native/loom-input-sampler probe` with `process.hrtime.bigint()` exactly as
    `readHelperClock` does. Quiet, n=200: min 14.77 ms, median 16.69 ms, mean 16.92 ms,
    p95 19.33 ms, max 21.67 ms. Under a 20-way `scripts/gate-load.mjs` saturation,
    n=100: min 16.35 ms, median 18.46 ms, mean 18.75 ms, p95 21.12 ms, max 26.46 ms.
    That is the **bound**; the true residual is the strictly smaller post-stamp tail
    (JSON serialisation, one write, process exit), which could not be measured
    directly because `process.hrtime` and the helper's clock do not share an epoch —
    22.78 s apart on this machine, which is the whole reason the pairing exists.
    **No uncertainty threshold is built, and that is a finding rather than a number to
    tune** (the shape §6.5's `minDurationSec` already has here): the worst case is
    under one 30 fps frame and 4.4% of §6.5's 600 ms `preRollSec`, and the distribution
    has no tail to catch — 6.9 ms of spread quiet, 10.1 ms loaded — so a threshold
    could only fire on ordinary loaded recordings and would turn an invisible timing
    error into a missing cursor log, which is the defect this whole path exists to fix.
    **A crash-recovered bundle is the other half:** the logs
    are declared in `recording.json` when sampling starts, so they are discoverable,
    but their counts stay at the zero a provisional document carries — `recoverBundle`
    rebuilds tracks from the frame indices and does not read `events/`.

## Post-grant click rate and latency — measured, and phase 10's item closed

The captain's accessibility decision closed with _"Post-grant event rate and latency
are unmeasured. Validate during the build."_ Phase 2 confirmed the tap was live from a
signed bundle but nobody clicked during its window. **Measured 2026-08-05**, with the
grant in place, across the ten corpus recordings (250 s of wall clock):

|                                        |                                                         |
| -------------------------------------- | ------------------------------------------------------- |
| Clicks posted / observed               | **158 / 158**                                           |
| Delivered fraction                     | **1.0000** — no event was dropped by the tap            |
| Observed rate                          | 0.63 Hz over the corpus; bursts of up to 6 inside 1.5 s |
| Latency, min                           | **0.177 ms**                                            |
| Latency, mean of per-recording medians | **0.389 ms**                                            |
| Latency, mean of per-recording p95     | **7.711 ms**                                            |
| Latency, max                           | **20.520 ms**                                           |

Latency is `CGEventPost` → the tap callback emitting its line, **both stamped from
`clock_gettime_nsec_np(CLOCK_UPTIME_RAW)`** — the driver and `loom-input-sampler.m` use
the same clock, so this is a duration rather than the difference of two clocks. The
sub-millisecond median with a ~20 ms tail is the shape to expect: the tap is on the HID
event stream and the tail is scheduler, not the tap. **For phase 10's consumer this is
comfortably inside anything auto-zoom cares about** — §6.5's smallest interval is
`preRollSec = 0.6 s`, three orders above the median and thirty times the worst sample.

The figures are regenerated by `npm run record:cursor-corpus` and live in
`packages/edl/test/corpus/manifest.json` under `clickCapture`.

**The rule the instrument keeps.** Both the process that **posts** and the process that
**observes** must report `AXIsProcessTrusted()` themselves — the poster on
`cursor-driver.m`'s `hello` line with its own pid, the observer through the sampler's
own capability — and `clickReading` refuses to report a latency unless both say yes,
recording `measured: false` with a reason instead. Never a zero. That is not
belt-and-braces: TCC keys a grant on the exact code identity of the responsible
process, so "the sampler is trusted" does not establish that the driver is, and a grant
that landed on the wrong binary is indistinguishable from no grant (§ Sharp edges —
permissions: two rows with the same identifier already cost a full grant cycle here).
`deliveredFraction` is what would have exposed a half-granted run: a poster that cannot
post and an observer that can see would report 0 / N, not a latency.

## Permissions and first run, in one paragraph

The four grants the app asks for — Screen Recording, Camera, Microphone,
Accessibility — are modelled in `packages/permissions` (pure: what each is for, what
breaks without it, which System Settings pane turns it on) and probed in
`apps/main/src/permissions.ts`, **which owns the `systemPreferences` boundary** — its
header states the scope exactly, and `eslint.config.mjs` enforces it. The captain
settled the flow
(`data/loom-scope/decision-accessibility-clicks.md`): ask up front, all four together,
explain each, and a user who declines the three optional ones still gets a working
recorder. Accessibility is read from `AXIsProcessTrusted()`
(`isTrustedAccessibilityClient(false)` — **`false`, or a status check becomes a dialog**)
and cross-checked against a live event tap via `@loom/sampler`'s `probeInput`; TCC's
word alone renders as _granted · unverified_, never as a tick, because the click API
succeeds without the permission and then silently delivers nothing.

**The rule that makes any of this worth reading: a `granted` only counts if macOS was
talking about _us_.** A dev binary inherits its launching terminal's grants (research
§7, trap 6 — measured again on this machine: an unpackaged run reports
`screen/camera/microphone = granted` with `ppid` of a shell). So every
`PermissionReport` carries `provenance`, `isTrustworthy()` is the one place that rule
lives, and `sealReport()` in `apps/main/src/verify/checks.ts` rewrites every `pass` to
`untrusted` when it fails. Nothing downstream can opt out.

## Phase 2 gate status — three obligations closed on real measurements

`npm run verify:permissions` packages the app, gives it the frozen identity, launches
it through LaunchServices and runs the checks from inside the real bundle. Last run
2026-08-05, ad-hoc signed, with the captain's grants in place: `packaged: true`,
`responsibleForSelf: true`, so `sealReport` downgraded nothing. The run's own outcome
is `incomplete` rather than `verified`, because `verified` needs every check to pass
and the click row is `skipped`. The table's last **two** rows were added afterwards and
have not been run at all — the figures above are from the 2026-08-05 bundle and say
nothing about either of them.

| Check                        | Status      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle-identity`            | **pass**    | Packaged, launched by launchd, signing as the frozen id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `frame-authorisation`        | **pass**    | A non-capture window asking `getDisplayMedia` is refused (`AbortError`) by the installed handler. Needs no grant — refusal happens before TCC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `screen-enumeration`         | **pass**    | One screen source, with a `display_id` and a thumbnail carrying a real picture rather than the black rectangle a denied grant returns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `content-protection`         | **pass**    | Control window showed the marker across **99.3%** of its rectangle; the protected HUD showed it across **0.0%**. §11's assumption, finally watched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `accessibility-clicks`       | **skipped** | Tap confirmed live (`tapEnabled: true` under the granted bundle), and nothing clicked in this run's window, so it measured no rate. Rate and latency were deferred to phase 10 by captain decision — measured there; see § Post-grant click rate and latency.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `microphone-revocation`      | **skipped** | Added after that run and **never executed**: it needs `--mic-revocation` and a person switching Microphone off mid-recording, and running the harness at all repackages and re-signs the bundle, which voids the captain's grants. See carried-forward item 10.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `overlay-content-protection` | **skipped** | Phase 12's, added after that run and **never executed**. The check is written — five readings and phase 2's own thresholds, moved out of `test/phase12-overlay.test.ts` because it needs the Screen Recording grant to look — and its control window is what would make its result mean anything: the protected overlay's absence counts only once the control has shown the marker. Running it at all repackages and re-signs the bundle, which voids the captain's grants, so it awaits the project's single signed-bundle pass. The figures in § The live drawing overlay are from an unpackaged dev run of the vitest gate it replaced, not from this check. |

The `content-protection` row is the one worth understanding. "The marker is absent from
the HUD's rectangle" passes just as well when the capture is black, the coordinates are
wrong, or the window never painted — so a second window, same page, same size,
`setContentProtection` **not** called, is placed beside it and must show the marker
first. Without that control clearing, the check reports `blocked`, not a pass. Same
discipline as `kill-mid-write.test.ts`'s naive writer.

## Sharp edges — permissions

- **`npm run package` does not sign this app.** With no Developer ID, electron-builder
  skips signing and leaves Electron's own linker-signed stub: `Identifier=Electron`,
  Info.plist _not bound_. macOS would file every grant under "Electron" — the identity
  churn `identity.ts` exists to prevent, arriving through the back door.
  `scripts/verify-permissions.mjs` ad-hoc signs with the frozen identifier and
  entitlements (research §5.3, note 4) and refuses to run if the identifier is wrong.
- **An ad-hoc signature is content-derived, so every rebuild is a new identity.** A
  grant given to one build does not survive `npm run package`. Worse, two bundles with
  the same identifier and different signatures — `release/mac` and `release/mac-arm64`
  — put two rows in System Settings, and granting the wrong one is indistinguishable
  from granting nothing: the app still reports `denied`. That cost a full grant cycle
  here. The runner prefers the host architecture; keep exactly one bundle on disk, and
  if it is rebuilt, the grant has to be given again.
- **`open -a`, never the executable.** Running `Loom Clone.app/Contents/MacOS/…` from a
  shell makes the _shell_ the responsible process, which is the lie the gate is about.
  The harness independently checks `process.ppid === 1`.
- **A captured pixel is in the display's colour space, not sRGB.** The content-protection
  marker is painted sRGB `#FF00FF` and comes back near `(232, 51, 245)` on this
  Display-P3 machine. A tight per-channel match reported 0% _inside the control_ on the
  first run — which is exactly what the control is for. Match the shape of the colour,
  not its coordinates.
- **Refusing a `getDisplayMedia` request logs an `UnhandledPromiseRejectionWarning`**
  ("Video was requested, but no video stream was provided") from Electron's own
  internals, on every refusal. It is the normal, correct path for an unauthorised
  window — not a bug in `provideSource`.
- **Settings writes are serialized in `ProjectStore`, not by their callers.**
  `updateSetup` merges a patch into the document it last read and the read is separated
  from the write by an `fsync`ing rename, so two unqueued patches both read the
  pre-first snapshot and the second drops the first's field. `PermissionManager` keeps
  its own chain on top for a different question — `relaunch()` waits on it, because
  "Open System Settings" and "Relaunch" are adjacent buttons and a quit that beat the
  `accessibilityOpenedAt` write would come back having forgotten it ever asked.
- **`PermissionManager` is built after `store.loadSettings()` resolves**, and reads
  `store.setup` on every probe rather than latching it. Both, because either alone
  turns a persisted Accessibility ask into a fresh-install default on the very launch
  it exists to survive.
- **The click-tap leg of a probe costs a process.** The other three are
  `systemPreferences` reads; this one runs the native sampler, and `refresh()` fires on
  every window focus. It is coalesced and cached for a few seconds, invalidated by
  `axTrusted` changing.
- **`apps/main` still has no filesystem.** The harness prints its JSON report between
  markers on stdout and the runner script saves it, rather than punching the first hole
  in the `node:fs` restriction for a test.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
