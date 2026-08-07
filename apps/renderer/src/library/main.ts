/**
 * The library window.
 *
 * Vanilla TypeScript and the design system, no framework. Phase 0 deferred the
 * framework question to whoever built the editor rather than imposing an answer from
 * here; phase 14 took it, kept vanilla TypeScript, and wrote the reasoning down in
 * `apps/renderer/src/editor/main.ts`'s header — which is where it lives now.
 *
 * Everything this window can do is `window.loom` — the preload surface. There is
 * no `fs`, no `require`, no network. That is the point (§0, rule 2).
 */

import '@loom/design/css';
import './library.css';
import { formatBytes, formatDuration, formatRelativeDate, icon, mountIcons } from '@loom/design';
import { RETENTION_COPY } from '@loom/format';
import type { ProjectState, RecordingSummary } from '@loom/format';
import { DISK_COPY, RECOVERY_COPY } from '@loom/ipc';
import type {
  DiskReading,
  ExportProgress,
  PreflightReport,
  RecorderStatus,
  RecoveryReport,
} from '@loom/ipc';
import { describePermission } from '@loom/permissions';
import { exportNotice } from './export-notice.ts';

const loom = window.loom;

const rows = must('rows');
const facts = must('facts');
const refreshButton = must('refresh') as HTMLButtonElement;
const revealRootButton = must('reveal-root');
const newRecordingButton = must('new-recording');
const permissionsButton = must('permissions');
const permBanner = must('perm-banner');
const recoveryBanner = must('recovery-banner');
const diskCapacity = must('disk-capacity');

/** An element the page is required to contain; a missing one is a broken build. */
function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`library.html is missing #${id}`);
  return element;
}

/** The id whose delete is awaiting a second click, if any. */
let pendingDelete: string | null = null;
let recordingsRoot = '';

/**
 * The export sheet, §7.5 obligation 2 — *"the user is told before it happens … Not a
 * footnote, not a toast afterwards."*
 *
 * It expands **in the row**, the way the delete confirmation does, for the same
 * reason that one does: the consequence is read in the act of confirming rather than
 * in a dialog that is dismissed on the way past. What it says is
 * `RETENTION_COPY.warning`, which is `@loom/format`'s copy and not this file's — the
 * warning and the deletion have to be about the same thing, and a sentence written
 * here could drift from the behaviour written there.
 */
interface ExportSheet {
  id: string;
  /** §7.5 obligation 4. Defaults to false — the captain's chosen default. */
  keep: boolean;
  /** `null` until the button is pressed. */
  jobId: string | null;
  /** What to show under the buttons: progress, the outcome, or an error. */
  status: string;
  done: boolean;
}

let exportSheet: ExportSheet | null = null;
/** The live status line, so progress does not have to re-render the library. */
let exportStatusNode: HTMLElement | null = null;

/** Whether a job this window started is still running. */
function exportInFlight(): boolean {
  return exportSheet?.jobId != null && !exportSheet.done;
}

// ---------------------------------------------------------------- state chips

interface StateChip {
  label: string;
  className: string;
  /** Show the pulsing record dot. Only ever for a live recording. */
  live?: boolean;
}

/**
 * The lifecycle enum of §2.2, stated in the user's language.
 *
 * `exported` deserves its own wording: it means the sources are gone and the
 * recording can no longer be edited (captain decision 5), which is not something to
 * discover by trying.
 */
const STATE_CHIPS: Record<ProjectState, StateChip> = {
  recording: { label: 'Recording', className: 'chip chip-accent', live: true },
  finalizing: { label: 'Finishing', className: 'chip chip-audio' },
  editable: { label: 'Editable', className: 'chip' },
  exported: { label: 'Exported', className: 'chip chip-ok' },
  'needs-recovery': { label: 'Needs recovery', className: 'chip chip-audio' },
  failed: { label: 'Damaged', className: 'chip chip-accent' },
};

