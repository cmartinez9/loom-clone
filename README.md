# loom-clone

A local-only, macOS-only screen recorder and editor. No account, no upload, no sync —
a recording is a folder on your disk that you can open in Finder.

## Status

**Phase 2 of 14: permissions and first run**, on top of phase 1's capture spine,
phase 3's audio and A/V sync machinery and phase 4's webcam track and multi-part
recordings, plus the phase 5 cursor and click sampler, phase 6's decode path and
WebGL2 compositor, phase 7's timeline model, phase 8's exporter, phase 9's
delete-after-export retention, phase 10's cursor-follow and auto-zoom generators,
phase 11's annotations and phase 12's live drawing overlay, built early and out of
order because they are self-contained.

What runs today: the first launch explains the four macOS permissions this app can
use — Screen Recording, Camera, Microphone and Accessibility — and asks for all four
together, as one step, before the first recording. Only Screen Recording is required;
declining the other three leaves a recorder that still records, with the features that
needed them switched off. Accessibility is used to detect clicks and nothing else, and
because macOS does not hand that grant to a running process, the setup window offers to
relaunch once it is switched on. The library keeps a route back to that screen, so a
permission answered "no" is not a reinstall. Switching the Microphone off _while a
recording is running_ stops that recording and the HUD says the permission was
revoked, rather than reporting a device that disconnected — everything captured up to
that moment is saved and playable, not discarded.

After setup the app records the screen with the microphone and the system's own audio
output alongside it, and lists the recordings it finds under `~/Movies/Loom Clone` —
revealing them in Finder or moving them to the Trash. System audio needs no driver and
no admin prompt, which is why the floor is macOS 14. The camera records as a track of
its own when a recording asks for one, but it is opt-in and the HUD has no toggle yet:
opening a camera lights the hardware indicator, so it should follow from a user asking,
and that asking is later HUD work. The editor window that will drive phase 7's timeline
model is later still, deliberately absent rather than stubbed.

The property phase 1 established: **a recording survives the process being killed.**
Frames are encoded in a hidden renderer, cross IPC as encoded chunks, and are written
by the main process as fragmented-MP4 fragments the instant they exist, so a
`SIGKILL` costs at most the frame in flight. `npm test` proves it by killing a real
recording mid-stream and measuring what comes back — the gate is 95%, measured at
96.4–99.4% across three kill points.

The property phase 3 establishes: **the three tracks stay together.** They are
captured separately, by three devices with three clocks, and nothing is trimmed to
make them line up — each track records where it started, how fast its device really
ran, and where it dropped out, and `recording.json` is what puts them back together.
`npm test` proves it by recording a flash and a tone at the same instant and
cross-correlating them at 1 minute **and at 20 minutes**, with a 20 ms budget. Twenty
minutes is the point: a build that trusts a sound card's claim of "48 kHz" is 2.6 ms
out at one minute and 59.6 ms out at twenty.

The property phase 4 establishes: **losing a device costs that device and nothing
else.** A camera unplugged mid-recording closes its part; the screen and the audio do
not notice; and the same camera plugged back in opens a second part with a
`startTimeSec` of its own, so the hole lives in `recording.json` and is never
concatenated out of the media. `npm test` proves it by driving the shipping capture
page through a device loss and a reconnect — the `ended` and `devicechange` events
macOS itself delivers — and checking both parts' boundaries, with three controls that
must fail. What no dev run can exercise is a real camera or a real cable; `AGENTS.md`
carries those forward.

The native input sampler is complete alongside it, and **every recording now uses
it.** First run still checks that a real event tap can be built, because macOS
answering "Accessibility is granted" is not evidence that clicks will arrive — the API
succeeds either way. From the first frame onward the recorder samples where the
pointer is into `events/cursor.ndjson`, which needs no permission at all and is
therefore written on every machine, and records clicks into `events/clicks.ndjson`
when Accessibility is granted. Without that grant there is no click file at all rather
than an empty one, and the recording says both that clicks were unavailable and that
macOS is why: "nobody clicked" and "we were never watching" are never written the same
way. That log is what phase 10's cursor-follow and auto-zoom-on-click read.

