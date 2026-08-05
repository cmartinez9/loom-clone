/**
 * The permission report: what macOS currently says, what we may conclude from it,
 * and — the part most permission code leaves out — **whether the answer can be
 * believed at all**.
 *
 * ## Why a report carries its own provenance
 *
 * Research report §7, trap 6, measured on this machine: an unsigned dev binary
 * reports `getMediaAccessStatus('screen') = granted` while `Electron` never appears
 * in System Settings at all. TCC attributed the grant to the *responsible process* —
 * the terminal that launched it — and the dev build inherited it. Screen capture
 * genuinely worked.
 *
 * So `granted` is not one fact, it is two: what TCC said, and whether TCC was
 * talking about us. A report that carries only the first is a report that will tell
 * a developer their permission flow works when what works is their terminal's
 * permission. {@link ReportProvenance} is the second fact, and
 * {@link isTrustworthy} is the gate every claim of "verified" in this phase has to
 * pass.
 *
 * Architecture report §8 makes that the phase 2 gate in so many words: *"Run from a
 * signed bundle, not a dev binary — dev inherits Terminal's TCC and lies to you."*
 */

import {
  PERMISSION_KINDS,
  PERMISSIONS,
  type PermissionKind,
  type PermissionStatus,
} from './kinds.ts';

/**
 * What the click event tap can be observed doing, separately from what TCC claims.
 *
 * The captain's decision is explicit about why these are two fields and not one:
 * *"Verify with `AXIsProcessTrusted()`, never by assuming. The click API succeeds
 * without permission and then silently delivers zero events with no error."* One
 * boolean cannot hold both "macOS trusts us" and "events are actually arriving",
 * and collapsing them is how the failure the decision describes gets shipped.
 */
export interface AccessibilityDetail {
  /**
   * `AXIsProcessTrusted()`, read through
   * `systemPreferences.isTrustedAccessibilityClient(false)`.
   *
   * The `false` matters: `true` fires the system prompt, which makes a *status
   * check* a user-visible event (research §5.3, note 6). Polling with `true` would
   * pop a dialog every time the setup window refreshed.
   */
  axTrusted: boolean;
  /**
   * Whether a live tap is proven to be delivering events. `null` means **nobody has
   * looked** — not "no".
   *
   * Only `@loom/sampler`'s helper can answer this, because answering it means
   * building a real `CGEventTap` and reading `tapIsEnabled`. When the sampler is not
   * in the build, or has not been started, this stays `null` and every consumer is
   * forced to say "unverified" instead of inventing a pass.
   */
  tapLive: boolean | null;
  /**
   * `true` while this app has sent the user to the Accessibility pane and does not
   * yet know what came of it.
   *
   * This is the half of the restart problem phase 5 explicitly left to phase 2. From
   * inside the sampler, "the user just switched us on in System Settings but
   * `AXIsProcessTrusted()` has not caught up" is indistinguishable from "never
   * granted". Only the side that opened the pane knows the difference is worth
   * offering a relaunch over.
   *
   * It is deliberately *not* "has ever asked". The ask outlives the process that
   * made it — that is the whole reason it is on disk — but a relaunch that comes back
   * with `axTrusted` still `false` has answered it, and the prober spends it there.
   * Left standing, this field turns {@link AccessibilityConclusion} into
   * `relaunch-to-find-out` on every launch for the rest of the install.
   */
  settingsOpened: boolean;
}

/**
 * What can honestly be concluded about Accessibility. Five outcomes, because the
 * three-way collapse ("on / off / pending") loses the two that need a relaunch
 * button and the one that needs the word *unverified*.
 */
export type AccessibilityConclusion =
  /** Trusted, and a tap has been observed delivering. The only state that is proven. */
  | 'live'
  /** Trusted, but no tap has been built, so delivery is claimed by TCC and unproven by us. */
  | 'trusted-unverified'
  /** Trusted and the tap is dead. An Accessibility grant does not reach a running process. */
  | 'relaunch-required'
  /** Not trusted, but we sent the user to the pane this session — a relaunch settles it. */
  | 'relaunch-to-find-out'
  /** Not trusted and never asked for. The launch default, and a perfectly usable one. */
  | 'not-granted';

export function concludeAccessibility(detail: AccessibilityDetail): AccessibilityConclusion {
  if (detail.axTrusted) {
    if (detail.tapLive === true) return 'live';
    if (detail.tapLive === false) return 'relaunch-required';
    return 'trusted-unverified';
  }
  return detail.settingsOpened ? 'relaunch-to-find-out' : 'not-granted';
}

/**
 * Where this report came from, and therefore how much it is worth.
 *
 * Both fields have to be true for a `granted` to mean "granted **to this app**".
 */
export interface ReportProvenance {
  /** `app.isPackaged` — false means this is a dev binary and §8's gate is not met. */
  packaged: boolean;
  /**
   * Whether TCC is attributing our requests to us rather than to whatever launched
   * us (research §7, trap 6).
   *
   * There is no public API for the responsible process, so this is inferred from the
   * launch: an app started by LaunchServices (`open -a`, or a double click) is its
   * own responsible process and reports `ppid === 1`; one started from a shell
   * inherits that shell's grants. The inference is stated here rather than hidden in
   * the prober so that a future, better test can replace it without any consumer
   * changing.
   */
  responsibleForSelf: boolean;
}

export interface PermissionReport {
  statuses: Readonly<Record<PermissionKind, PermissionStatus>>;
  accessibility: AccessibilityDetail;
  provenance: ReportProvenance;
}

