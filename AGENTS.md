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
npm run verify:mutation   # break the capture writer five ways; each must fail the gate
npm run package     # electron-builder, macOS only
node scripts/seed-fixtures.mjs <root>            # example recordings to look at
node scripts/make-capture-fixture.mjs            # regenerate the encoded-frame fixture (needs ffmpeg)
npm run build && node scripts/smoke-capture.mjs  # record the real screen once, end to end
node scripts/smoke-capture.mjs --synthetic       # ...with a canvas in place of the screen
node packages/sampler/native/build.mjs --force   # rebuild only the native sampler
./dist/native/loom-input-sampler probe           # what input capture can do right now
npx electron scripts/screenshot.cjs --out shots --theme light   # capture the real windows
```

## Layout

```
packages/format/   the on-disk format: schemas, types, validation, migrations,
                   writeAtomic, the edit journal.  `@loom/format` is PURE (no node,
                   no DOM); `@loom/format/fs` is the filesystem half.
packages/mux/      the fragmented-MP4 writer and the scanner recovery reads it with.
                   `@loom/mux` is PURE; `@loom/mux/fs` owns the file descriptor and,
                   like `@loom/format/fs`, has exactly one caller.
packages/ipc/      the typed main<->renderer contract. Not in the report's §1.3 list;
                   §1.4 requires a shared contract and this is it.
packages/design/   "Pressroom": tokens, type scale, icons, self-hosted fonts.
packages/sampler/  the 120 Hz cursor sampler, CGEventTap clicks and cursor bitmaps.
                   `native/` is an Objective-C CLI built by one `clang` call into
                   `dist/native/`; the TypeScript half parses its NDJSON and has no
                   filesystem of its own. Main-process only.
apps/main/         Electron main: WindowRegistry, ProjectStore, RecorderSession,
                   loom:// protocol, IPC.
apps/renderer/     renderer windows. Library, recorder HUD and the hidden capture
                   page today; overlay and editor later.
```

Later phases add `packages/edl`, `packages/compositor`, `packages/decode` and
`apps/export` beside these (report §1.3). The report also lists `apps/capture`; the
hidden capture page lives in `apps/renderer/src/capture/` instead, because a window
in this repo is a role in `apps/main/src/windows.ts` plus an entry in
`apps/renderer/vite.config.ts`, and a second renderer app would fork that.

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
3. **The bundle identifier is frozen.** `com.github.cmartinez9.loom-clone`, declared
   once in `apps/main/src/identity.ts`. macOS TCC keys every permission grant on it;
   changing it costs the user Screen Recording, Camera, Microphone and Accessibility,
   and produces black frames that look like a bug in our code. `identity.test.ts`
   fails if it drifts.
4. **No AI-generated look.** A binding review criterion, not taste: no gradients, no
   `backdrop-filter`, no blurred shadows, no blue-black neutrals, no Inter, no emoji
   as iconography. `packages/design/test/no-generic-look.test.ts` enforces the
   mechanical half. Rationale: `data/loom-design/report.md` §2 and §8.

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

A hidden renderer runs `getDisplayMedia` → `MediaStreamTrackProcessor` →
`VideoEncoder` and sends **encoded chunks** to main, which writes each one as its own
`moof`+`mdat` fragment the instant it exists. One sample per fragment is the crash
budget made explicit: a `SIGKILL` costs what this process still holds, so a fragment
is one frame (~110 bytes of overhead, ~0.2% at 12 Mbps) rather than the report's
"≤ 1 s". The writer holds exactly one sample so every duration is measured against
the next frame's timestamp, which a variable-rate screen track needs. `recording.json`
is written **before the first frame** with the facts only a live session knows
(display, scale factor, permissions); recovery corrects it rather than inventing it.
The frame index is held in memory and written at finalize — recovery rebuilds it by
scanning the fragments, which is strictly better than a checkpoint and avoids
rewriting a growing JSON once a second for the length of the recording.

## Sharp edges

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
- **Stop the sampler, then close the project — in that order.** Every `ProjectStore`
  write requires the project to be open and throws `UnknownRecordingError` otherwise;
  none of them opens a bundle on the caller's behalf. The event-log and cursor-bitmap
  writes are driven from the sampler's timers, so closing first turns a straggling
  write into a loud, typed refusal rather than a silent re-open that re-takes the
  bundle `.lock` and holds a closed recording for the rest of the session.
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

## Carried forward to phase 2: three things no dev run has verified

Phase 1 shipped with these **unverified**, not verified-and-passing. They are
obligations on phase 2's signed-bundle gate, and until that gate runs, no report may
describe them as working:

1. **`desktopCapturer` screen enumeration.**
2. **`setDisplayMediaRequestHandler`'s frame authorisation** — that the real handler
   hands a source to the capture page and refuses every other frame.
3. **`setContentProtection(true)` actually keeping the recorder HUD out of captured
   frames.** `windows.test.ts` asserts the flag is set on the role; nothing has
   watched the pixels.

Why they are open: a machine that has not granted Screen Recording to the _terminal_
cannot run the leg that would prove any of them, and granting it to a dev binary
proves the wrong thing anyway, because a dev build inherits the terminal's TCC (§7,
trap 6) — a pass there would not predict a packaged build.

What _is_ covered without the grant: `node scripts/smoke-capture.mjs --synthetic`
replaces only `navigator.mediaDevices.getDisplayMedia`, in the real capture page, and
drives the shipped `MediaStreamTrackProcessor` → `VideoEncoder` → encoded-chunk IPC →
`ProjectStore` → fragmented MP4 → finalize path end to end. Without `--synthetic` the
script refuses to start when the grant is missing and names what to grant, rather than
failing three layers down in `desktopCapturer` with "Failed to get sources".

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
