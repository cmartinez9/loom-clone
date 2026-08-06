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
npm run verify:mutation   # break capture, the timeline model, the generators and
                          # annotations 40 ways; each must fail a gate
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
packages/permissions/  the four macOS grants: what each is for, what breaks without it,
                   which System Settings pane turns it on, and whether an answer can be
                   believed at all. PURE. The probes are in
                   `apps/main/src/permissions.ts`, whose header states which files may
                   call `systemPreferences` and what enforces it.
packages/design/   "Pressroom": tokens, type scale, icons, self-hosted fonts.
packages/decode/   the ONE decode path: DemuxIndex, FrameRing, SourceReader.
packages/compositor/  the ONE compositor: WebGL2 `Compositor`, pure draw calls, plus
                   `AnnotationPass` (blur, mask, arrow, rect, ellipse, highlight,
                   text). `@loom/compositor/raster` is its one impure subpath — the
                   glyph rasteriser, the `@loom/format/fs` bargain applied to a
                   canvas.
packages/edl/      the timeline model (report §3): tracks, channels, keyframes, the
                   two evaluators, `compile`/`resolve`, inverse ops and undo/redo,
                   `src/generators/` — report §6: cursor-follow, auto-zoom-on-click,
                   the §6.6 comfort budget, and §3.5's regenerate and bake — and what
                   an annotation span's channels and style MEAN (`annotations.ts`).
                   Owns the SEMANTICS; `@loom/format` owns the `EditDocument` types
                   and their schema. `ResolvedState` lives here and the compositor
                   imports it. `test/corpus/` is phase 10's ten real recordings.
packages/sampler/  the 120 Hz cursor sampler, CGEventTap clicks and cursor bitmaps.
                   `native/` is an Objective-C CLI built by one `clang` call into
                   `dist/native/`; the TypeScript half parses its NDJSON and has no
                   filesystem of its own. Main-process only.
apps/main/         Electron main: WindowRegistry, ProjectStore, RecorderSession,
                   PermissionManager, loom:// protocol, IPC.
apps/renderer/     renderer windows. First-run setup, library, recorder HUD, the hidden
                   capture page (screen in `capture/main.ts`, camera in
                   `capture/webcam.ts`, the two audio tracks in `capture/audio.ts`)
                   and the preview loop today; overlay and editor later.
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
- **§6.5's "four keyframes per segment" is three when the hold has no length.** A
  cluster of one click has `holdStart === holdEnd`, and §2.6 forbids a repeated `t`.
- **An auto-zoom segment's `activeRanges` runs `4/(ζω₀)` past its last keyframe.**
  §3.5's crossfade is only the no-op it is meant to be where the two sides _agree_ at
  the edge, and at a segment `end` they do not: the last keys say identity but the
  spring is still on its way there, so the window drags the difference to identity over
  `blendMs` and turns a 1.2 s post-roll zoom-out into a 250 ms one. Measured before the
  tail: the worst pan acceleration in **nine of ten** real recordings fell within
  0.25 s of a segment `end`, at 47–177 UV/s²; with it, 9–66.
- **Auto-zoom's own §6.6 figure is over budget, and it is geometry rather than a
  defect.** The legal centre at magnification `a` is `[0.5/a, 1 − 0.5/a]`, an interval
  that _opens as the zoom tightens_, so a centre edge-snapped for the segment's full
  `amount` slides outward while the pre-roll zooms in — a real picture, correctly
  measured. Slowing it means changing `preRollSec`, `amountRange` or the edge snap, all
  §6.5's specified numbers — covered by `data/loom-scope/decision-comfort-ladder.md`.
  The budget is reported on `AutoZoomResult.budget` and not gated, because §6.6's remedy
  is a rest box and this generator has none.
- **§6.7 is not here.** The cursor _sprite_'s own stiffer spring belongs to whatever
  composites the sprite; `Track` already carries `smoothing` and `clickSpring` for it.
- **The corpus driver warps, it does not post.** Measured on this machine with
  `AXIsProcessTrusted() = false`: `CGWarpMouseCursorPosition` moves the pointer and
  `CGEventPost(kCGEventMouseMoved)` does not — synthesizing an _event_ is gated by
  Accessibility, moving the _pointer_ is not. That is why a corpus can be recorded on a
  machine with no grant, and why clicks cannot be.

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
24 fixed timestamps, the shipping `PreviewLoop` against a fixed-timestamp export loop,
max per-pixel delta **0**. Equality alone is not the gate — a preview and an export
that both draw nothing agree perfectly — so every timestamp also renders a third frame
with the annotation tracks disabled and requires that the annotations changed the
picture, that every changed pixel is inside a box `test/golden/fixture.ts` computes
with **its own four lines of arithmetic** (sharing `sourceToOutput` would make the
expectation follow the defect), that each kind drew in its own box, that the mask's
centre is exactly the mask's colour, that the blur destroyed the region's variance,
and that a parked track drew nothing while a crossfading one drew _linearly in its
window weight_ — the `blendMs` half, which a "did it draw" check cannot see. Six
`annotation-*` entries in `npm run verify:mutation` break the production source on
disk and require the gate to notice. The export _pipeline_ is phase 8's; the gate's
export loop is two lines written out rather than imported, on purpose.

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
  The kill waits for the stream as well as the clock: a `SIGKILL` costs a _constant_
  one or two frames, not a proportion, so ≥95% recovered is only a claim about the
  writer once ~60 frames are behind it. Killing purely on a 400 ms timer gave ~80
  frames on an idle machine and ~36 under the full suite, where two lost frames is
  5.6% and the gate failed on arithmetic. See `MIN_HANDED_FRAMES`.
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
- **An empty `activeRanges` means never active, and "always" is `[[0, 1e9]]`** — the
  idiom §2.6's reference document uses. That is the literal reading of §3.5's "0
  outside activeRanges", and it is what lets a track be parked without deleting it.

