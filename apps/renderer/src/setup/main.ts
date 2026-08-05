/**
 * The first-run window. Phase 2.
 *
 * The captain settled the shape (`data/loom-scope/decision-accessibility-clicks.md`):
 * **ask up front** — Screen Recording, Camera, Microphone and Accessibility together,
 * as one deliberate onboarding step, explaining each in plain language and saying
 * what breaks without it. He chose completeness over a frictionless first launch.
 * The approved visual design is `data/loom-design/a-permissions.html`.
 *
 * ## Three things this window will not do
 *
 * 1. **It will not show a tick it has not earned.** Accessibility renders as
 *    *granted but unverified* when macOS trusts the app and nothing has proven a
 *    click actually arrives. That is the state this build is genuinely in until
 *    phase 5's sampler is wired up, and pretending otherwise is the exact failure the
 *    captain's decision was written to prevent.
 * 2. **It will not present an untrustworthy answer as an answer.** A dev binary
 *    inherits its terminal's grants and reports `granted` for permissions it does not
 *    have (research report §7, trap 6). When the report says so, this window says so.
 * 3. **It will not block on the optional three.** Continue is always available. A
 *    user who declines Accessibility gets a fully working recorder — cursor-follow by
 *    position, manual zoom and everything else — and only click-triggered auto-zoom
 *    and click highlights degrade.
 */

import '@loom/design/css';
import './setup.css';
import { icon, mountIcons, type IconName } from '@loom/design';
import {
  PERMISSIONS,
  PERMISSION_LIST,
  blockingKinds,
  concludeAccessibility,
  describeAccessibility,
  describeProvenance,
  isTrustworthy,
  relaunchRequired,
  type PermissionFacts,
  type PermissionKind,
  type PermissionReport,
  type PermissionStatus,
} from '@loom/permissions';

const loom = window.loom;

const permsList = must('perms');
const blockedCard = must('blocked-card');
const blockedTitle = must('blocked-title');
const blockedText = must('blocked-text');
const blockedSteps = must('blocked-steps');
const openSettingsButton = must('open-settings') as HTMLButtonElement;
const relaunchButton = must('relaunch') as HTMLButtonElement;
const untrustedBox = must('untrusted');
const untrustedText = must('untrusted-text');
const continueButton = must('continue') as HTMLButtonElement;

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`setup.html is missing #${id}`);
  return element;
}

/** One glyph per permission, from the design system's set. Never an emoji (§8). */
const GLYPH: Record<PermissionKind, IconName> = {
  screen: 'screen',
  camera: 'cam',
  microphone: 'mic',
  accessibility: 'cursor',
};

/**
 * Which permission the refusal card is currently talking about.
 *
 * One card, not four: showing a numbered "go to System Settings" walkthrough for
 * every unanswered permission at once is a wall of instructions for a user who has
 * not refused anything yet. It names the most important unresolved one.
 */
let focused: PermissionKind | null = null;
let current: PermissionReport | null = null;

// ------------------------------------------------------------------ rendering

function render(report: PermissionReport): void {
  current = report;
  permsList.replaceChildren(...PERMISSION_LIST.map((facts) => row(facts, report)));

  renderProvenance(report);
  renderBlocked(report);
  mountIcons(permsList);
}

function row(facts: Readonly<PermissionFacts>, report: PermissionReport): HTMLLIElement {
  const status = report.statuses[facts.kind];
  const li = document.createElement('li');
  li.className = 'perm';
  li.dataset['state'] = status;
  li.dataset['optional'] = String(!facts.required);
  // Accessibility's wire status is honest and blunt: `AXIsProcessTrusted()` is a
  // boolean, so "refused" and "never asked" are both `denied`, and "trusted" is not
  // the same claim as "clicks arrive". Both ends of that row are styled from the
  // conclusion instead — a first-run screen must not paint the most invasive ask in
  // refusal red before it has been asked, and must not tick it before anything has
  // watched an event arrive.
  const conclusion =
    facts.kind === 'accessibility' ? concludeAccessibility(report.accessibility) : null;
  if (conclusion !== null) li.dataset['ax'] = conclusion;

  // A row that has what it asked for swaps its subject glyph for a tick: it is no
  // longer asking for a camera, it is reporting one. For the three media grants
  // `granted` is that fact. For Accessibility only `live` is — this file's rule 1.
  const earned = conclusion === null ? status === 'granted' : conclusion === 'live';
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.innerHTML = icon(earned ? 'check' : GLYPH[facts.kind], 19);

  const body = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'ttl';
  const heading = document.createElement('h2');
  heading.textContent = facts.title;
  const tag = document.createElement('span');
  tag.className = facts.required ? 'tag tag-req' : 'tag';
  tag.textContent = facts.required ? 'Required' : 'Optional';
  title.append(heading, tag);

  const why = document.createElement('p');
  why.className = 'why';
  why.textContent = facts.why;

  const limit = document.createElement('p');
  limit.className = 'limit';
  limit.textContent = facts.limit;

  body.append(title, why, limit);
  li.append(glyph, body, action(facts, report));
  return li;
}

/**
 * The right-hand control for one row.
 *
 * Accessibility is the row that cannot be a tick or a button, because "macOS trusts
 * us" and "clicks are arriving" are different facts and only the second one is worth
 * a tick. Its states are spelled out in `describeAccessibility`.
 */
