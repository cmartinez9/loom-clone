# loom-clone

A local-only, macOS-only screen recorder and editor. No account, no upload, no sync —
a recording is a folder on your disk that you can open in Finder.

## Status

**Phase 1 of 14: the capture spine.**

What runs today: the app launches, records the screen, and lists the recordings it
finds under `~/Movies/Loom Clone` — revealing them in Finder or moving them to the
Trash. Audio is phase 3, the webcam phase 4, and the editor phase 7; they are
deliberately absent rather than stubbed.

The property phase 1 exists to establish: **a recording survives the process being
killed.** Frames are encoded in a hidden renderer, cross IPC as encoded chunks, and
are written by the main process as fragmented-MP4 fragments the instant they exist,
so a `SIGKILL` costs at most the frame in flight. `npm test` proves it by killing a
real recording mid-stream and measuring what comes back — the gate is 95%, measured
at 98.7–99.4% — and `npm run verify:mutation` proves the gate itself by breaking the
writer four ways and requiring the test to fail each time.

## Requirements

macOS 14 or later. There is no Windows or Linux build and none is planned.

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

## How it is put together

```
packages/format/   the .loomrec on-disk format — schemas, migrations, atomic writes,
                   the edit journal
packages/mux/      the fragmented-MP4 writer and the scanner crash recovery reads
packages/ipc/      the typed main <-> renderer contract
packages/design/   "Pressroom" — tokens, type, icons, self-hosted fonts
apps/main/         Electron main: windows, ProjectStore, RecorderSession, loom://, IPC
apps/renderer/     renderer windows — library, recorder HUD, hidden capture page
```

`AGENTS.md` carries the rules that hold this together and points at the design
documents that settle them.

## Design

Direction A, "Pressroom": warm paper chrome, ink keylines, hard zero-blur offset
shadows, vermilion as the record accent, and a dark stage only where the picture
lives. Instrument Serif, Mona Sans and Martian Mono — all OFL, all self-hosted, no
font CDN call at runtime.
