# loom-clone

A local-only, macOS-only screen recorder and editor. No account, no upload, no sync —
a recording is a folder on your disk that you can open in Finder.

## Status

**Phase 2 of 14: permissions and first run**, on top of phase 1's capture spine,
phase 3's audio and A/V sync machinery and phase 4's webcam track and multi-part
recordings, plus the phase 5 cursor and click sampler, phase 6's decode path and
WebGL2 compositor, phase 7's timeline model, phase 10's cursor-follow and auto-zoom
generators and phase 11's annotations, built early and out of order because they are
self-contained.

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

The native input sampler is complete alongside it. First run uses it to check that a
real event tap can be built, because macOS answering "Accessibility is granted" is
not evidence that clicks will arrive — the API succeeds either way. No recording the
app itself makes samples the cursor into a log yet; the only bundles that carry one
are phase 10's corpus, written outside the recorder by
`npm run record:cursor-corpus`.

Phase 6's one decode path and WebGL2 compositor — the pair preview and export will
share — are complete alongside it too, built ahead of the capture spine against
synthetic fixtures and held to a 16 ms frame budget on a 4K fixture at a 1440p viewport
by a gate that runs in `npm test`. No shipping window drives the preview loop yet.

The property phase 7 establishes: **an edit means the same thing every time it is
read.** Tracks, keyframes and the springs that move a zoom live in one model, resolved
once per frame by the preview and — when phase 8 lands — by the exporter, so there is
no second reading to drift from the first. `npm test` proves it two ways: `resolve()`
after a random sequence of edits matches `resolve()` after those same edits are saved,
reloaded and replayed from the journal, and two independent precomputes of a spring
channel come out byte-identical.

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
at every timestamp so a pair that both drew nothing cannot pass. No shipping window
lets you author one yet; the editor is later.

`npm run verify:mutation` proves all six gates are real by breaking capture, the
timeline model, the generators and the annotation path one way at a time — editing the
production source on disk — and requiring a test to fail each time.

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
it is missing. It prints what each audio device claimed, what it actually ran at, and
where each track started relative to the first frame. Adding `--synthetic` puts a
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
