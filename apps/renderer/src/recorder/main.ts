/**
 * The recorder HUD. Architecture report §1.2.
 *
 * The HUD is deliberately small: start, stop, a timer, an honest count and §7.4's
 * camera notice. It starts a recording on `DEFAULT_CAPTURE_OPTIONS`, so phase 3's
 * microphone and system audio are captured without this window asking for a device
 * or showing a level — and no camera is opened, because `webcamDeviceId` defaults to
 * `null` and nothing here overrides it. Source and device pickers, a camera toggle,
 * audio meters and the live camera preview are surface work for the phase that
 * builds them; phase 4 built the camera *track*, not the control that turns it on.
 *
 * **This is the window `setContentProtection(true)` exists for.** It sets
 * `NSWindowSharingNone`, which is how our own UI stays out of the recording. The
 * flag lives on the role in `apps/main/src/windows.ts`; this file is what it keeps
 * out of the frame.
 *
 * The timer counts **media time**, not wall clock. A capture that stalls shows a
 * stalled timer, which is the truth; a wall clock would keep counting and tell the
 * user their recording is longer than it is.
 */

import '@loom/design/css';
import './recorder.css';
import { formatDuration } from '@loom/design';
import { PERMISSIONS } from '@loom/permissions';
import { DISK_COPY, type OverlayStatus, type RecorderStatus } from '@loom/ipc';

const loom = window.loom;

const dot = must('dot');
const phaseLabel = must('phase');
const timer = must('timer');
const counts = must('counts');
const recordButton = must('record') as HTMLButtonElement;
const stopButton = must('stop') as HTMLButtonElement;
const drawButton = must('draw') as HTMLButtonElement;
const errorLine = must('error');
const cameraLine = must('camera');
const diskLine = must('disk');
const revokedShelf = must('revoked');
const revokedText = must('revoked-text');
const revokedSettings = must('revoked-settings') as HTMLButtonElement;

/** The last shelf height main was told about. `-1` so the first report is sent. */
let reportedNoticeHeight = -1;

/**
 * Whether the drawing overlay is on screen, as **main** last reported it.
 *
 * Read back rather than tracked locally, because main owns the window: the overlay
 * closes itself from its own Done button, and a HUD holding its own belief would
 * then need two clicks to reopen it.
 */
let overlayOpen = false;

drawButton.addEventListener('click', () => {
  // Fire-and-forget, and no optimistic toggle. The button follows the window; the
  // window does not follow the button.
  loom.overlay.setOpen(!overlayOpen);
});

loom.overlay.onStatus((status: OverlayStatus) => {
  overlayOpen = status.open;
  drawButton.setAttribute('aria-pressed', String(status.open));
  drawButton.classList.toggle('btn-primary', status.open);
  // The overlay's failures surface on the HUD's own error line, because the overlay
  // has no words of its own — it is a transparent sheet over the user's desktop —
  // and because a pen that stopped writing must not be silent about it.
  if (status.error !== null) {
    errorLine.textContent = status.error;
    errorLine.hidden = false;
    reportNoticeHeight();
  }
});

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`recorder.html is missing #${id}`);
  return element;
}

const PHASE_LABEL: Record<RecorderStatus['phase'], string> = {
  idle: 'Ready',
  starting: 'Starting',
  recording: 'Recording',
  finalizing: 'Finishing',
  failed: 'Failed',
};

recordButton.addEventListener('click', () => {
  errorLine.hidden = true;
  reportNoticeHeight();
  recordButton.disabled = true;
  void loom.recorder.start().catch((error: unknown) => {
    recordButton.disabled = false;
    showError(error);
  });
});

stopButton.addEventListener('click', () => {
  stopButton.disabled = true;
  void loom.recorder.stop().catch((error: unknown) => {
    showError(error);
  });
});

/**
 * The one thing the §7.3 notice asks the user to do, made pressable.
 *
 * The kind is read off the notice main sent rather than hard-coded: `openSettings`
 * takes a {@link PermissionKind} and main looks up the one URL it is allowed to open
 * (see `PermissionsApi.openSettings`), so a second revocable grant needs no change
 * here.
 */
revokedSettings.addEventListener('click', () => {
  const kind = revokedSettings.dataset['kind'];
  if (kind === undefined) return;
  loom.permissions.openSettings(kind as Parameters<typeof loom.permissions.openSettings>[0]);
});

loom.recorder.onStatus(render);

render({
  phase: 'idle',
  recordingId: null,
  elapsedSec: 0,
  frameCount: 0,
  droppedFrames: 0,
  error: null,
  camera: 'off',
  cameraParts: 0,
  revoked: null,
  disk: null,
  diskStop: null,
});

function render(status: RecorderStatus): void {
  const live = status.phase === 'recording';
  dot.hidden = !live;
  phaseLabel.textContent = PHASE_LABEL[status.phase];
  timer.textContent = formatDuration(status.elapsedSec);

  recordButton.hidden = live || status.phase === 'finalizing';
  recordButton.disabled = status.phase === 'starting';
  stopButton.hidden = !live && status.phase !== 'finalizing';
  stopButton.disabled = status.phase === 'finalizing';

  // Dropped frames are shown rather than hidden. A recording that could not keep
  // up is a recording the user may want to make again, and finding that out in
  // the editor is finding it out too late.
  const parts = [`${String(status.frameCount)} frames`];
  if (status.droppedFrames > 0) parts.push(`${String(status.droppedFrames)} dropped`);
  counts.textContent = live || status.phase === 'finalizing' ? parts.join(' · ') : '';

  renderCamera(status);
  renderDisk(status);
  renderRevoked(status);

  if (status.error !== null) {
    errorLine.textContent = status.error;
    errorLine.hidden = false;
  }

  reportNoticeHeight();
}

