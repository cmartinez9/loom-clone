/**
 * App settings. Architecture report §2.1 calls the recordings root "configurable"
 * but does not specify a file for it; phase 0 gives it one, versioned like every
 * other document in the format.
 *
 * Lives in `app.getPath('userData')/settings.json`, *outside* any bundle, and is
 * written by `ProjectStore` through the same atomic write as everything else.
 */

import type { IsoTimestamp } from './common.ts';
import type { SchemaId } from '../schema.ts';

/**
 * What first-run setup remembers. Phase 2.
 *
 * Two timestamps rather than two booleans, because both answer a "when" that
 * matters later: a support question about a recording made before setup was
 * finished, and — for `accessibilityOpenedAt` — whether the user has ever been
 * shown the one pane macOS will not let an app open on the user's behalf twice.
 */
export interface SetupState {
  /**
   * When the user finished first-run setup, or `null` if they never have.
   *
   * Setup completes when the user says it does, not when every grant is given.
   * The captain's decision (`data/loom-scope/decision-accessibility-clicks.md`)
   * requires a user who declines the three optional permissions to still get a
   * working recorder, so "completed" means "asked and answered", not "all granted".
   */
  completedAt: IsoTimestamp | null;
  /**
   * When this app last opened the Accessibility pane in System Settings for the
   * user, or `null`.
   *
   * Phase 5's sampler cannot tell "just granted, not yet visible to this process"
   * from "never granted" — from inside, they look identical. The side that opened
   * the pane is the side that knows a relaunch is worth offering, and this is that
   * knowledge surviving the relaunch it is about.
   */
  accessibilityOpenedAt: IsoTimestamp | null;
}

export interface SettingsDoc {
  schema: SchemaId;
  /**
   * Absolute path to the recordings root. Defaults to `~/Movies/Loom Clone`.
   * Exports are written *outside* the bundle, by default to `<root>/Exports`.
   */
  recordingsRoot: string;
  /** First-run state. Added in `loom.settings/2`. */
  setup: SetupState;
}