/**
 * The line under a state chip, where the state alone is not the whole story.
 *
 * **Two of these described a recovery pass that does not work that way, and the
 * correction is the point of them being here.** §7.1's repair runs **at launch**, in
 * `RecorderSession.recoverOnLaunch`, before any window is shown — not when a
 * recording is opened. So a bundle still saying `recording` when this window renders
 * is one being captured right now, and one saying `needs-recovery` is one this
 * launch's pass began and could not finish (`recoverBundle` writes that state before
 * it repairs anything). The old copy — *"in progress when the app last closed"* and
 * *"repaired … when opened"* — sent a user to double-click a recording in order to
 * trigger something that had already happened, or already failed, and quietly
 * contradicted the pulsing record dot beside it.
 *
 * Nothing here claims how much survives a crash. That number is measured per
 * recording and said in {@link renderRecovery} out of the repair's own report; a
 * fixed sentence about it here would be a second, unmeasured answer.
 */
const STATE_NOTES: Partial<Record<ProjectState, string>> = {
  recording: 'Being captured right now.',
  'needs-recovery':
    'Repair runs when the app starts. This one did not finish — the next launch will try again.',
  // The same words the export sheet warned with, after the fact rather than before —
  // one source, so the promise and the outcome cannot be phrased differently.
  exported: RETENTION_COPY.exported,
};

// ---------------------------------------------------------------- rendering

function posterIcon(summary: RecordingSummary): string {
  if (summary.unreadable !== undefined) return icon('alert', 26);
  if (summary.state === 'recording') return icon('record', 26);
  if (summary.state === 'exported') return icon('lock', 24);
  return icon('play', 24);
}

function renderRow(summary: RecordingSummary): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset['id'] = summary.id;

  const damaged = summary.unreadable !== undefined;
  if (damaged) li.classList.add('row-damaged');

  const poster = document.createElement('div');
  poster.className = 'poster';
  poster.innerHTML = posterIcon(summary);
  li.append(poster);

  const body = document.createElement('div');
  body.className = 'row-body';

  const title = document.createElement('div');
  title.className = 'row-title';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = summary.name;
  title.append(name);

  const chipSpec = damaged ? STATE_CHIPS.failed : STATE_CHIPS[summary.state];
  const chip = document.createElement('span');
  chip.className = chipSpec.className;
  if (chipSpec.live === true) {
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    chip.append(dot);
  }
  chip.append(document.createTextNode(chipSpec.label));
  title.append(chip);
  body.append(title);

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  appendFacts(meta, [
    formatDuration(summary.durationSec),
    formatBytes(summary.sizeBytes),
    formatRelativeDate(summary.createdAt),
  ]);
  body.append(meta);

  const note = damaged
    ? `This folder could not be read: ${summary.unreadable ?? ''}`
    : STATE_NOTES[summary.state];
  if (note !== undefined) {
    const p = document.createElement('div');
    p.className = 'row-note';
    p.textContent = note;
    body.append(p);
  }

  li.append(body);
  li.append(renderActions(summary));
  return li;
}

function appendFacts(container: HTMLElement, values: string[]): void {
  values.forEach((value, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      container.append(sep);
    }
    const span = document.createElement('span');
    span.textContent = value;
    container.append(span);
  });
}

/**
 * The export sheet for one row: the warning, the escape hatch, and the button.
 *
 * Every part of §7.5's obligations 2 and 4 that a person can see is here, and the
 * order is deliberate — the consequence first, the way out of it second, the button
 * last. The button is `btn-rec` (the accent, the same one "New recording" uses)
 * rather than a danger red: this is the thing the user came to do, and it is
 * destructive only in a way the sentence above it has already said out loud.
 */
