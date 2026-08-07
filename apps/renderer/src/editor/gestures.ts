/**
 * What a two-phase gesture, and a moving playhead, should cause.
 *
 * Four decisions that used to live inside DOM handlers and a `requestAnimationFrame`
 * closure. Nothing here touches an element, a document or a compositor: each function
 * takes the state it judges and answers what should happen, and `inspector.ts` and
 * `main.ts` do it.
 *
 * ## Why they were moved
 *
 * Every one of them was guarded **only** by `test/phase15-gate.test.ts`, which
 * composites and exports — and which now withholds its export claims when the WebGL
 * context is taken away (`test/editor-controls/verdict.ts`). On a host that loses the
 * context those four properties were not proven; worse, `scripts/mutation-check.mjs`
 * classifies a *file* as `no-verdict` only when **every** test in it withheld, and this
 * gate withholds per claim — so the runner scored a mutation nothing had judged as
 * `SURVIVED` and reported a hole that had not been measured. CI run 31148316397 failed
 * exactly that way on `the-zoom-panel-does-not-follow-the-playhead`, and run
 * 31150684807 passed only because that host happened to keep its context.
 *
 * The remedy `WITHHOLDABLE_GUARDS` prescribes is **a second guard that cannot
 * withhold**, never a retry and never a widening of the predicate. These four
 * properties are observable without compositing a single frame — a panel that does not
 * follow the playhead, a slider that commits on every step, an inspector that rebuilds
 * under its own thumb, a gesture that strands its preview — so a pure module is all
 * they ever needed. `apps/renderer/test/editor-gestures.test.ts` is that guard, and it
 * is deterministic on any host.
 *
 * The phase-15 gate keeps its own coverage of the same four: it proves the **wiring**
 * — that the real slider, the real panel and the real pointer reach these decisions —
 * which a unit test cannot. Both guards are listed on each mutation. This is the split
 * `AGENTS.md` already describes for seam S4: the pure half is where the arithmetic
 * that is wrong invisibly lives, and the gate is where the wiring is.
 */

import type { EditOp } from '@loom/format';

/** Which half of a two-phase gesture a step is: still dragging, or let go. */
export type ControlPhase = 'move' | 'end';

/** What a gesture step does to the document. `main.ts` supplies the three verbs. */
export interface GestureIo {
  /** Show a document that is not committed — `EditorProject.preview`. */
  preview: (ops: readonly EditOp[]) => void;
  /** Land it — `EditorProject.commit`. */
  commit: (ops: readonly EditOp[], label: string) => void;
  /** Throw a provisional document away — `EditorProject.cancelPreview`. */
  cancel: () => void;
}

/**
 * One step of any two-phase gesture: the slider, a keyframe drag, a span drag, the
 * stage's move/resize/endpoint drags, and the zoom tool's pan.
 *
 * **`null` ops must cancel, not return.** Every op builder answers `null` for "this
 * would change nothing", and a gesture can reach that at its *end*: a slider dragged
 * away and back, a keyframe returned to where it was, an annotation dropped where it
 * was picked up. Returning there leaves the provisional document an earlier `move`
 * created, with nothing to clear it — the preview and the inspector then show a value
 * that is in no `edit.json` until some later commit or undo happens by. `onTrimCommit`
 * has always cancelled in that case; this is the same answer for the other five, in one
 * place so a sixth cannot be written without it.
 *
 * `cancel` is a no-op when nothing is provisional, so a `move` that changes nothing
 * costs nothing and repeated ones cost nothing after the first.
 */
export function applyGesture(
  ops: readonly EditOp[] | null,
  phase: ControlPhase,
  label: string,
  io: GestureIo,
): void {
  if (ops === null) {
    io.cancel();
    return;
  }
  if (phase === 'move') io.preview(ops);
  else io.commit(ops, label);
}

/** What one DOM event on a slider means. `null` fields are "leave this alone". */
export interface SliderStep {
  /** Arm or disarm the rebuild guard, or `null` to leave it as it is. */
  gesture: boolean | null;
  /** The value to write into the readout beside the thumb, or `null`. */
  value: number | null;
  /** The phase to report to the document, or `null` when there is nothing to report. */
  phase: ControlPhase | null;
}

/**
 * A slider's three events, as decisions.
 *
 * **`input` is `move` and `change` is `end`**, and that is the whole of why the Amount
 * slider works. Committing on `input` reaches `Inspector.render` synchronously, whose
 * `replaceChildren` removes the `<input type="range">` the pointer is holding — the
 * drag stops after one step, which is the control not working rather than the control
 * needing polish. It also spends one undo entry per step of a drag, which would make
 * undo useless afterwards even if the drag survived. Provisional on drag, commit on
 * release, one undo step per gesture — the bargain the trim handles already make.
 *
 * The guard is armed **before** the value is reported, because reporting is what
 * re-renders; and disarmed **before** the commit, so the rebuild that commit causes
 * actually happens and the panel comes back in step with the document.
 *
 * `blur` is a backstop rather than the mechanism: a gesture interrupted by the window
 * going away never gets its `change`, and a guard left armed would freeze the panel.
 */