function action(facts: Readonly<PermissionFacts>, report: PermissionReport): HTMLElement {
  const wrap = document.createElement('div');

  if (facts.kind === 'accessibility') {
    const conclusion = concludeAccessibility(report.accessibility);
    if (conclusion === 'live') {
      wrap.append(ok('Granted'));
      return wrap;
    }
    if (conclusion === 'trusted-unverified') {
      // Deliberately not a tick. macOS says yes; nothing has watched an event
      // arrive, and this build has no way to.
      wrap.append(note('Granted · unverified'));
      return wrap;
    }
    if (conclusion === 'relaunch-required' || conclusion === 'relaunch-to-find-out') {
      wrap.append(
        button('Relaunch', () => {
          loom.permissions.relaunch();
        }),
      );
      return wrap;
    }
    wrap.append(button('Allow', () => void ask(facts.kind), true));
    return wrap;
  }

  const status = report.statuses[facts.kind];
  if (status === 'granted') {
    wrap.append(ok('Granted'));
    return wrap;
  }
  if (status === 'restricted') {
    // Nothing the user can do from here: a profile or Screen Time is holding it.
    wrap.append(note('Blocked by policy'));
    return wrap;
  }
  if (status === 'denied') {
    // macOS will not re-prompt once answered. The only route is System Settings,
    // so the button says where it goes rather than pretending to ask again.
    wrap.append(
      button('Settings…', () => {
        focused = facts.kind;
        loom.permissions.openSettings(facts.kind);
        renderBlockedFor(facts.kind);
      }),
    );
    return wrap;
  }
  wrap.append(button('Allow', () => void ask(facts.kind), facts.required));
  return wrap;
}

function ok(label: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'state-ok';
  span.innerHTML = icon('check', 14);
  span.append(document.createTextNode(` ${label}`));
  return span;
}

function note(label: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'state-note';
  span.textContent = label;
  return span;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = primary ? 'btn btn-primary btn-sm' : 'btn btn-sm';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

async function ask(kind: PermissionKind): Promise<void> {
  focused = kind;
  render(await loom.permissions.request(kind));
  renderBlockedFor(kind);
}

// ------------------------------------------------------------ the refusal path

/**
 * Pick the permission worth explaining, if any.
 *
 * Screen Recording first when it is missing — without it there is no app. Then
 * whatever the user just interacted with, if that is still unresolved. Otherwise
 * nothing, and the card stays hidden.
 */
function subjectOf(report: PermissionReport): PermissionKind | null {
  const blocking = blockingKinds(report);
  if (blocking.length > 0) return blocking[0] ?? null;
  if (relaunchRequired(report)) return 'accessibility';
  if (focused !== null && report.statuses[focused] !== 'granted') return focused;
  return null;
}

function renderBlocked(report: PermissionReport): void {
  const subject = subjectOf(report);
  if (subject === null) {
    blockedCard.hidden = true;
    return;
  }
  renderBlockedFor(subject);
}

function renderBlockedFor(kind: PermissionKind): void {
  const report = current;
  if (report === null) return;
  const facts = PERMISSIONS[kind];
  const status = report.statuses[kind];
  if (status === 'granted' && !(kind === 'accessibility' && relaunchRequired(report))) {
    blockedCard.hidden = true;
    return;
  }

  blockedCard.hidden = false;
  blockedTitle.textContent = facts.title;
  blockedText.textContent = explain(kind, status, report);
  blockedSteps.replaceChildren(...steps(facts).map(step));

  openSettingsButton.onclick = (): void => {
    loom.permissions.openSettings(kind);
  };
  // The relaunch control is only meaningful for the two permissions whose grant does
  // not reach a running process. Offering it for a Camera denial would be an action
  // that cannot change the outcome.
  relaunchButton.hidden = !facts.needsRelaunch;
  relaunchButton.onclick = (): void => {
    loom.permissions.relaunch();
  };
}

function explain(kind: PermissionKind, status: PermissionStatus, report: PermissionReport): string {
  if (kind === 'accessibility') {
    return describeAccessibility(concludeAccessibility(report.accessibility));
  }
  const facts = PERMISSIONS[kind];
  if (status === 'denied') {
    return (
      `${facts.title} is off, so ${facts.whatBreaks.charAt(0).toLowerCase()}${facts.whatBreaks.slice(1)} ` +
      'macOS will not re-ask once you have answered, and it needs the app relaunched after you ' +
      'change it. Both of those are its rules, not ours.'
    );
  }
  return `${facts.title} has not been granted yet. ${facts.whatBreaks}`;
}

function steps(facts: Readonly<PermissionFacts>): string[] {
  const list = [`Open System Settings › ${facts.settingsPaneName}`, 'Switch Loom Clone on'];
  list.push(
    facts.needsRelaunch
      ? 'Come back — we will relaunch for you'
      : 'Come back — this window updates itself',
  );
  return list;
}

function step(text: string, index: number): HTMLLIElement {
  const li = document.createElement('li');
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = String(index + 1);
  const body = document.createElement('span');
  body.textContent = text;
  li.append(n, body);
  return li;
}

// ------------------------------------------------------------ provenance

function renderProvenance(report: PermissionReport): void {
  const problem = describeProvenance(report);
  untrustedBox.hidden = problem === null;
  if (problem !== null) untrustedText.textContent = problem;
  // Belt and braces on the same fact, so a future edit cannot make the box
  // conditional on something other than the rule it exists to enforce.
  if (isTrustworthy(report)) untrustedBox.hidden = true;
}

// ------------------------------------------------------------------- wiring

continueButton.addEventListener('click', () => {
  continueButton.disabled = true;
  void loom.setup.complete().catch(() => {
    // The window is about to be replaced by the library; if that failed, letting
    // the user try again is the only useful response.
    continueButton.disabled = false;
  });
});

// macOS never tells an app a grant was given. Main re-probes when a window regains
// focus, which is what makes coming back from System Settings update this list
// without a "check again" button.
loom.permissions.onChange(render);

mountIcons();
void loom.permissions.probe().then(render);