function renderExportSheet(sheet: ExportSheet): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'export-sheet';

  const warning = document.createElement('div');
  warning.className = 'export-warning';
  warning.append(iconSpan('alert', 15));
  const warningText = document.createElement('span');
  warningText.textContent = RETENTION_COPY.warning;
  warning.append(warningText);
  panel.append(warning);

  const keepRow = document.createElement('div');
  keepRow.className = 'export-keep';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tgl';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(sheet.keep));
  toggle.setAttribute('aria-label', RETENTION_COPY.keepLabel);
  toggle.disabled = sheet.jobId !== null || sheet.done;
  toggle.addEventListener('click', () => {
    sheet.keep = !sheet.keep;
    void refresh();
  });
  const keepText = document.createElement('div');
  const keepLabel = document.createElement('div');
  keepLabel.className = 'export-keep-label';
  keepLabel.textContent = RETENTION_COPY.keepLabel;
  const keepHint = document.createElement('div');
  keepHint.className = 'export-keep-hint';
  // The hint says what *this* setting buys, and it swaps: leaving it off is a
  // decision too, and the sentence that explains it belongs beside the switch.
  keepHint.textContent = sheet.keep ? RETENTION_COPY.keepHint : RETENTION_COPY.deleteHint;
  keepText.append(keepLabel, keepHint);
  keepRow.append(toggle, keepText);
  panel.append(keepRow);

  const actions = document.createElement('div');
  actions.className = 'export-actions';
  const cancel = button(sheet.done ? 'Close' : 'Cancel', 'btn btn-sm');
  cancel.addEventListener('click', () => {
    const jobId = sheet.jobId;
    if (jobId !== null && !sheet.done) loom.export.cancel(jobId);
    exportSheet = null;
    exportStatusNode = null;
    void refresh();
  });
  actions.append(cancel);

  if (!sheet.done) {
    const go = button('Export', 'btn btn-sm btn-rec');
    go.prepend(iconSpan('export', 14));
    go.disabled = sheet.jobId !== null;
    go.addEventListener('click', () => {
      void startExport(sheet);
    });
    actions.append(go);
  }
  panel.append(actions);

  // Always present, even when empty, because progress writes into it directly. See
  // {@link onExportProgress}: a `refresh()` per progress report would re-scan every
  // bundle on disk, and main reports progress **per encoded frame**.
  const status = document.createElement('div');
  status.className = 'export-status';
  status.setAttribute('role', 'status');
  status.textContent = sheet.status;
  panel.append(status);
  exportStatusNode = status;
  return panel;
}

async function startExport(sheet: ExportSheet): Promise<void> {
  sheet.status = 'Preparing…';
  void refresh();
  try {
    // The destination is not ours to name: main composes it from
    // `settings.exportRoot`. All a renderer says is which recording, and — §7.5
    // obligation 4 — whether to keep the sources this time.
    const { jobId } = await loom.export.start(sheet.id, { keepSources: sheet.keep });
    sheet.jobId = jobId;
  } catch (error) {
    sheet.status = `The export could not start: ${messageOf(error)}`;
    sheet.done = true;
  }
  await refresh();
}

/**
 * Turn one progress report into the sentence under the buttons.
 *
 * A terminal phase re-renders the row — the state chip, the size on disk and the
 * actions all change when an export finishes. Everything before it writes straight
 * into {@link exportStatusNode} instead, because `ExportSession` reports progress
 * **per encoded frame** and `refresh()` reads every bundle in the library.
 */
