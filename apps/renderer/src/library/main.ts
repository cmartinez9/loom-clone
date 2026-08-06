/**
 * The library window.
 *
 * Vanilla TypeScript and the design system, no framework. Phase 0's job is the
 * skeleton, and picking a UI framework for the editor is a decision phase 6/7 gets
 * to make with the compositor in front of them rather than one this file imposes.
 *
 * Everything this window can do is `window.loom` — the preload surface. There is
 * no `fs`, no `require`, no network. That is the point (§0, rule 2).
 */

import '@loom/design/css';
import './library.css';
import { formatBytes, formatDuration, formatRelativeDate, icon, mountIcons } from '@loom/design';
import type { ProjectState, RecordingSummary } from '@loom/format';
import type { PreflightReport, RecorderStatus } from '@loom/ipc';
import { describePermission } from '@loom/permissions';

const loom = window.loom;

const rows = must('rows');
const facts = must('facts');
const refreshButton = must('refresh') as HTMLButtonElement;
const revealRootButton = must('reveal-root');
const newRecordingButton = must('new-recording');
const permissionsButton = must('permissions');
const permBanner = must('perm-banner');

/** An element the page is required to contain; a missing one is a broken build. */
function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`library.html is missing #${id}`);
  return element;
}

/** The id whose delete is awaiting a second click, if any. */
let pendingDelete: string | null = null;
let recordingsRoot = '';

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

const STATE_NOTES: Partial<Record<ProjectState, string>> = {
  recording: 'A recording was in progress when the app last closed.',
  'needs-recovery': 'This will be repaired and truncated to the last complete frame when opened.',
  exported: 'The sources were deleted after the export was verified. This recording is final.',
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

function renderActions(summary: RecordingSummary): HTMLElement {
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
 */
function renderPreflight(preflight: PreflightReport): void {
  if (preflight.blocking.length === 0) {
    permBanner.hidden = true;
    permBanner.replaceChildren();
    return;
  }

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
}

async function refreshPermissions(): Promise<void> {
  try {
    renderPreflight(await loom.recorder.preflight());
  } catch (error) {
    // A preflight this window could not run is not a permission problem, and
    // claiming one would send the user to a screen that has nothing to fix.
    console.error('[library] preflight failed:', error);
    permBanner.hidden = true;
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
  // Escape backs out of a pending delete, the same way it cancels the countdown.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pendingDelete !== null) {
      pendingDelete = null;
      void refresh();
    }
  });

  await refresh();
  await refreshPermissions();
}

void start();
