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

Section references in source comments (`§2.7`, `§7.1`) point at the architecture report.

## Commands

```bash
npm run build       # esbuild main + preload, vite renderer, clang the sampler -> dist/
npm start           # build, then run the app
npm run dev         # rebuild on change and restart Electron
npm run verify      # typecheck + lint + format:check + test  (what CI runs)
npm test            # vitest
npm run verify:mutation   # break capture and the timeline model 19 ways; each must fail a gate
node scripts/make-sync-fixture.mjs               # regenerate the flash palette (needs ffmpeg)
npm run package     # electron-builder, macOS only
node scripts/seed-fixtures.mjs <root>            # example recordings to look at
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
                   writeAtomic, the edit journal, and `src/sync/` — the A/V
                   alignment arithmetic, which lives here rather than in a package
                   §1.3 does not list because every function in it is a reading of
                   a §2.3 field.  `@loom/format` is PURE (no node, no DOM);
                   `@loom/format/fs` is the filesystem half.
packages/mux/      the fragmented-MP4 writer and the scanner recovery reads it with.
                   `@loom/mux` is PURE; `@loom/mux/fs` owns the file descriptor and,
                   like `@loom/format/fs`, has exactly one caller.
packages/ipc/      the typed main<->renderer contract. Not in the report's §1.3 list;
                   §1.4 requires a shared contract and this is it.
packages/design/   "Pressroom": tokens, type scale, icons, self-hosted fonts.
packages/decode/   the ONE decode path: DemuxIndex, FrameRing, SourceReader.
packages/compositor/  the ONE compositor: WebGL2 `Compositor`, pure draw calls.
packages/edl/      the timeline model (report §3): tracks, channels, keyframes, the
                   two evaluators, `compile`/`resolve`, inverse ops and undo/redo.
                   Owns the SEMANTICS; `@loom/format` owns the `EditDocument` types
                   and their schema. `ResolvedState` lives here and the compositor
                   imports it.
packages/sampler/  the 120 Hz cursor sampler, CGEventTap clicks and cursor bitmaps.
                   `native/` is an Objective-C CLI built by one `clang` call into
                   `dist/native/`; the TypeScript half parses its NDJSON and has no
                   filesystem of its own. Main-process only.
apps/main/         Electron main: WindowRegistry, ProjectStore, RecorderSession,
                   loom:// protocol, IPC.
apps/renderer/     renderer windows. Library, recorder HUD, the hidden capture page
                   (screen in `capture/main.ts`, camera in `capture/webcam.ts`, the
                   two audio tracks in `capture/audio.ts`) and the preview loop
                   today; overlay and editor later.
test/              gates that span more than one package, in a real Electron renderer.
```

A later phase adds `apps/export` beside these (report §1.3). The
report also lists `apps/capture`; the hidden capture page lives in
`apps/renderer/src/capture/` instead, because a window in this repo is a role in
`apps/main/src/windows.ts` plus an entry in `apps/renderer/vite.config.ts`, and a
second renderer app would fork that.

`edl`, `decode` and `compositor` are **pure**: no `node:`, no `electron`, no I/O,
enforced in `eslint.config.mjs`. They reach the world through narrow declared seams —
a `ByteRangeReader`, a `DecoderFactory`, the GL context they are handed, and `edl`'s
`CursorEventStream`/`ClickEventStream`. Wiring a real captured part to `SourceReader`
needs exactly a byte-range reader, a `loom.index/1` sidecar and a
`VideoDecoderConfig`; `source-reader.ts` says so at the top, including the one thing
an adapter has to decide (where the `avcC` description comes from after a restart,
since `recording.json` does not carry it).

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
that loop and nothing in it can fail the recording: §7.3's rule for the microphone
is §7.4's rule for the camera, and `session.ts` draws the same split — the screen is
`REFERENCE_TRACK` and only its failures reach `failActive`.

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
  itself.
- **A track's in-flight state is registered before the first `await`, not after.**
  Opening a part is two awaits long and frames keep arriving across them — that is
  what `MAX_HELD_CHUNKS` is for. If the announcement path and the chunk path can each
  create the state, the announcement finishes by publishing one whose held-chunk
  buffer is empty and every frame that arrived while the file was being created is
  gone: a second of footage per part, silently, with the recording simply starting
  late. `videoTrack()` in `session.ts` is the get-or-create that closes it, and
  `held-frames-dropped-while-a-part-opens` in `npm run verify:mutation` keeps it
  closed.
