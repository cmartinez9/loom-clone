/**
 * The picture as a surface you can point at: place an annotation, move one, resize
 * one, and move the shot a zoom is framing.
 *
 * ## It is a sibling of the canvas, never a draw call
 *
 * Every handle in this file is a `<div>` over the preview, at the preview's exact
 * size. §4.5 puts what preview and export composite on the must-be-identical list,
 * and a selection handle is precisely the thing that must appear in one and never in
 * the other — so it cannot be a compositor pass, cannot be a second draw after
 * `present()`, and cannot be anything the export path could ever be handed. A
 * `position: absolute` sibling is the only arrangement where that is true by
 * construction rather than by remembering.
 *
 * ## Every coordinate crosses exactly one map, and it is the same one both ways
 *
 * A pointer arrives in CSS pixels of a scaled element. It becomes `0..1` of the
 * canvas by dividing by the measured box, and a **normalized source** coordinate by
 * `outputToSource` — the inverse of the `sourceSampleRect` + `contentRect` pair the
 * compositor samples with. Nothing here works in output-normalized space for longer
 * than one expression, because `annotations.ts`'s whole argument is that geometry
 * stored that way lets a zoom slide a redaction off the thing it redacts.
 *
 * A point that lands on the letterbox has **no** source coordinate, and
 * `outputToSource` answers `null` rather than clamping. Every gesture here honours
 * that by doing nothing: an annotation dropped on the letterbox has no content to be
 * welded to, and a zoom centred there is a zoom on the frame's border.
 */

import {
  boxOf,
  outputToSource,
  sourceToOutput01,
  type AnnotationView,
  type StageMapping,
} from './annotate.ts';
import type { AnnotationKind } from '@loom/edl';
import type { Vec2 } from '@loom/format';
import { isAnnotationToolId, type ToolId } from './tools.ts';

/** Which corner of a selected annotation's box a drag has hold of. */
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
type Corner = (typeof CORNERS)[number];

/** What a drag on the stage produced, in normalized source coordinates. */
export interface StageDrag {
  from: Vec2;
  to: Vec2;
}

export interface StageCallbacks {
  /** A tool drag finished and wants an annotation. `phase` is `'move'` while dragging. */
  onDraw: (kind: AnnotationKind, drag: StageDrag, phase: 'move' | 'end') => void;
  /**
   * A gesture ended somewhere it has no meaning, so whatever it showed must go.
   *
   * The other four callbacks are two-phase and end in a commit; this is the other
   * outcome, and between them they are exhaustive — see {@link StageUi} on the
   * invariant. The caller's answer is the same `null` branch its op builders already
   * take, so a cancelled gesture and one that changed nothing are one code path.
   */
  onCancelGesture: () => void;
  /** The selected annotation was moved or resized. */
  onEditAnnotation: (
    spanId: string,
    geometry: { center?: Vec2; size?: Vec2; from?: Vec2; to?: Vec2 },
    phase: 'move' | 'end',
  ) => void;
  /** A click with the select tool. `null` when it hit nothing. */
  onPick: (at: Vec2 | null) => void;
  /** The zoom tool wants the shot centred here. */
  onZoomTo: (at: Vec2, phase: 'move' | 'end') => void;
}

export interface StageState {
  tool: ToolId;
  mapping: StageMapping;
  /** The annotation whose handles are drawn, or `null`. */
  selected: AnnotationView | null;
  /** True while the playhead is inside the selected annotation's span. */
  selectedVisible: boolean;
}