function onExportProgress(progress: ExportProgress): void {
  const sheet = exportSheet;
  if (sheet?.jobId !== progress.jobId) return;
  if (progress.phase === 'done') {
    sheet.done = true;
    // What actually happened to the sources, from `sourcesDeleted` and
    // `retentionError` and never inferred from the checkbox: a deletion that was
    // authorised and then failed is a third state, and telling the user their
    // recording is final — or that it was kept — when neither is true would be the
    // same lie in one direction or the other. See {@link exportNotice}.
    sheet.status = exportNotice(progress.result);
  } else if (progress.phase === 'failed') {
    sheet.done = true;
    sheet.status = `The export failed, and nothing was deleted: ${progress.error ?? 'no detail'}`;
  } else if (progress.phase === 'cancelled') {
    sheet.done = true;
    sheet.status = 'The export was cancelled. Nothing was deleted.';
  } else {
    sheet.status = `${PHASE_WORDS[progress.phase]} ${Math.round(progress.completed * 100)}%`;
    if (exportStatusNode !== null) exportStatusNode.textContent = sheet.status;
    return;
  }
  void refresh();
}

const PHASE_WORDS: Record<ExportProgress['phase'], string> = {
  preparing: 'Preparing…',
  audio: 'Mixing audio…',
  video: 'Rendering…',
  muxing: 'Writing the file…',
  verifying: 'Checking the file…',
  done: 'Done.',
  failed: 'Failed.',
  cancelled: 'Cancelled.',
};

function renderActions(summary: RecordingSummary): HTMLElement {
  if (exportSheet?.id === summary.id) return renderExportSheet(exportSheet);

  if (pendingDelete === summary.id) {
    // The second click. The consequence sits beside the button rather than in a
    // dialog, so it is read in the act of confirming.
    const confirm = document.createElement('div');
    confirm.className = 'confirm';

    const text = document.createElement('span');
    text.className = 'confirm-text';
    text.textContent = 'Move this recording to the Trash?';
    confirm.append(text);

    const cancel = button('Cancel', 'btn btn-sm');
    cancel.addEventListener('click', () => {
      pendingDelete = null;
      void refresh();
    });

    const go = button('Move to Trash', 'btn btn-sm btn-rec');
    go.addEventListener('click', () => {
      void performDelete(summary.id);
    });

    confirm.append(cancel, go);
    return confirm;
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  // The route into the editor, and the only one. Offered exactly for the states
  // §2.2 says have something to edit: a recording still being made is the
  // recorder's, `exported` had its sources deleted after a verified export
  // (captain decision 5), and a bundle that is damaged or awaiting repair has
  // nothing to open. Main refuses each of those too — a library that declines to
  // send the message is not an enforcement of anything — but being told here beats
  // pressing a button that opens a window to say no.
  if (canEdit(summary)) {
    const open = button('Open', 'btn btn-sm btn-primary');
    open.prepend(iconSpan('play', 14));
    open.addEventListener('click', () => {
      loom.editor.open(summary.id);
    });
    actions.append(open);
  }

  // Only an editable recording can be exported. An `exported` one has no sources
  // left to compose from (captain decision 5), and the other states are a recording
  // that is not finished being one.
  if (summary.state === 'editable' && summary.unreadable === undefined) {
    const exportButton = button('Export', 'btn btn-sm');
    exportButton.prepend(iconSpan('export', 14));
    // Defence in depth for the refusal that matters, which is main's
    // (`ExportRecordingBusyError`): there is one sheet, so opening a second one over a
    // live job takes away the only surface reporting its progress and the only Cancel
    // button it has — and it was the first step of the sequence that got two jobs of
    // one recording running at once. A renderer cannot be trusted to decline a
    // capability, so this is a courtesy on top of the guarantee, not the guarantee.
    exportButton.disabled = exportInFlight();
    exportButton.addEventListener('click', () => {
      if (exportInFlight()) return;
      pendingDelete = null;
      exportSheet = { id: summary.id, keep: false, jobId: null, status: '', done: false };
      void refresh();
    });
    actions.append(exportButton);
  }

  const reveal = button('Reveal', 'btn btn-sm');
  reveal.prepend(iconSpan('folder', 14));
  reveal.addEventListener('click', () => {
    loom.library.reveal(summary.id);
  });

  const remove = button('Delete', 'btn btn-sm btn-danger');
  remove.prepend(iconSpan('trash', 14));
  remove.addEventListener('click', () => {
    pendingDelete = summary.id;
    void refresh();
  });

  actions.append(reveal, remove);
  return actions;
}

/** Whether this recording has something an editor could open. */
function canEdit(summary: RecordingSummary): boolean {
  return summary.unreadable === undefined && summary.state === 'editable';
}

function button(label: string, className: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.append(document.createTextNode(label));
  return element;
}

function iconSpan(name: Parameters<typeof icon>[0], size: number): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'ic-slot';
  span.innerHTML = icon(name, size);
  return span;
}

