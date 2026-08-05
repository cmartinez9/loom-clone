/**
 * The shape of a verification result, and the one rule that makes the whole harness
 * worth running.
 *
 * ## The rule
 *
 * **No check may report `pass` from a build whose permission answers cannot be
 * believed.** `sealReport` enforces it by rewriting every `pass` to `untrusted` when
 * the report's provenance says so, *after* the checks have run and with no way for a
 * check to opt out. It is one function, so weakening the rule is a visible diff
 * rather than a check that quietly started lying.
 *
 * That is the phase 2 gate from architecture report §8 — *"Run from a signed bundle,
 * not a dev binary — dev inherits Terminal's TCC and lies to you"* — expressed as
 * code rather than as a note in a report that someone has to remember.
 *
 * Pure: no electron, no node. The checks that need both live in
 * `permissions-harness.ts`; this file is what they produce and is testable on its own.
 */

import type { PermissionReport, ReportProvenance } from '@loom/permissions';

export type CheckStatus =
  /** Ran, and the thing it checks is true. Only reachable from a trustworthy build. */
  | 'pass'
  /** Ran, and the thing it checks is false. A real defect. */
  | 'fail'
  /**
   * Could not run, because something it needs is missing — a permission, a
   * control that did not behave, a helper that is not in this build.
   *
   * Distinct from `fail` on purpose: "we could not look" and "we looked and it was
   * broken" are different reports, and collapsing them is how a blocked check gets
   * read as a passing one.
   */
  | 'blocked'
  /** Deliberately not run in this configuration. */
  | 'skipped'
  /** Would have passed, but the build cannot be trusted to say so. */
  | 'untrusted';

export interface CheckResult {
  id: string;
  title: string;
  /**
   * The carried-forward obligation this closes, in phase 1's own words (architecture
   * report §11; `AGENTS.md` § Phase 2 gate status is where their state is kept).
   * Present only on the checks that exist to close one.
   */
  obligation?: string;
  status: CheckStatus;
  /** One sentence a person can act on. Always populated, including on a pass. */
  detail: string;
  /** Raw measurements, so a reader can disagree with the verdict. */
  data?: Record<string, unknown>;
}

export interface VerifyReport {
  startedAt: string;
  finishedAt: string;
  bundleId: string;
  appVersion: string;
  electronVersion: string;
  macosVersion: string;
  /** `app.isPackaged` and the responsible-process inference, from the probe. */
  provenance: ReportProvenance;
  trustworthy: boolean;
  permissions: PermissionReport;
  checks: CheckResult[];
  /**
   * `verified` only when the build was trustworthy and every check that ran passed.
   * `incomplete` when something was blocked or skipped. `failed` when anything failed.
   */
  outcome: 'verified' | 'incomplete' | 'failed';
}

/**
 * Apply the rule, then decide the outcome.
 *
 * The order matters: downgrade first, so that `outcome` is computed from statuses
 * that have already had the trust rule applied to them. A run from a dev binary can
 * therefore never produce `verified`, no matter what the individual checks saw.
 */
export function sealReport(
  draft: Omit<VerifyReport, 'outcome' | 'trustworthy'> & { trustworthy: boolean },
  /**
   * Checks exempt from the downgrade because they are *about* trust rather than
   * dependent on it — `bundle-identity` reports honestly on an untrustworthy build,
   * which is the whole point of it.
   */
  alwaysHonest: readonly string[] = ['bundle-identity'],
): VerifyReport {
  const checks = draft.checks.map((check) => {
    if (draft.trustworthy) return check;
    if (alwaysHonest.includes(check.id)) return check;
    if (check.status !== 'pass') return check;
    return {
      ...check,
      status: 'untrusted' as const,
      detail:
        `${check.detail} — but this build's permission answers cannot be believed, ` +
        'so this is not a pass. Re-run from a signed bundle launched by LaunchServices.',
    };
  });

  const outcome = checks.some((c) => c.status === 'fail')
    ? 'failed'
    : checks.every((c) => c.status === 'pass')
      ? 'verified'
      : 'incomplete';

  return { ...draft, checks, outcome };
}

/** A short human-readable rendering, for the terminal that launched the run. */
export function formatReport(report: VerifyReport): string {
  const mark: Record<CheckStatus, string> = {
    pass: 'PASS ',
    fail: 'FAIL ',
    blocked: 'BLOCK',
    skipped: 'SKIP ',
    untrusted: 'UNTRU',
  };
  const lines = [
    `loom-clone permission verification — ${report.outcome.toUpperCase()}`,
    `  bundle    ${report.bundleId} ${report.appVersion}`,
    `  electron  ${report.electronVersion}   macOS ${report.macosVersion}`,
    `  packaged  ${String(report.provenance.packaged)}   ` +
      `responsible-for-self ${String(report.provenance.responsibleForSelf)}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`  [${mark[check.status]}] ${check.title}`);
    lines.push(`          ${check.detail}`);
    if (check.obligation !== undefined) lines.push(`          closes: ${check.obligation}`);
  }
  if (!report.trustworthy) {
    lines.push(
      '',
      '  Nothing above may be described as verified. A dev binary — or a packaged app',
      '  launched from a shell — inherits the launching process’s TCC grants and',
      '  reports permissions it does not have (research report §7, trap 6).',
    );
  }
  return lines.join('\n');
}