Phase 6's one decode path and WebGL2 compositor — the pair preview and export share —
are complete alongside it too, built ahead of the capture spine against
synthetic fixtures and held to a 16 ms frame budget on a 4K fixture at a 1440p viewport
by a gate that runs in `npm test`. No shipping window drives the preview loop yet.

The property phase 7 establishes: **an edit means the same thing every time it is
read.** Tracks, keyframes and the springs that move a zoom live in one model, resolved
once per frame by the preview and by the exporter, so there is no second reading to
drift from the first. `npm test` proves it two ways: `resolve()` after a random
sequence of edits matches `resolve()` after those same edits are saved, reloaded and
replayed from the journal, and two independent precomputes of a spring channel come
out byte-identical.

The property phase 8 establishes: **the exported file is the preview, frame for
frame.** The exporter is a hidden window driven by the main process, and it reads
through the same decode path and draws with the same compositor the preview does, so
there is no second reading of an edit to drift from the first. `npm test` proves it by
running the shipping preview loop and the shipping export loop over one recording, in
two WebGL2 contexts, and comparing 24 timestamps at a per-pixel difference of **zero**
— with two controls that each perturb the real export path and must each drive that
difference off zero. The finished MP4 is then decoded back and held to the checks
phase 9 trusts before it deletes anything: the file exists, is not empty, demuxes, is
the right length, and its last frame decodes. An export that fails those checks is not
left behind, and a cancelled one leaves no file at all.

Export writes to `~/Movies/Loom Clone/Exports` unless the folder is changed — it is
picked once and remembered, never asked for on every export — and then puts the file
itself on the clipboard, as a file reference rather than as a path string, and reveals
it in Finder. There is no network code anywhere in that path: no share sheet, no
upload, no account. An export starts from the library today: an editable recording's
row carries an Export button that expands into an export sheet in the row itself. The
editor window that will also start one is a later phase. `AGENTS.md` records what has
and has not been watched by hand — the pasteboard mechanism has, a paste landing in
another app as a video has not.

The property phase 9 establishes: **nothing is deleted until the export is proved
good, and you are told before it happens.** Exporting is what makes a recording final:
once the file exists, is not empty, demuxes, is the right length and its last frame
decodes, the original screen, camera, audio and cursor data are removed and the
recording stops being editable. The export sheet says that in the row you press the
button in, not in a dialog afterwards, and carries a switch that keeps the sources this
time. A failed, cancelled or interrupted export deletes nothing, and a crash part-way
through a deletion is finished on the next launch rather than left looking like a
recording that still opens. Nothing is ever deleted by age, by disk pressure or by
launching the app — only by an export that passed. `npm test` proves it by failing a
real export at each of the ten ways verification can fail, one at a time, and requiring
every source file to survive byte for byte, with an undamaged control that must
actually delete; a real `SIGKILL` aimed at each of the three deletion steps is the
other half.

The property phase 10 establishes: **framing that moves itself is measured, not
judged.** Cursor-follow keeps a rest box around the pointer and pulls a spring toward
it; auto-zoom-on-click pushes in around a burst of clicks and lets go again. Both are
ordinary tracks on that same timeline rather than a special case, so a zoom you author
yourself stacks over them in the usual way. `npm test` proves the comfort budget — pan
speed, pan acceleration, and how much of the recording the frame is still for — on
**ten real recordings** made on this machine by `npm run record:cursor-corpus` rather
than on synthetic fixtures, with controls that must fail: the same ten logs followed
with the rest box and the spring removed, and each of those two mechanisms removed on
its own. Following the cursor needs no permission; only the click-driven zoom needs
Accessibility, and without that grant it declines and names why, rather than quietly
generating nothing. No shipping window offers either yet; the editor is later.