## Carried forward: four closed, four still open, one from phase 2 still open

Phases 1, 3 and 4 shipped seven things **unverified**, as obligations on phase 2's
signed-bundle gate. Three are now closed on real measurements from a granted, signed
bundle; four are not, and **phase 2's harness does not cover them** — its only audio
check is `microphone-revocation`, which is about a grant being withdrawn rather than
about any of these, and it has no camera checks at all. Phase 2 then left one of its
own (item 8, still open) and phase 10 one of its own (item 9, now closed on real
measurements — see the click-capture section below).

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

None of the four is answered by an ordinary `npm run verify:permissions`: the two audio ones need
`node scripts/smoke-capture.mjs` without `--synthetic` on a granted machine, and the
two camera ones need a real camera and a real cable. Do not read the gate's green rows
as covering them.

What _is_ covered without the grant: `node scripts/smoke-capture.mjs --synthetic`
replaces only the _source acquisition_ — `getDisplayMedia` and `getUserMedia` — in the
real capture page, and drives the shipped `MediaStreamTrackProcessor` →
`VideoEncoder`/`AudioEncoder` → encoded-chunk IPC → `ProjectStore` → fragmented MP4 and
M4A → finalize path end to end, on Chromium's real capture clocks. Without
`--synthetic` the script refuses to start when the grant is missing and names what to
grant, rather than failing three layers down in `desktopCapturer` with "Failed to get
sources". Run it after any change to capture: it is the only thing that watches the
two clocks, and it is what caught both of phase 3's real bugs.

**And one phase 2 opened, now closed in code and open on hardware:**

8. ~~**A revoked Microphone is recorded as a lost device.**~~ Fixed — see § A revoked
   Microphone, below. What is **still owed** is the same kind of evidence items 4–7 are
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
What none of them can establish is on hardware — see carried-forward item 8.

**And one phase 10 tried to close and could not:**

9. **Post-grant click rate and latency are still unmeasured.** The captain's
   accessibility decision records them as unverified and says _"Validate during the
   build"_; phase 2 confirmed the tap was live from a signed bundle but nobody clicked
   during its window. Phase 10 built the instrument —
   `scripts/record-cursor-corpus.mjs` posts clicks with `CGEventPost` stamped from
   `CLOCK_UPTIME_RAW` and `loom-input-sampler.m` stamps every line it emits from the
   same clock, so the difference is a latency rather than two numbers from two clocks,
   and the result lands in `corpus/manifest.json` under `clickCapture` — but **this
   machine has no Accessibility grant** (`./dist/native/loom-input-sampler probe`
   reports `accessibility-denied`, and TCC cannot be granted without GUI interaction).
   Both halves need it: an ungranted process cannot _post_ a synthetic click either
   (measured — see the corpus-driver note above). The manifest therefore records
   `measured: false` with the reason, `observedDowns: null` and `latencyMs: null` —
   never a zero, which is the whole point. **To close it: grant Accessibility to
   whatever runs the recorder and run `npm run record:cursor-corpus`; the reading is
   taken automatically and no code changes.**

## Post-grant click rate and latency — measured, and the last open item closed

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
and the click row is `skipped`. The table's last row was added afterwards and has not
been run at all — the figures above are from the 2026-08-05 bundle and say nothing
about it.

| Check                   | Status      | Evidence                                                                                                                                                                                                                                                       |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle-identity`       | **pass**    | Packaged, launched by launchd, signing as the frozen id.                                                                                                                                                                                                       |
| `frame-authorisation`   | **pass**    | A non-capture window asking `getDisplayMedia` is refused (`AbortError`) by the installed handler. Needs no grant — refusal happens before TCC.                                                                                                                 |
| `screen-enumeration`    | **pass**    | One screen source, with a `display_id` and a thumbnail carrying a real picture rather than the black rectangle a denied grant returns.                                                                                                                         |
| `content-protection`    | **pass**    | Control window showed the marker across **99.3%** of its rectangle; the protected HUD showed it across **0.0%**. §11's assumption, finally watched.                                                                                                            |
| `accessibility-clicks`  | **skipped** | Tap confirmed live (`tapEnabled: true` under the granted bundle), and nothing clicked in the window, so the rate is unmeasured. Rate and latency are deferred to phase 10 by captain decision — it consumes the log.                                           |
| `microphone-revocation` | **skipped** | Added after that run and **never executed**: it needs `--mic-revocation` and a person switching Microphone off mid-recording, and running the harness at all repackages and re-signs the bundle, which voids the captain's grants. See carried-forward item 8. |

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