/**
 * Whether anything in this report may be described as **verified**.
 *
 * This is the mechanical form of the phase 2 gate. A check that runs against an
 * untrustworthy report may report what it saw; it may not report a pass. Every
 * consumer in this phase — the setup window, the preflight, the signed-bundle
 * harness — routes its "did it pass" question through here, so there is exactly one
 * place where the rule could be weakened, and weakening it is a visible diff.
 */
export function isTrustworthy(report: PermissionReport): boolean {
  return report.provenance.packaged && report.provenance.responsibleForSelf;
}

/** Why a report is untrustworthy, phrased for a developer to act on. */
export function describeProvenance(report: PermissionReport): string | null {
  const { packaged, responsibleForSelf } = report.provenance;
  if (packaged && responsibleForSelf) return null;
  if (!packaged) {
    return (
      'This is a development build. macOS attributes permission requests to the ' +
      'process that launched it — usually your terminal — so these statuses describe ' +
      'that process, not this app. Package and sign the bundle before trusting them ' +
      '(research report §7, trap 6).'
    );
  }
  return (
    'This packaged app was launched from another process, which macOS may hold ' +
    'responsible for its permissions instead of the app itself. Launch it with ' +
    '`open -a` or from Finder before trusting these statuses.'
  );
}

// ------------------------------------------------------------------- derived

/**
 * The one question the recorder asks. Screen Recording is the only required grant;
 * everything else subtracts a feature rather than the app.
 */
export function canRecord(report: PermissionReport): boolean {
  return report.statuses.screen === 'granted';
}

/** Required grants that are missing. Empty means the recorder can run. */
export function blockingKinds(report: PermissionReport): PermissionKind[] {
  return PERMISSION_KINDS.filter(
    (kind) => PERMISSIONS[kind].required && report.statuses[kind] !== 'granted',
  );
}

/**
 * Optional grants that are missing — the features the user has silently lost.
 *
 * Surfaced rather than swallowed: the captain's decision requires a user who
 * declines Accessibility to still get a working recorder, and a working recorder
 * that quietly stops auto-zooming is not the same thing as one that says so.
 */
export function degradedKinds(report: PermissionReport): PermissionKind[] {
  return PERMISSION_KINDS.filter(
    (kind) => !PERMISSIONS[kind].required && report.statuses[kind] !== 'granted',
  );
}

/**
 * Whether a relaunch would change anything.
 *
 * Only ever true for Accessibility. Screen Recording also needs a relaunch after a
 * *change*, but we cannot tell a fresh denial from a just-changed one, and offering
 * a restart to a user who simply said no is noise.
 */
export function relaunchRequired(report: PermissionReport): boolean {
  const conclusion = concludeAccessibility(report.accessibility);
  return conclusion === 'relaunch-required' || conclusion === 'relaunch-to-find-out';
}

/**
 * Whether first-run setup has nothing left to ask for.
 *
 * Note this is *not* the condition for finishing setup. The captain's decision lets
 * a user decline the three optional grants and still record; setup completes when
 * they say it does. This only answers "is there still an unanswered ask".
 */
export function allGranted(report: PermissionReport): boolean {
  return PERMISSION_KINDS.every((kind) => report.statuses[kind] === 'granted');
}

/** A permission macOS has already answered and will not re-prompt for. */
export function isSettled(status: PermissionStatus): boolean {
  return status === 'granted' || status === 'denied' || status === 'restricted';
}

// ---------------------------------------------------------------- description

/**
 * One line about one permission, for a log, a preflight or a status row.
 *
 * Deliberately mirrors `describeClickCapability()` in `@loom/sampler` and for the
 * same reason: main's logs, the window and any report must not each phrase the same
 * state differently, or a bug report becomes a translation exercise.
 */
export function describePermission(kind: PermissionKind, status: PermissionStatus): string {
  const facts = PERMISSIONS[kind];
  switch (status) {
    case 'granted':
      return `${facts.title} is granted.`;
    case 'denied':
      return `${facts.title} was refused. ${facts.whatBreaks} macOS will not ask again — it has to be changed in ${facts.settingsPaneName}.`;
    case 'restricted':
      return `${facts.title} is blocked by a policy on this Mac (Screen Time or a device-management profile). ${facts.whatBreaks}`;
    case 'not-determined':
      return `${facts.title} has not been asked for yet. ${facts.whatBreaks}`;
    case 'unknown':
      return `macOS did not say whether ${facts.title} is granted. Treating it as not granted.`;
  }
}

/** One line about the Accessibility conclusion, including the two relaunch cases. */
export function describeAccessibility(conclusion: AccessibilityConclusion): string {
  switch (conclusion) {
    case 'live':
      return 'Click capture is live.';
    case 'trusted-unverified':
      return (
        'macOS trusts this app for Accessibility. Whether clicks are actually arriving ' +
        'has not been checked — that takes a live event tap.'
      );
    case 'relaunch-required':
      return (
        'Accessibility is granted, but the permission only reaches this app after a ' +
        'restart. Relaunch to turn click capture on.'
      );
    case 'relaunch-to-find-out':
      return (
        'If you switched this app on in System Settings, it needs a restart before ' +
        'macOS will let it see clicks. Relaunch to find out.'
      );
    case 'not-granted':
      return 'Click capture is off. ' + PERMISSIONS.accessibility.whatBreaks;
  }
}

/** The whole report in one line, for a main-process log. */
export function summarize(report: PermissionReport): string {
  const parts = PERMISSION_KINDS.map((kind) => `${kind}=${report.statuses[kind]}`);
  parts.push(`ax=${concludeAccessibility(report.accessibility)}`);
  if (!isTrustworthy(report)) parts.push('UNTRUSTWORTHY');
  return parts.join(' ');
}
