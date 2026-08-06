/**
 * What the editor window will tell a gate about itself.
 *
 * ## Why this exists at all
 *
 * `test/editor-gate.test.ts` has to be able to distinguish two things that look
 * identical from outside: *the trim moved the picture* and *the playhead moved and
 * the picture did not*. Nothing observable in the DOM can tell them apart. A frame
 * counter cannot either — it counts just as happily when every frame composited is
 * the same stale one, which is exactly the failure §4.3's hold produces when a
 * source is primed at the wrong instant. The only assertion that separates them is
 * on the **pixels**, compared at two playhead positions that the clip list says are
 * the same instant of the recording.
 *
 * ## Why it is not a capability
 *
 * Everything here is a read of the window's own state. A renderer can already read
 * its own canvas — asking for `preserveDrawingBuffer` and calling `readPixels` needs
 * nothing from anybody — so exposing it grants no reach the page did not have. There
 * is no setter, no filesystem, no IPC and no way to reach another window. `LoomApi`
 * remains the only *capability* surface and this is deliberately not part of it.
 *
 * ## Why the gate does not just use its own page
 *
 * Because then it would be measuring its own page. `test/hud-notice.test.ts` makes
 * the same argument for the recorder HUD: *"a gate that builds its own window
 * measures its own window."* The editor gate drives the shipping `editor.html`, the
 * shipping preload, the shipping window role and the shipping `PreviewLoop`, and
 * reads the pixels those produced.
 */

import type { Clip, Seconds } from '@loom/format';

/** One track, flattened to what a gate can assert about it without a model. */
export interface ProbeTrack {
  id: string;
  target: string;
  origin: 'manual' | 'generated';
  /** Carries a live `generator` block — §3.5's *regenerate* applies to it. */
  generated: boolean;
  /** Baked: `origin: 'manual'` with the spec kept as `generatedFrom` (§3.5). */
  baked: boolean;
  activeRanges: [number, number][];
  keyCount: number;
  spanCount: number;
}

export interface EditorProbe {
  /**
   * The composited pixels, RGBA8, **top row first**, at the output size.
   *
   * The compositor's own render target — what `present()` blitted to the canvas —
   * rather than a second rendering of anything.
   */
  readPixels: () => Uint8Array;
  /** `edit.output.size`: the size those pixels are at. */
  readonly outputSize: readonly [number, number];
  /** Where the playhead is, in **timeline** seconds. */
  readonly timelineSec: Seconds;
  /**
   * The instant of the recording under the playhead, in **source** seconds.
   *
   * `resolve(...).sourceTime` — the number the clip list maps `timelineSec` to, and
   * the one every `PreviewSource` method is asked in.
   */
  readonly sourceSec: Seconds;
  /** The edited output's length, in timeline seconds. */
  readonly durationSec: Seconds;
  readonly playing: boolean;
  /** Where the two trim handles are, in source seconds. */
  readonly trim: { readonly startSec: Seconds; readonly endSec: Seconds };
  /**
   * The clip list the editor is showing — including a provisional one mid-drag,
   * which is exactly the difference between what is on screen and what is on disk.
   */
  readonly clips: readonly Clip[];

  // ---- phase 15: the controls -----------------------------------------------

  /** Which tool is armed. */
  readonly tool: string;
  /** What is selected, in the union `tools.ts` declares. */
  readonly selection: unknown;
  /**
   * `resolve(...).zoom` at the playhead, **cloned**.
   *
   * The reading that makes a manual override provable: a gate can put the playhead
   * inside the user's window and outside it and require different answers, which is
   * §3.5's stacking rule measured through the shipping compiled timeline rather than
   * asserted about a document. Cloned because `resolve` returns the timeline's own
   * state object and overwrites it in place.
   */
  readonly zoom: { amount: number; center: [number, number] };
  /** The manual zoom regions the editor is showing, read back out of the keys. */
  readonly regions: readonly {
    index: number;
    startSec: Seconds;
    endSec: Seconds;
    windowEndSec: Seconds;
    amount: number;
    center: [number, number];
  }[];
  readonly annotations: readonly {
    id: string;
    kind: string;
    startSec: Seconds;
    endSec: Seconds;
  }[];
  /**
   * Every track, flattened.
   *
   * Present because §3.5's three states — generated, manual, baked — are a property
   * of *fields on a track*, and a gate that inferred them from the picture could not
   * tell a bake from a regeneration that happened to produce the same keys.
   */
  readonly tracks: readonly ProbeTrack[];
  /** Whether the event logs have been read yet, so a gate waits rather than races. */
  readonly logsRead: boolean;
}
