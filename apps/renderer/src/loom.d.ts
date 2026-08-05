/**
 * `window.loom` — the only capability a renderer has.
 *
 * The shape is `LoomApi` from `@loom/ipc`, which is also what the preload
 * implements, so a change on either side is a compile error on the other.
 */

import type { LoomApi } from '@loom/ipc';

declare global {
  interface Window {
    readonly loom: LoomApi;
  }
}

export {};