function renderEmpty(): HTMLElement {
  const li = document.createElement('li');
  const panel = document.createElement('div');
  panel.className = 'empty';
  panel.innerHTML = `
    <div class="t-d3">Nothing recorded yet.</div>
    <p>
      When you record, this app writes a folder per recording — the screen, the
      camera, each audio track and the cursor log, all kept separate so nothing is
      ever baked into pixels until you export.
    </p>
    <span class="where"></span>
  `;
  const where = panel.querySelector<HTMLElement>('.where');
  if (where !== null) where.textContent = displayRoot();
  li.append(panel);
  return li;
}

function renderFailure(message: string): HTMLElement {
  const li = document.createElement('li');
  const panel = document.createElement('div');
  panel.className = 'failure';
  panel.append(iconSpan('alert', 17));
  const text = document.createElement('span');
  text.textContent = `The library could not be read: ${message}`;
  panel.append(text);
  li.append(panel);
  return li;
}

function renderFacts(summaries: RecordingSummary[]): void {
  const total = summaries.reduce((sum, s) => sum + s.sizeBytes, 0);
  const entries: [string, string, string?][] = [
    ['Recordings', String(summaries.length)],
    ['On disk', formatBytes(total)],
    ['Folder', displayRoot(), recordingsRoot],
  ];
  facts.replaceChildren(
    ...entries.map(([term, value, title]) => {
      const group = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (title !== undefined) dd.title = title;
      group.append(dt, dd);
      return group;
    }),
  );
}

/**
 * `~/Movies/Loom Clone`, or `…/last/two` for a root somewhere else.
 *
 * A masthead fact is a glance, not a reference: the full path is on the `title`
 * and one click away in Finder, and a wrapped absolute path would push the list
 * down the window for no gain.
 */
function displayRoot(): string {
  const home = /^\/Users\/[^/]+(\/.*)?$/.exec(recordingsRoot);
  if (home !== null) return `~${home[1] ?? ''}`;
  const segments = recordingsRoot.split('/').filter((s) => s.length > 0);
  return segments.length <= 2 ? recordingsRoot : `…/${segments.slice(-2).join('/')}`;
}

// ---------------------------------------------------------------- behaviour

async function performDelete(id: string): Promise<void> {
  pendingDelete = null;
  try {
    await loom.library.delete(id);
  } catch (error) {
    rows.replaceChildren(renderFailure(messageOf(error)));
    return;
  }
  await refresh();
}

