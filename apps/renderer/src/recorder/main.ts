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
import type { RecorderStatus } from '@loom/ipc';

const loom = window.loom;

const dot = must('dot');
const phaseLabel = must('phase');
const timer = must('timer');
const counts = must('counts');
const recordButton = must('record') as HTMLButtonElement;
const stopButton = must('stop') as HTMLButtonElement;
const errorLine = must('error');
const cameraLine = must('camera');

/** The last shelf height main was told about. `-1` so the first report is sent. */
let reportedNoticeHeight = -1;

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
  const height = cameraLine.offsetHeight + errorLine.offsetHeight;
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

function showError(error: unknown): void {
  errorLine.textContent = error instanceof Error ? error.message : String(error);
  errorLine.hidden = false;
  reportNoticeHeight();
}