/**
 * The overlay.
 *
 * It rebuilds its handles on `render` and nowhere else, and `render` is called from
 * the document-changed path rather than from the playhead's frame — the handles move
 * when the *document* moves, and the picture under them is the compositor's business.
 * The one exception is a live drag, which writes `style.left`/`width` directly on
 * nodes it already has, for the same reason `setPlayhead` exists beside `render`.
 *
 * ## A gesture that began provisionally ends in exactly one of commit or cancel
 *
 * Every `'move'` a gesture dispatches leaves a provisional document on
 * `EditorProject`, and only the terminal `'end'` — or a cancel — clears it. So every
 * exit from a live drag has to reach one of the two: a release on the letterbox, a
 * `pointercancel`, a selection whose geometry cannot be read, and any branch a later
 * kind of drag adds. That is why {@link StageUi.#apply} reports whether it dispatched
 * and the pointer-up handler answers `onCancelGesture` when it did not, rather than
 * each early return remembering for itself. Leaving one out is invisible: the preview
 * and the inspector go on showing geometry that is in no `edit.json` until some later
 * commit or undo happens by, with nothing on screen that says so.
 */
export class StageUi {
  readonly #element: HTMLElement;
  readonly #callbacks: StageCallbacks;
  #state: StageState | null = null;
  /** The rubber band a tool drag draws, kept so a move writes styles rather than DOM. */
  #band: HTMLElement | null = null;
  #drag:
    | { kind: 'draw'; tool: AnnotationKind; from: Vec2 }
    | { kind: 'move'; spanId: string; grab: Vec2; origin: AnnotationView }
    | { kind: 'resize'; spanId: string; corner: Corner; origin: AnnotationView }
    | { kind: 'endpoint'; spanId: string; which: 'from' | 'to' }
    | { kind: 'zoom' }
    | null = null;

  constructor(element: HTMLElement, callbacks: StageCallbacks) {
    this.#element = element;
    this.#callbacks = callbacks;
    this.#install();
  }

  render(state: StageState): void {
    this.#state = state;
    this.#element.dataset['tool'] = state.tool;
    // Armed tools take the pointer; Select takes it only to pick, and a pick has to
    // be able to land on the picture. Both need `pointer-events`, so the difference
    // is the cursor rather than the capture.
    //
    // The rubber band survives a rebuild. A draw drag re-renders the document on
    // every pointer move, and clearing the band along with the handles would leave
    // `#apply` writing styles onto a detached node — a drag with no feedback, which
    // reads as a tool that does not work.
    const band = this.#band;
    this.#element.replaceChildren(...(band === null ? [] : [band]));

    const selected = state.selected;
    if (selected === null || !state.selectedVisible) return;
    const aspect = state.mapping.outputSize[1] / Math.max(1, state.mapping.outputSize[0]);

    if (selected.kind === 'arrow') {
      const from = selected.from;
      const to = selected.to;
      if (from === null || to === null) return;
      this.#element.append(
        line(sourceToOutput01(state.mapping, from), sourceToOutput01(state.mapping, to), aspect),
        endpoint(sourceToOutput01(state.mapping, from), 'from'),
        endpoint(sourceToOutput01(state.mapping, to), 'to'),
      );
      return;
    }