export function sliderStep(event: 'input' | 'change' | 'blur', raw: string): SliderStep {
  const parsed = Number.parseFloat(raw);
  const usable = Number.isFinite(parsed);
  if (event === 'blur') return { gesture: false, value: null, phase: null };
  if (event === 'input') {
    if (!usable) return { gesture: null, value: null, phase: null };
    return { gesture: true, value: parsed, phase: 'move' };
  }
  // `change`. Disarmed whatever the value turns out to be, or an unparseable one
  // would leave the panel frozen for the rest of the session.
  if (!usable) return { gesture: false, value: null, phase: null };
  return { gesture: false, value: parsed, phase: 'end' };
}

/**
 * Is a control mid-gesture, so the panel may not be rebuilt under it?
 *
 * **One predicate, both call sites**, and that is the point rather than tidiness.
 * `Inspector.render` refuses to rebuild while a gesture is live — that is the
 * load-bearing one, because `replaceChildren` there removes the `<input type="range">`
 * the pointer is holding — and `paintZoom` refuses to *ask* for a rebuild for the same
 * reason. Two independent copies of the same condition meant breaking one left the
 * other covering for it: with `paintZoom`'s early-out disabled the slider still worked,
 * because `render` refused anyway, so the mutation survived the gate while pointing at
 * a line that genuinely mattered. Routing both through here makes the property one
 * thing that can be broken once and seen twice — by the unit test, and by the gate
 * watching a real thumb.
 */
export function panelIsHeld(gesture: string | null): boolean {
  return gesture !== null;
}

/** What the standing Zoom panel is saying, as numbers rather than as DOM. */
export interface ZoomReadout {
  /** Which manual region covers the playhead, or `-1`. Identity, not a position. */
  regionIndex: number;
  /** Whether a generated zoom covers it — what decides the button's presence. */
  generated: boolean;
  amount: number;
  centerX: number;
  centerY: number;
}

/**
 * What a repaint of the standing Zoom panel should do.
 *
 * Three answers rather than a boolean, because the panel has two halves that cost
 * very different things:
 *
 *  - `rebuild` — the **shape** changed: a different region covers the playhead, or a
 *    generated zoom started or stopped covering it, which is what decides whether
 *    *Take manual control* is offered. Structure has to be rebuilt.
 *  - `write` — only the **numbers** moved. Two text writes, no DOM built. This is the
 *    per-frame case during playback and it must stay cheap: §4.3's first anti-stutter
 *    rule is that nothing allocates in the loop.
 *  - `nothing` — nothing moved, or a gesture is live.
 *
 * A live gesture answers `nothing` for the reason the slider exists: a rebuild would
 * take away the element the pointer is holding. Asking for one sixty times a second
 * and deliberately ignoring it is worse than being one gesture behind.
 */
export type ZoomPaint = 'rebuild' | 'write' | 'nothing';

export function zoomPaintDecision(
  previous: ZoomReadout | null,
  next: ZoomReadout,
  gestureActive: boolean,
): ZoomPaint {
  if (gestureActive) return 'nothing';
  if (previous === null) return 'rebuild';
  if (previous.regionIndex !== next.regionIndex || previous.generated !== next.generated) {
    return 'rebuild';
  }
  if (
    previous.amount !== next.amount ||
    previous.centerX !== next.centerX ||
    previous.centerY !== next.centerY
  ) {
    return 'write';
  }
  return 'nothing';
}

/**
 * Has the playhead moved to a different instant since the panel was last read?
 *
 * One comparison, and it is the line that made the panel stale. Written out as a
 * predicate rather than left inline because it was inverted once and nothing outside a
 * GPU-bound gate could see it: the panel then described whatever moment the last *edit*
 * happened at, so after an ordinary scrub the readout was of a moment that had passed
 * and — the half that matters — *Take manual control* was withheld on exactly the path
 * a person takes to reach it. Scrub to the moment you want to change, then take
 * control; the capability was not offered where it was wanted, which reads as one that
 * does not exist.
 *
 * `!==` rather than an epsilon: `sourceSec` comes from `resolve` and a repeated frame
 * produces the identical double, so exact inequality is both reachable and the cheapest
 * thing that can be asked on a frame path.
 */
export function playheadMoved(paintedSourceSec: number, sourceSec: number): boolean {
  return sourceSec !== paintedSourceSec;
}
