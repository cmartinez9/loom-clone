# loom-clone

A local-only, macOS-only screen recorder and editor. No account, no upload, no sync —
a recording is a folder on your disk that you can open in Finder.

## Status

**Phase 0 of 14: the project format and the Electron skeleton.**

What runs today: the app launches, lists the recordings it finds under
`~/Movies/Loom Clone`, reveals them in Finder and moves them to the Trash. Capture,
media and editing are phases 1 onward and are deliberately absent.

What is complete today, because everything else is built on it: the on-disk format
with its schemas, validation, migrations and crash-safe writes; the window registry;
the `loom://` protocol; the typed IPC boundary; and the Pressroom design system.

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

## How it is put together

```
packages/format/   the .loomrec on-disk format — schemas, migrations, atomic writes,
                   the edit journal
packages/ipc/      the typed main <-> renderer contract
packages/design/   "Pressroom" — tokens, type, icons, self-hosted fonts
apps/main/         Electron main: windows, ProjectStore, loom://, IPC
apps/renderer/     renderer windows
```

`AGENTS.md` carries the rules that hold this together and points at the design
documents that settle them.

## Design

Direction A, "Pressroom": warm paper chrome, ink keylines, hard zero-blur offset
shadows, vermilion as the record accent, and a dark stage only where the picture
lives. Instrument Serif, Mona Sans and Martian Mono — all OFL, all self-hosted, no
font CDN call at runtime.