    const box = boxOf(selected);
    if (box === null) return;
    const topLeft = sourceToOutput01(state.mapping, [box.cx - box.hx, box.cy - box.hy]);
    const bottomRight = sourceToOutput01(state.mapping, [box.cx + box.hx, box.cy + box.hy]);
    const frame = document.createElement('div');
    frame.className = 'ovl-frame';
    frame.dataset['role'] = 'move';
    place(frame, topLeft, bottomRight);
    this.#element.append(frame);
    for (const corner of CORNERS) {
      const handle = document.createElement('div');
      handle.className = `ovl-h ovl-h-${corner}`;
      handle.dataset['role'] = 'resize';
      handle.dataset['corner'] = corner;
      const x = corner === 'nw' || corner === 'sw' ? topLeft[0] : bottomRight[0];
      const y = corner === 'nw' || corner === 'ne' ? topLeft[1] : bottomRight[1];
      handle.style.left = `${String(x * 100)}%`;
      handle.style.top = `${String(y * 100)}%`;
      this.#element.append(handle);
    }
  }

  // ---------------------------------------------------------------- pointer

  #install(): void {
    this.#element.addEventListener('pointerdown', (event) => {
      const state = this.#state;
      if (state === null) return;
      const at = this.#sourceAt(event);
      event.preventDefault();
      try {
        this.#element.setPointerCapture(event.pointerId);
      } catch {
        // The same race `timeline.ts`'s `capture` documents: a pointer released
        // between the event being queued and this handler running is no longer
        // active and `setPointerCapture` throws. The drag still works over the
        // element, and `pointercancel` ends it either way.
      }

      const role = event.target instanceof HTMLElement ? event.target.dataset['role'] : undefined;
      const selected = state.selected;
      if (role === 'resize' && selected !== null && at !== null) {
        const corner = (event.target as HTMLElement).dataset['corner'];
        if (isCorner(corner)) {
          this.#drag = { kind: 'resize', spanId: selected.span.id, corner, origin: selected };
          return;
        }
      }
      if (role === 'endpoint' && selected !== null) {
        const which = (event.target as HTMLElement).dataset['which'];
        if (which === 'from' || which === 'to') {
          this.#drag = { kind: 'endpoint', spanId: selected.span.id, which };
          return;
        }
      }
      if (role === 'move' && selected !== null && at !== null) {
        this.#drag = { kind: 'move', spanId: selected.span.id, grab: at, origin: selected };
        return;
      }

      if (at === null) {
        // The letterbox. A click there deselects, which is the ordinary meaning of
        // clicking the background, and no gesture begins.
        if (state.tool === 'select') this.#callbacks.onPick(null);
        return;
      }
      if (state.tool === 'zoom') {
        this.#drag = { kind: 'zoom' };
        this.#callbacks.onZoomTo(at, 'move');
        return;
      }
      if (isAnnotationToolId(state.tool)) {
        this.#drag = { kind: 'draw', tool: state.tool, from: at };
        this.#band = document.createElement('div');
        this.#band.className = 'ovl-band';
        this.#element.append(this.#band);
        return;
      }
      this.#callbacks.onPick(at);
    });

    const move = (event: PointerEvent): void => {
      if (this.#drag === null) return;
      this.#apply(event, 'move');
    };
    const end = (event: PointerEvent): void => {
      if (this.#drag === null) return;
      // Commit or cancel, never neither. `pointercancel` arrives here too, so a
      // gesture the platform took away is the same one exit as one released off the
      // picture.
      if (!this.#apply(event, 'end')) this.#callbacks.onCancelGesture();
      this.#drag = null;
      this.#band?.remove();
      this.#band = null;
    };
    this.#element.addEventListener('pointermove', move);
    this.#element.addEventListener('pointerup', end);
    this.#element.addEventListener('pointercancel', end);
  }

  /**
   * One step of a live gesture. Answers **whether it dispatched a callback**.
   *
   * Every `return false` below is a reason this step said nothing — the pointer is on
   * the letterbox and has no source coordinate, or the selection it is dragging has no
   * geometry to move. On a `'move'` that costs the frame; on an `'end'` it would strand
   * whatever the previous move showed, which is what the caller uses this answer for.
   */
  #apply(event: PointerEvent, phase: 'move' | 'end'): boolean {
    const state = this.#state;
    const drag = this.#drag;
    if (state === null || drag === null) return false;
    const at = this.#sourceAt(event);
    if (at === null) return false;

    switch (drag.kind) {
      case 'zoom':
        this.#callbacks.onZoomTo(at, phase);
        return true;
      case 'draw': {
        const band = this.#band;
        if (band !== null) {
          place(
            band,
            sourceToOutput01(state.mapping, drag.from),
            sourceToOutput01(state.mapping, at),
          );
        }
        this.#callbacks.onDraw(drag.tool, { from: drag.from, to: at }, phase);
        return true;
      }
      case 'endpoint':
        this.#callbacks.onEditAnnotation(drag.spanId, { [drag.which]: at }, phase);
        return true;
      case 'move': {
        const dx = at[0] - drag.grab[0];
        const dy = at[1] - drag.grab[1];
        if (drag.origin.kind === 'arrow') {
          const from = drag.origin.from;
          const to = drag.origin.to;
          if (from === null || to === null) return false;
          this.#callbacks.onEditAnnotation(
            drag.spanId,
            { from: [from[0] + dx, from[1] + dy], to: [to[0] + dx, to[1] + dy] },
            phase,
          );
          return true;
        }
        const center = drag.origin.center;
        if (center === null) return false;
        this.#callbacks.onEditAnnotation(
          drag.spanId,
          { center: [center[0] + dx, center[1] + dy] },
          phase,
        );
        return true;
      }
      case 'resize': {
        const box = boxOf(drag.origin);
        if (box === null) return false;
        // The opposite corner is the anchor, so a resize behaves the way every other
        // resize does: the corner you have hold of follows the pointer and the one
        // across from it does not move.
        const anchorX =
          drag.corner === 'nw' || drag.corner === 'sw' ? box.cx + box.hx : box.cx - box.hx;
        const anchorY =
          drag.corner === 'nw' || drag.corner === 'ne' ? box.cy + box.hy : box.cy - box.hy;
        this.#callbacks.onEditAnnotation(
          drag.spanId,
          {
            center: [(anchorX + at[0]) / 2, (anchorY + at[1]) / 2],
            size: [Math.abs(at[0] - anchorX), Math.abs(at[1] - anchorY)],
          },
          phase,
        );
        return true;
      }
    }
  }

  /** The pointer as a normalized source coordinate, or `null` on the letterbox. */
  #sourceAt(event: PointerEvent): Vec2 | null {
    const state = this.#state;
    if (state === null) return null;
    const box = this.#element.getBoundingClientRect();
    if (!(box.width > 0) || !(box.height > 0)) return null;
    return outputToSource(state.mapping, [
      (event.clientX - box.left) / box.width,
      (event.clientY - box.top) / box.height,
    ]);
  }
}