async function refresh(): Promise<void> {
  refreshButton.disabled = true;
  try {
    const summaries = await loom.library.list();
    renderFacts(summaries);
    rows.replaceChildren(...(summaries.length === 0 ? [renderEmpty()] : summaries.map(renderRow)));
  } catch (error) {
    rows.replaceChildren(renderFailure(messageOf(error)));
  } finally {
    refreshButton.disabled = false;
    mountIcons();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------- permissions

/**
 * Say so when a recording could not start, and offer the one screen that can fix it.
 *
 * Only the blocking grants earn a banner. The optional three are a degraded recording
 * rather than no recording, and the captain's decision is explicit that declining them
 * must leave a working recorder — a permanent nag about them would be arguing with
 * an answer the user already gave.
 *
 * **§7.2's disk refusal shares the banner and not the button.** It is the other thing
 * that stops a recording starting, so it belongs where a user already looks to find
 * out why — but the fix is deleting files rather than pressing Allow, so it does not
 * bring "Open setup" with it. The sentence is `DISK_COPY.refusal`, main's own words
 * for the refusal it will throw, so the warning here and the error the Record button
 * would produce cannot disagree.
 */
function renderPreflight(preflight: PreflightReport): void {
  renderCapacity(preflight.disk);

  // Two states, three branches. `blocking` is empty exactly when the one required
  // grant is held, so a preflight that is not ready with nothing blocking is the
  // disk and can only be the disk.
  const diskRefused = !preflight.ready && preflight.blocking.length === 0;
  if (diskRefused) {
    const text = document.createElement('p');
    text.textContent = DISK_COPY.refusal(preflight.disk);
    permBanner.replaceChildren(iconSpan('alert', 17), text);
    permBanner.hidden = false;
    return;
  }

  if (preflight.blocking.length > 0) {
    const text = document.createElement('p');
    text.textContent = preflight.blocking
      .map((kind) => describePermission(kind, preflight.report.statuses[kind]))
      .join(' ');
    const open = button('Open setup', 'btn btn-sm');
    open.prepend(iconSpan('lock', 14));
    open.addEventListener('click', () => {
      loom.setup.open();
    });
    permBanner.replaceChildren(iconSpan('alert', 17), text, open);
    permBanner.hidden = false;
    return;
  }

  permBanner.hidden = true;
  permBanner.replaceChildren();
}

/**
 * §7.2's *"Show estimated capacity: '≈ 42 min available'"*, which until now was
 * written and never rendered.
 *
 * The words are `DISK_COPY.capacity` verbatim rather than a number re-derived here:
 * main measures the volume, `@loom/ipc` decides what the measurement means, and a
 * second arithmetic in a renderer is how the masthead and the HUD's banner come to
 * say different things about one disk. Provenance rides along in that sentence —
 * "at what your recordings have averaged" against "at a typical recording's size" —
 * because §5.6 measured a 35× spread and the second of those is somebody else's
 * screen.
 *
 * A reading that could not be taken shows nothing at all. `DISK_COPY.capacity` has a
 * sentence for it, but a permanent "free space could not be measured" on the masthead
 * is a fault report about an instrument, and §7.2's monitor is explicitly an accessory.
 */
function renderCapacity(disk: DiskReading): void {
  if (disk.capacitySec === null) {
    diskCapacity.hidden = true;
    diskCapacity.textContent = '';
    return;
  }
  diskCapacity.textContent = DISK_COPY.capacity(disk);
  diskCapacity.hidden = false;
}

// --------------------------------------------------------------- recovery

/**
 * §7.1 step 5, finally on a screen: *"Show the user … Never silently discard, never
 * silently pretend it was clean."*
 *
 * Recovery runs at launch and, until this, reported only to a console — so a user
 * whose app was killed mid-recording came back to a library in which the repaired
 * recording looked exactly like every other recording. That is the *"silently
 * pretend it was clean"* half of §7.1's sentence, reached by omission.
 *
 * **Every number is the repair's own.** `RECOVERY_COPY` reads `recoveredSec`,
 * `frameCount` and `truncatedBytes` off the {@link RecoveryReport}
 * `ProjectStore.recoverBundle` produced by scanning the bytes that survived; nothing
 * here states a guarantee. That matters because this project's guarantee is
 * frame-level — the fragment writer holds one sample — and a fixed "up to a second
 * was lost" would be describing a design that was superseded.
 *
 * It stays until the window is closed. There is no dismiss: the notice is about
 * something that happened to the user's footage, it is one banner, and a user who
 * reloads to check what it said should find it still there.
 */
function renderRecovery(reports: readonly RecoveryReport[]): void {
  if (reports.length === 0) {
    recoveryBanner.hidden = true;
    recoveryBanner.replaceChildren();
    return;
  }

  const body = document.createElement('div');
  body.className = 'recovery-body';

  const heading = document.createElement('p');
  heading.className = 'recovery-heading';
  heading.textContent = RECOVERY_COPY.heading(reports);
  body.append(heading);

  for (const report of reports) {
    const line = document.createElement('p');
    line.textContent = report.recovered
      ? RECOVERY_COPY.recovered(report)
      : RECOVERY_COPY.failed(report);
    body.append(line);
  }

  recoveryBanner.replaceChildren(iconSpan('restart', 17), body);
  recoveryBanner.hidden = false;
}

async function refreshRecovery(): Promise<void> {
  try {
    renderRecovery(await loom.library.recovery());
  } catch (error) {
    // Asked once, at load. A pass whose result could not be fetched is not a claim
    // this window may invent one for — the alternative to saying nothing here is
    // saying something wrong about somebody's footage.
    console.error('[library] the recovery report could not be read:', error);
    recoveryBanner.hidden = true;
  }
}

async function refreshPermissions(): Promise<void> {
  try {
    renderPreflight(await loom.recorder.preflight());
  } catch (error) {
    // A preflight this window could not run is not a permission problem, and
    // claiming one would send the user to a screen that has nothing to fix.
    console.error('[library] preflight failed:', error);
    permBanner.hidden = true;
    // Including the estimate: a stale "≈ 42 min available" beside a preflight that
    // could not be run is a number nothing currently stands behind.
    diskCapacity.hidden = true;
  }
}

async function start(): Promise<void> {
  const info = await loom.app.info();
  recordingsRoot = info.recordingsRoot;
  document.title = 'Recordings';

  newRecordingButton.addEventListener('click', () => {
    // The library opens the HUD; the HUD owns the recording. Two windows, one
    // job each (§1.2).
    loom.recorder.open();
  });
  refreshButton.addEventListener('click', () => {
    void refresh();
  });
  revealRootButton.addEventListener('click', () => {
    loom.app.revealRecordingsRoot();
  });
  // The route back to the first-run explanation, whether or not anything is wrong
  // right now: the four grants can be changed in System Settings at any time, and
  // this is the window that is open when someone wants to.
  permissionsButton.addEventListener('click', () => {
    loom.setup.open();
  });
  // macOS never tells an app a grant was given. Main re-probes on focus and pushes
  // what changed, which is what keeps this banner honest without a poll.
  loom.permissions.onChange(() => {
    void refreshPermissions();
  });
  // A recording that starts or finishes elsewhere still changes this list. Status
  // arrives four times a second while recording, and a refresh measures every
  // bundle on disk, so this reacts to the phase *changing* rather than to being
  // told about it.
  let lastPhase: RecorderStatus['phase'] = 'idle';
  loom.recorder.onStatus((status) => {
    if (status.phase === lastPhase) return;
    lastPhase = status.phase;
    void refresh();
  });
  // The export sheet's only channel. Subscribed once, for the window's life, rather
  // than per export: main broadcasts to every window, and a job started here
  // outlives any particular render of the row it came from.
  loom.export.onProgress(onExportProgress);
  // Escape backs out of a pending delete, the same way it cancels the countdown. It
  // closes a *finished or unstarted* export sheet too, and deliberately does not
  // cancel a running export: a key pressed by accident must not throw away four
  // minutes of encoding.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (pendingDelete !== null) {
      pendingDelete = null;
      void refresh();
    }
    if (exportSheet !== null && (exportSheet.jobId === null || exportSheet.done)) {
      exportSheet = null;
      exportStatusNode = null;
      void refresh();
    }
  });

  await refresh();
  await refreshPermissions();
  // Last, and once: §7.1's pass finished before this window was created, so there is
  // nothing to keep up with — and it goes after the list so the banner appears over
  // a library that already shows the recording it is talking about.
  await refreshRecovery();
}

void start();