- **Every track announcement is a read-modify-write of one `recording.json`.** Every
  encoder — three, or four with a camera — announces itself within milliseconds of the
  others, so `RecorderSession` serializes them on `metaChain`; without it the second
  write drops the first track, which is exactly what happened and what the smoke
  script caught.
- **An audio failure never fails a recording.** §7.3: a microphone that is refused,
  vanishes or cannot be encoded costs its own track and nothing else. The screen is
  what the user pressed record for.
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
- **Stop the sampler, then close the project — in that order.** `ProjectStore`'s
  event-log and cursor-bitmap writes require the project to be open and throw
  `UnknownRecordingError` otherwise; they never open a bundle on the caller's behalf,
  because they are driven from the sampler's timers rather than from a user action.
  Closing first therefore turns a straggling write into a loud, typed refusal rather
  than a silent re-open that re-takes the bundle `.lock` and holds a closed recording
  for the rest of the session. `applyOps` is the deliberate exception and still opens
  a closed project: it is a renderer-driven user action, not a background timer.
- **A spawned helper is not asar-aware.** Electron patches `fs` to read through
  `app.asar`; `child_process.spawn` hands the literal path to `uv_spawn`, which does
  not. Anything executable resolved under `dist/` goes through
  `unpackedHelperPath()`, or a packaged build reports the binary missing when it
  shipped correctly.
- **A crash test that does not kill production code proves nothing.** Phase 0 shipped
  one that killed a copy of `writeAtomic`. Both gates now kill the real path, both
  have a control that must fail, and `npm run verify:mutation` breaks the writer on
  disk and requires the tests to notice. Add a mutation when you add a property.
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
- **`prime()` is called ~60×/s and must not disturb decode that is already running.**
  A prime whose range is already requested rides along with the in-flight one rather
  than superseding it, and "the ring does not hold `t`" only means re-seek when the
  ring has moved _past_ `t` or the decoder has gone idle. Getting either wrong turns
  every rendered frame into a seek that discards the decode it just started.
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
  phase is refused them only where the host structurally cannot: no hardware-backed decode
  **and** a per-frame GPU composite above a tenth of §8's whole frame. That branch is not
  a pass. It detects regressions by **rate** — the compositor may miss the budget no
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
  push, and it measures the merge result); `push` is kept for `main`. Before adding a
  second macOS job that runs concurrently with `verify`, note that these three gates
  cannot tell a busy host apart from the defect they exist to catch.
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
  machine whose terminal is trusted. See also the carried-forward obligations below.
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
  0.08 µs for an identity timeline and 0.3 µs for a 30-minute, 3000-key one, against a
  16.67 ms frame the phase-6 gate already spends 89% of on CI.
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
- **An empty `activeRanges` means never active, and "always" is `[[0, 1e9]]`** — the
  idiom §2.6's reference document uses. That is the literal reading of §3.5's "0
  outside activeRanges", and it is what lets a track be parked without deleting it.

## Carried forward to phase 2: seven things no dev run has verified

Phases 1, 3 and 4 shipped with these **unverified**, not verified-and-passing. They
are obligations on phase 2's signed-bundle gate, and until that gate runs, no report
may describe them as working:

1. **`desktopCapturer` screen enumeration.**
2. **`setDisplayMediaRequestHandler`'s frame authorisation** — that the real handler
   hands a source to the capture page and refuses every other frame.
3. **`setContentProtection(true)` actually keeping the recorder HUD out of captured
   frames.** `windows.test.ts` asserts the flag is set on the role; nothing has
   watched the pixels.
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

Why they are open: a machine that has not granted Screen Recording to the _terminal_
cannot run the leg that would prove any of them, and granting it to a dev binary
proves the wrong thing anyway, because a dev build inherits the terminal's TCC (§7,
trap 6) — a pass there would not predict a packaged build.

What _is_ covered without the grant: `node scripts/smoke-capture.mjs --synthetic`
replaces only the _source acquisition_ — `getDisplayMedia` and `getUserMedia` — in the
real capture page, and drives the shipped `MediaStreamTrackProcessor` →
`VideoEncoder`/`AudioEncoder` → encoded-chunk IPC → `ProjectStore` → fragmented MP4 and
M4A → finalize path end to end, on Chromium's real capture clocks. Without
`--synthetic` the script refuses to start when the grant is missing and names what to
grant, rather than failing three layers down in `desktopCapturer` with "Failed to get
sources". Run it after any change to capture: it is the only thing that watches the
two clocks, and it is what caught both of phase 3's real bugs.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