// ---------------------------------------------------------------- nodes

function place(element: HTMLElement, a: Vec2, b: Vec2): void {
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  element.style.left = `${String(left * 100)}%`;
  element.style.top = `${String(top * 100)}%`;
  element.style.width = `${String(Math.abs(b[0] - a[0]) * 100)}%`;
  element.style.height = `${String(Math.abs(b[1] - a[1]) * 100)}%`;
}

/**
 * The selected arrow's shaft, as a rotated bar.
 *
 * A `<div>` and a transform rather than an SVG line: this window has no SVG anywhere
 * else, and the bar is a hit target for the move gesture as well as a mark, which a
 * zero-width line is not.
 *
 * **The aspect ratio has to come in.** `left`/`top` resolve against different axes —
 * `%` of width and `%` of height — but `width` resolves against the width alone and
 * `rotate` works in real angles, so a length and an angle taken from the two
 * normalized deltas directly would only land on the far endpoint on a square output.
 * Both are therefore computed in *fractions of the width*, which is the one unit the
 * bar is actually drawn in: `dy` becomes `dy * height/width`.
 */
function line(a: Vec2, b: Vec2, aspect: number): HTMLElement {
  const element = document.createElement('div');
  element.className = 'ovl-line';
  element.dataset['role'] = 'move';
  const dx = b[0] - a[0];
  const dy = (b[1] - a[1]) * aspect;
  element.style.left = `${String(a[0] * 100)}%`;
  element.style.top = `${String(a[1] * 100)}%`;
  element.style.width = `${String(Math.hypot(dx, dy) * 100)}%`;
  element.style.transform = `rotate(${String(Math.atan2(dy, dx))}rad)`;
  return element;
}

function endpoint(at: Vec2, which: 'from' | 'to'): HTMLElement {
  const element = document.createElement('div');
  element.className = 'ovl-h';
  element.dataset['role'] = 'endpoint';
  element.dataset['which'] = which;
  element.style.left = `${String(at[0] * 100)}%`;
  element.style.top = `${String(at[1] * 100)}%`;
  return element;
}

function isCorner(value: string | undefined): value is Corner {
  return (CORNERS as readonly string[]).includes(value ?? '');
}
