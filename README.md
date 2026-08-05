# loom-clone

A local-only, macOS-only screen recorder and editor. No account, no upload, no sync —
a recording is a folder on your disk that you can open in Finder.

## Status

**Phase 1 of 14: the capture spine**, plus the phase 5 cursor and click sampler and
phase 6's decode path and WebGL2 compositor, built early and out of order because they
are self-contained.

What runs today: the app launches, records the screen, and lists the recordings it
finds under `~/Movies/Loom Clone` — revealing them in Finder or moving them to the
Trash. Audio is phase 3, the webcam phase 4, and the editor phase 7; they are
deliberately absent rather than stubbed.

The property phase 1 exists to establish: **a recording survives the process being
killed.** Frames are encoded in a hidden renderer, cross IPC as encoded chunks, and
are written by the main process as fragmented-MP4 fragments the instant they exist,
so a `SIGKILL` costs at most the frame in flight. `npm test` proves it by killing a
real recording mid-stream and measuring what comes back — the gate is 95%, measured
at 96.4–99.4% across three kill points — and `npm run verify:mutation` proves the
gate itself by breaking the writer five ways and requiring the test to fail each
time.

The native input sampler is complete alongside it, but nothing starts it yet, because
the permission flow that turns it on is phase 2.

Phase 6's one decode path and WebGL2 compositor — the pair preview and export will
share — are complete alongside it too, built ahead of the capture spine against
synthetic fixtures and held to a 16 ms frame budget on a 4K fixture at a 1440p viewport
by a gate that runs in `npm test`. No shipping window drives the preview loop yet.

## Requirements

macOS 14 or later. There is no Windows or Linux build and none is planned.

Building and testing also need the Xcode Command Line Tools (`xcode-select --install`):
the input sampler is an Objective-C helper compiled by one `clang` call.

## Getting started

```bash
npm install
npm start          # build and run
npm run dev        # rebuild on change and restart
npm run verify     # typecheck, lint, format, test — what CI runs
```

To look at the library window with something in it:

```bash
node scripts/seed-fixtures.mjs ~/Movies/"Loom Clone"
npm start
```

To check that screen capture really works on this machine, end to end:

```bash
npm run build && node scripts/smoke-capture.mjs
```

That needs Screen Recording granted to your terminal, and stops with instructions if
it is missing. Adding `--synthetic` puts a canvas where the display source would be
and runs everything below it for real, so it works without the grant — at the cost of
covering neither `desktopCapturer`, nor the `getDisplayMedia` authorisation, nor
`setContentProtection`. Those three remain unverified in a dev environment and are
carried forward to phase 2's signed-bundle gate; `AGENTS.md` records them.

## How it is put together

`AGENTS.md` § Layout is the module map — what each package owns and where a new one
goes. It also carries the rules that hold this together and points at the design
documents that settle them.

## Design

Direction A, "Pressroom": warm paper chrome, ink keylines, hard zero-blur offset
shadows, vermilion as the record accent, and a dark stage only where the picture
lives. Instrument Serif, Mona Sans and Martian Mono — all OFL, all self-hosted, no
font CDN call at runtime.