/**
 * Tell main how tall the notice shelf below the bar is, so it can size the window
 * to it.
 *
 * The shelf is measured rather than assumed because its height is not ours to know
 * in advance: an error line wraps to as many lines as the message needs. What is
 * reported is the shelf *alone*, not the document — main owns the 92 px bar and adds
 * this to it, so "no notice" is structurally a return to the shipping geometry
 * rather than a number this file has to get right.
 *
 * Sent only when it changes. `render` runs on every status push, four times a
 * second for the length of a recording, and the answer is the same every time.
 */
function reportNoticeHeight(): void {
  const height =
    cameraLine.offsetHeight +
    diskLine.offsetHeight +
    revokedShelf.offsetHeight +
    errorLine.offsetHeight;
  if (height === reportedNoticeHeight) return;
  reportedNoticeHeight = height;
  loom.recorder.noticeHeight(height);
}

/**
 * The camera banner. Architecture report §7.4 step 3, verbatim:
 *
 * > *"Camera disconnected — still recording screen and audio."*
 *
 * Non-modal, and it says both halves on purpose. A user whose camera falls out
 * needs to know two things: that it happened, and that pressing stop now is not
 * required. A banner that said only the first would send them to stop the recording
 * they are still successfully making.
 *
 * It is a notice, not an error — the recording is fine — so it does not touch the
 * error line, which is where a recording that actually failed says so.
 *
 * `starting` shows nothing. A camera takes `getUserMedia` plus a frame to produce
 * anything, and announcing that as a camera problem for the first second of every
 * recording is how a user learns to ignore this line.
 */
function renderCamera(status: RecorderStatus): void {
  const recording = status.phase === 'recording' || status.phase === 'finalizing';
  if (
    !recording ||
    status.camera === 'off' ||
    status.camera === 'starting' ||
    status.camera === 'live'
  ) {
    cameraLine.hidden = true;
    return;
  }
  cameraLine.textContent =
    status.camera === 'lost'
      ? 'Camera disconnected — still recording screen and audio.'
      : 'Camera unavailable — still recording screen and audio.';
  cameraLine.hidden = false;
}

/**
 * §7.2's disk notices — the banner while recording, and what the stop left behind.
 *
 * Two states through one element, in the order the user meets them.
 *
 * **The stop notice wins and outlives the recording**, for exactly §7.3's reasons:
 * by the time anyone reads it the recorder is back to `idle`, the recording it
 * describes has finalized, and the one thing a user needs to know is that their
 * footage is not lost. `DISK_COPY.stopped` says what happened; the duration says how
 * much survived, and it is measured — `RecorderSession` reads it off the reference
 * track at the instant the recording ended, not off a wall clock.
 *
 * **The banner is gated on the phase**, like §7.4's camera line and unlike §7.3's
 * shelf: "space is running out" is a fact about a recording in progress, and leaving
 * it up afterwards would be nagging about a recording that already finished.
 *
 * A reading of `unknown` shows nothing at all. A volume this app could not measure
 * is not a volume it may make claims about — see `DiskLevel` — and a banner reading
 * "free space could not be measured" on every recording is a banner nobody reads
 * when it matters.
 */
function renderDisk(status: RecorderStatus): void {
  const stopped = status.diskStop;
  if (stopped !== null) {
    diskLine.textContent = `${DISK_COPY.stopped} ${formatDuration(stopped.recordedSec)} is in your library.`;
    diskLine.hidden = false;
    return;
  }
  const recording = status.phase === 'recording' || status.phase === 'finalizing';
  const disk = status.disk;
  if (!recording || disk === null || (disk.level !== 'low' && disk.level !== 'critical')) {
    diskLine.hidden = true;
    return;
  }
  diskLine.textContent = DISK_COPY.banner(disk);
  diskLine.hidden = false;
}

/**
 * The revoked-permission notice. Architecture report §7.3, and the captain's
 * `decision-mic-revocation.md`.
 *
 * Three things this gets right that the camera banner deliberately does not need:
 *
 * 1. **It names the cause.** The whole point of the decision is that "microphone
 *    disconnected" told a user who had just switched the permission off the wrong
 *    thing. The sentence comes from `PERMISSIONS[kind]`, which is where every other
 *    surface reads its permission copy from, so the recorder and the first-run window
 *    cannot describe the same grant differently.
 * 2. **It says the footage survived**, with the length of it. A recording that stops
 *    by itself reads as a recording that was lost, and this one was not — it
 *    finalized to the library with everything up to the moment the grant went away.
 * 3. **It outlives the recording.** Unlike the camera banner it is not gated on the
 *    phase: by the time anyone reads it, the recorder is back to `idle`. Pressing
 *    record clears it, which is main's doing (`RecorderSession.revoked`).
 */
function renderRevoked(status: RecorderStatus): void {
  const revoked = status.revoked;
  if (revoked === null) {
    revokedShelf.hidden = true;
    return;
  }
  const facts = PERMISSIONS[revoked.kind];
  revokedText.textContent =
    `${facts.whenRevokedMidRecording} ` +
    `${formatDuration(revoked.recordedSec)} is in your library.`;
  revokedSettings.dataset['kind'] = revoked.kind;
  revokedSettings.textContent = `Open ${facts.settingsPaneName.split('›').pop()?.trim() ?? 'Settings'} settings`;
  revokedShelf.hidden = false;
}

function showError(error: unknown): void {
  errorLine.textContent = error instanceof Error ? error.message : String(error);
  errorLine.hidden = false;
  reportNoticeHeight();
}
