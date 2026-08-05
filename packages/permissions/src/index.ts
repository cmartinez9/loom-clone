/**
 * `@loom/permissions` — the macOS TCC model. Phase 2.
 *
 * ```ts
 * import { PERMISSIONS, canRecord, isTrustworthy } from '@loom/permissions';
 * ```
 *
 * This entry point is **pure**: no `electron`, no `node:`, no DOM. It holds what is
 * true about the four grants regardless of who is asking — what each is for, what
 * breaks without it, which System Settings pane turns it on, and what may be
 * concluded from a given set of answers.
 *
 * The Electron calls that produce those answers live in
 * `apps/main/src/permissions.ts`. The split is the same one `@loom/format` makes
 * between the format and the filesystem, and it buys the same thing: the policy is
 * unit-testable without launching an app, and there is exactly one file in the repo
 * that talks to `systemPreferences`.
 *
 * **The one rule this package exists to enforce:** a `granted` from macOS is only
 * meaningful if macOS was talking about *us*. See {@link isTrustworthy} and the
 * header of `report.ts` — a dev binary inherits its terminal's grants and reports
 * `granted` for a permission it does not have (research report §7, trap 6).
 */

export {
  PERMISSIONS,
  PERMISSION_KINDS,
  PERMISSION_LIST,
  isPermissionKind,
  isSettingsUrl,
  toRecordingState,
  type PermissionFacts,
  type PermissionKind,
  type PermissionStatus,
  type RequestMode,
} from './kinds.ts';

export {
  allGranted,
  blockingKinds,
  canRecord,
  concludeAccessibility,
  degradedKinds,
  describeAccessibility,
  describePermission,
  describeProvenance,
  isSettled,
  isTrustworthy,
  relaunchRequired,
  summarize,
  type AccessibilityConclusion,
  type AccessibilityDetail,
  type PermissionReport,
  type ReportProvenance,
} from './report.ts';
