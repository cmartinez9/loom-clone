/**
 * App settings. Architecture report §2.1 calls the recordings root "configurable"
 * but does not specify a file for it; phase 0 gives it one, versioned like every
 * other document in the format.
 *
 * Lives in `app.getPath('userData')/settings.json`, *outside* any bundle, and is
 * written by `ProjectStore` through the same atomic write as everything else.
 */

import type { SchemaId } from '../schema.ts';

export interface SettingsDoc {
  schema: SchemaId;
  /**
   * Absolute path to the recordings root. Defaults to `~/Movies/Loom Clone`.
   * Exports are written *outside* the bundle, by default to `<root>/Exports`.
   */
  recordingsRoot: string;
}
