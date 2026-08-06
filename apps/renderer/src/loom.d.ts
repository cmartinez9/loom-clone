/**
 * `window.loom` — the only capability a renderer has.
 *
 * The shape is `LoomApi` from `@loom/ipc`, which is also what the preload
 * implements, so a change on either side is a compile error on the other.
 */

import type { LoomApi } from '@loom/ipc';
import type { EditorProbe } from './editor/probe.ts';

declare global {
  interface Window {
    readonly loom: LoomApi;
    /**
     * The editor window's read-only view of what it is currently showing.
     *
     * Present only on `editor.html`. See `apps/renderer/src/editor/probe.ts` for
     * what it is for and why it is not a capability.
     */
    __loomEditor?: EditorProbe;
  }
}

export {};