The property phase 11 establishes: **a redaction that cannot be drawn is never
published.** Arrows, boxes, ellipses, highlights, text and blur/mask are spans on that
same timeline — no new primitive — anchored to the picture rather than to the output,
so a zoom cannot slide the content out from under a blur. A blur or mask that cannot
be placed refuses the frame instead of compositing without it, and one that cannot be
blurred is filled opaque rather than quietly weakened. `npm test` proves it by drawing
24 fixed timestamps through the shipping preview loop and through a fixed-timestamp
export loop and requiring **max per-pixel delta 0**, plus a third annotation-free frame
at every timestamp so a pair that both drew nothing cannot pass. The editor that lets
you place one is later; the only annotations a shipping window writes today are the
strokes below.

The property phase 12 establishes: **the ink is on the screen and not in the
recording.** The HUD's Draw button lays a transparent sheet over the display — a pen,
a marker, undo, clear and Done — and that window is content-protected, so what the
presenter draws is in front of the room and absent from the captured frames. The
strokes are appended to `events/drawing.ndjson` instead and imported at edit time as
one generated annotation track on the same timeline as everything above, so they are
re-composited at full resolution over whatever zoom and trim the edit ends up with,
and removing them is the ordinary track deletion any other track gets rather than a
drawing-shaped special case. The overlay is an accessory and never a dependency: it
does not take focus from the app being recorded, it takes clicks only while a pen is
in hand, and a failure anywhere on its path costs the pen rather than the recording.
`npm test` proves the live ink and the deletion — real pointer gestures into the
shipping page, read back out of the canvas, with a pen-up control that must ink
nothing. **Absent from the capture is the part `npm test` cannot settle**: seeing it
means capturing the screen, so it lives in `npm run verify:permissions` beside phase
2's identical measurement of the HUD. That check has never been run — `AGENTS.md`
carries the readings an unpackaged dev run of the test it replaced produced, and says
plainly that they are not evidence the shipped check has reproduced them.

`npm run verify:mutation` proves those gates are real by breaking the production source
behind them one property at a time — editing it on disk — and requiring a test to fail
each time. The one property it deliberately leaves uncovered, because no test in
`npm test` can catch it, is named in `AGENTS.md` rather than papered over.

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
it is missing. It prints what each audio device claimed, what it actually ran at,
where each track started relative to the first frame, and how many cursor samples the
recording logged and whether the click tap was live. Adding `--synthetic` puts a
canvas and an oscillator where the real sources would be and runs everything below
them for real, so it works without the grant — at the cost of covering neither
`desktopCapturer`, nor the `getDisplayMedia` authorisation, nor `setContentProtection`.
Those three cannot be settled by any dev run: in development macOS permissions are
inherited from the terminal, so a pass there says nothing about the shipped app. They,
and only they, are answered from a signed bundle instead:

```bash
npm run verify:permissions   # package, sign under the frozen bundle id, run the checks
```

That gate's only audio check is §7.3's — that a Microphone grant withdrawn
mid-recording stops the recording rather than being logged as a disconnected device —
and it needs a person to flip the switch, so it runs only under
`node scripts/verify-permissions.mjs --mic-revocation` and is otherwise `skipped`.
Whether macOS honours the AEC/NS/AGC-off stereo constraints on a real loopback track,
and where a real microphone's `startTimeSec` actually lands, are phase 3's obligations
and both are still open. The thing that would answer them is
`node scripts/smoke-capture.mjs` **without** `--synthetic`, on a machine that has been
granted Screen Recording and Microphone — not `npm run verify:permissions`.

`AGENTS.md` § Phase 2 gate status is the record of what that has closed and what is
still waiting on a permission only System Settings can give.

## How it is put together

`AGENTS.md` § Layout is the module map — what each package owns and where a new one
goes. It also carries the rules that hold this together and points at the design
documents that settle them.

## Design

Direction A, "Pressroom": warm paper chrome, ink keylines, hard zero-blur offset
shadows, vermilion as the record accent, and a dark stage only where the picture
lives. Instrument Serif, Mona Sans and Martian Mono — all OFL, all self-hosted, no
font CDN call at runtime.
