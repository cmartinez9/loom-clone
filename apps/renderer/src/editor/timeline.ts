/**
 * The timeline: a ruler, one lane per captured track, a playhead, and the two trim
 * handles.
 *
 * The layout decision — that the whole thing is drawn in **source** time — is
 * argued in `timeline-geometry.ts`, which owns the arithmetic. This module owns the
 * DOM and the pointer.
 *
 * ## Lanes describe `recording.json`, not a fixed list
 *
 * The mockup draws seven lanes; a recording has as many tracks as it has. A lane is
 * built for every track `recording.json` declares, and a track it does not declare
 * gets no lane at all rather than an empty one — an empty lane reads as "this was
 * captured and there is nothing in it", which for a microphone nobody switched on is
 * a false statement about the recording. The one thing drawn *because* it is missing
 * is an audio gap (§5.4 mechanism 5): a stretch in which a device produced nothing
 * is part of what was captured, and closing it up is exactly what the format forbids.
 *
 * ## Nothing here reads a clock or a duration it was not handed
 *
 * Every extent comes from a `recording.json` part, every keyframe from the compiled
 * document, and the width from `getBoundingClientRect`. There is no default
 * duration, no assumed frame rate and no nominal window size in this file.
 */

import { formatTimecode, icon, type IconName } from '@loom/design';
import type { EditDocument, RecordingDoc, Seconds } from '@loom/format';
import {
  timeOf,
  ticks,
  trackPx,
  visibleSpanSec,
  xOf,
  zoomAbout,
  type TimelineView,
} from './timeline-geometry.ts';
import { moveHandle, type Trim } from './trim.ts';

/** What the timeline draws. Everything in it is source time. */
export interface TimelineState {
  view: TimelineView;
  trim: Trim;
  /** Where the playhead is, in source seconds. */
  playheadSourceSec: Seconds;
  document: EditDocument;
}

export interface TimelineElements {
  heads: HTMLElement;
  lanes: HTMLElement;
  ruler: HTMLElement;
  laneStack: HTMLElement;
  shadeHead: HTMLElement;
  shadeTail: HTMLElement;
  handleStart: HTMLElement;
  handleEnd: HTMLElement;
  playhead: HTMLElement;
}

export interface TimelineCallbacks {
  /** The pointer or a key put the playhead at this source instant. */
  onScrub: (sourceSec: Seconds, phase: 'move' | 'end') => void;
  /** A handle moved and has not been let go of yet. */
  onTrimPreview: (trim: Trim) => void;
  /** A handle was let go of. One of these per drag, and one undo step per drag. */
  onTrimCommit: (trim: Trim) => void;
  /** The view scrolled or zoomed and the caller should re-render. */
  onViewChange: (view: TimelineView) => void;
}

/** One row: a heading on the left and something drawn on the right. */
interface Lane {
  label: string;
  icon: IconName;
  /** Draw the lane's contents. Called on every render, with the current view. */
  draw: (element: HTMLElement, state: TimelineState) => void;
  /** Dim the heading — a track that is declared and has nothing to show. */
  muted?: boolean;
}

export class TimelineUi {
  readonly #elements: TimelineElements;
  readonly #callbacks: TimelineCallbacks;
  #lanes: Lane[] = [];
  #laneElements: HTMLElement[] = [];
  #state: TimelineState | null = null;
  /** Which handle a pointer is holding, or `null`. */
  #dragging: 'start' | 'end' | 'playhead' | null = null;

  constructor(elements: TimelineElements, callbacks: TimelineCallbacks) {
    this.#elements = elements;
    this.#callbacks = callbacks;
    this.#installPointer();
    this.#installKeyboard();
  }

  /** Build the lanes for one recording. Called once, when the project opens. */
  setTracks(recording: RecordingDoc | null): void {
    this.#lanes = lanesFor(recording);
    this.#elements.heads.replaceChildren(
      headingRuler(),
      ...this.#lanes.map((lane) => heading(lane)),
    );
    this.#laneElements = this.#lanes.map(() => {
      const element = document.createElement('div');
      element.className = 'lane';
      return element;
    });
    this.#elements.laneStack.replaceChildren(...this.#laneElements);
  }

  /** The lane area's measured width, for the caller to put in its `TimelineView`. */
  get widthPx(): number {
    return this.#elements.lanes.getBoundingClientRect().width;
  }

  render(state: TimelineState): void {
    this.#state = state;
    const { view, trim } = state;

    this.#elements.ruler.replaceChildren(
      ...ticks(view).map((tick) => {
        const element = document.createElement('span');
        element.className = tick.major ? 'tick tick-major' : 'tick';
        element.style.left = `${String(tick.x)}px`;
        if (tick.major) {
          const label = document.createElement('span');
          label.textContent = rulerLabel(tick.t);
          element.append(label);
        }
        return element;
      }),
    );

    this.#lanes.forEach((lane, i) => {
      const element = this.#laneElements[i];
      if (element !== undefined) lane.draw(element, state);
    });

    // The trimmed-away head and tail, still on screen. `xOf` can answer a negative
    // or over-wide number when the view is scrolled; the shades are clipped by the
    // lane area's own `overflow: hidden` rather than by arithmetic here.
    const startX = xOf(view, trim.startSec);
    const endX = xOf(view, trim.endSec);
    place(this.#elements.shadeHead, 0, Math.max(0, startX));
    place(this.#elements.shadeTail, endX, Math.max(0, this.widthPx - endX));
    this.#elements.handleStart.style.left = `${String(startX)}px`;
    this.#elements.handleEnd.style.left = `${String(endX)}px`;
    this.setPlayhead(view, state.playheadSourceSec);
  }

  /**
   * Move the playhead and nothing else.
   *
   * Separate from {@link TimelineUi.render} because this one runs every frame and
   * that one rebuilds the ruler and every lane. Sixty full renders a second would
   * be sixty rebuilds of a few hundred elements to move one line — and the design
   * language's rule that the playhead is `--t-instant` is not much use if getting
   * it there costs a layout of the whole timeline.
   */
  setPlayhead(view: TimelineView, sourceSec: Seconds): void {
    this.#elements.playhead.style.left = `${String(xOf(view, sourceSec))}px`;
  }

  // ------------------------------------------------------------------ pointer

  #installPointer(): void {
    const { lanes, handleStart, handleEnd } = this.#elements;

    const begin = (which: 'start' | 'end') => (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.#dragging = which;
      const target = event.currentTarget as HTMLElement;
      capture(target, event.pointerId);
      target.dataset['dragging'] = 'true';
    };
    handleStart.addEventListener('pointerdown', begin('start'));
    handleEnd.addEventListener('pointerdown', begin('end'));

    lanes.addEventListener('pointerdown', (event) => {
      this.#dragging = 'playhead';
      capture(lanes, event.pointerId);
      this.#scrubTo(event, 'move');
    });

    const move = (event: PointerEvent): void => {
      if (this.#dragging === null) return;
      if (this.#dragging === 'playhead') {
        this.#scrubTo(event, 'move');
        return;
      }
      const next = this.#trimFrom(event, this.#dragging);
      if (next !== null) this.#callbacks.onTrimPreview(next);
    };
    const end = (event: PointerEvent): void => {
      const which = this.#dragging;
      if (which === null) return;
      this.#dragging = null;
      delete handleStart.dataset['dragging'];
      delete handleEnd.dataset['dragging'];
      if (which === 'playhead') {
        this.#scrubTo(event, 'end');
        return;
      }
      const next = this.#trimFrom(event, which);
      if (next !== null) this.#callbacks.onTrimCommit(next);
    };

    // Once, on `lanes`, and never on the handles as well. The handles are its
    // children and `setPointerCapture` retargets without stopping the bubble, so a
    // listener on each would run `move` twice per `pointermove` — and each run
    // rebuilds the ruler and every lane, which is the one thing this window's input
    // path may not do. `lanes` sees the event either way: by its own capture while
    // the playhead is being dragged, and by bubbling from the captured handle while
    // a trim is. A drag that wanders outside the element still arrives for the same
    // reason, and `pointercancel` — the window losing focus mid-drag — still commits
    // what the user had rather than leaving a provisional trim on screen that no
    // pointerup will ever turn into an edit.
    lanes.addEventListener('pointermove', move);
    lanes.addEventListener('pointerup', end);
    lanes.addEventListener('pointercancel', end);

    // Wheel: horizontal scroll, or zoom with the modifier a trackpad pinch sends.
    lanes.addEventListener(
      'wheel',
      (event) => {
        const state = this.#state;
        if (state === null) return;
        event.preventDefault();
        const view = state.view;
        if (event.ctrlKey || event.metaKey) {
          const anchor = timeOf(view, this.#xIn(event));
          this.#callbacks.onViewChange(
            zoomAbout(view, view.zoom * Math.exp(-event.deltaY / 220), anchor),
          );
          return;
        }
        // Through the geometry module, not re-derived: `visibleSpanSec` floors the
        // span the way every other mapping in this window sees it, and `trackPx` is
        // the width less both `EDGE_PX` insets — so a wheel scroll moves the time
        // under the pointer by exactly the pixels the pointer moved.
        const perPx = visibleSpanSec(view) / trackPx(view);
        this.#callbacks.onViewChange({
          ...view,
          scrollSec: view.scrollSec + (event.deltaX || event.deltaY) * perPx,
        });
      },
      { passive: false },
    );
  }

  #installKeyboard(): void {
    const nudge = (which: 'start' | 'end', bySec: number) => {
      const state = this.#state;
      if (state === null) return;
      const from = which === 'start' ? state.trim.startSec : state.trim.endSec;
      const moved = moveHandle(state.trim, which, from + bySec, state.view.durationSec);
      this.#callbacks.onTrimCommit(moved);
    };
    const bind = (element: HTMLElement, which: 'start' | 'end'): void => {
      element.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 1 : 0.1;
        if (event.key === 'ArrowLeft') nudge(which, -step);
        else if (event.key === 'ArrowRight') nudge(which, step);
        else return;
        event.preventDefault();
        event.stopPropagation();
      });
    };
    bind(this.#elements.handleStart, 'start');
    bind(this.#elements.handleEnd, 'end');
  }

  #scrubTo(event: PointerEvent, phase: 'move' | 'end'): void {
    const state = this.#state;
    if (state === null) return;
    this.#callbacks.onScrub(timeOf(state.view, this.#xIn(event)), phase);
  }

  #trimFrom(event: PointerEvent, which: 'start' | 'end'): Trim | null {
    const state = this.#state;
    if (state === null) return null;
    const at = timeOf(state.view, this.#xIn(event));
    return moveHandle(state.trim, which, at, state.view.durationSec);
  }

  #xIn(event: { clientX: number }): number {
    return event.clientX - this.#elements.lanes.getBoundingClientRect().left;
  }
}

/**
 * Take the pointer, and carry on without it if it has already gone.
 *
 * `setPointerCapture` throws `NotFoundError` for a pointer that is no longer
 * active, which is a real race rather than a hypothetical one: a pointer released
 * between the event being queued and this handler running is exactly that, and it
 * happens under load. Letting the throw out of `pointerdown` would leave the drag
 * begun and unfinishable — the state is set above and no `pointerup` handler would
 * run — which is a stuck handle. Without capture the drag still works while the
 * pointer stays over the timeline, and `pointercancel` ends it either way.
 */
function capture(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // See above. Nothing to report: the drag is degraded, not broken.
  }
}

function place(element: HTMLElement, left: number, width: number): void {
  element.style.left = `${String(left)}px`;
  element.style.width = `${String(Math.max(0, width))}px`;
}

function headingRuler(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'hd-ruler';
  return element;
}

function heading(lane: Lane): HTMLElement {
  const element = document.createElement('div');
  element.className = lane.muted === true ? 'hd hd-missing' : 'hd';
  const slot = document.createElement('span');
  slot.className = 'ic-slot';
  slot.innerHTML = icon(lane.icon, 14);
  element.append(slot, document.createTextNode(lane.label));
  return element;
}

/**
 * `0:15`, `1:01:01`, or `0:15.5` once the ruler is zoomed past one tick per second.
 *
 * The whole-seconds part is `@loom/design`'s {@link formatTimecode} and is not
 * composed here, so the ruler and the transport readout — `#tcode` and `#tl-tc`, both
 * `formatTimecodeCentis`, which is the same function with hundredths after it — say
 * the same thing about the same instant at every length. Composing `M:SS` by hand is
 * how this printed `61:01` for an hour-plus recording while the readout beside it
 * printed `1:01:01.00`; the tick ladder runs to half-hour steps, so that is a length
 * the ruler is expected to draw. `formatTimecode` rounds *down*, which is what a
 * tick's whole part wants — the label names the instant the tick is on.
 *
 * The tenth is appended only when **the tick's own time** is not a whole second,
 * which is a rule about the number in hand and needs no knowledge of `TICK_LADDER`,
 * so it cannot drift from it: at every step of a second or more every tick is already
 * whole and no fraction can appear, and below one second the ladder's 0.1 and 0.5
 * rungs are exactly the ones a single decimal place can name (which is why 0.25 is
 * not a rung).
 */
export function rulerLabel(t: Seconds): string {
  const base = formatTimecode(t);
  const fraction = t - Math.floor(t);
  return fraction < 1e-6 ? base : `${base}.${String(Math.round(fraction * 10))}`;
}

// ---------------------------------------------------------------- lane builders

function lanesFor(recording: RecordingDoc | null): Lane[] {
  if (recording === null) return [];
  const lanes: Lane[] = [];

  const screen = recording.tracks.screen;
  if (screen !== undefined) {
    lanes.push({
      label: 'Screen',
      icon: 'screen',
      draw: (element, state) => {
        drawParts(element, state, screen.parts, 'part-screen');
      },
    });
  }

  const webcam = recording.tracks.webcam;
  if (webcam !== undefined) {
    lanes.push({
      label: 'Camera',
      icon: 'cam',
      draw: (element, state) => {
        drawParts(element, state, webcam.parts, 'part-webcam');
      },
    });
  }

  for (const [key, label, name] of [
    ['mic', 'Mic', 'mic'],
    ['system', 'System', 'speaker'],
  ] as const) {
    const track = recording.tracks[key];
    if (track === undefined) continue;
    lanes.push({
      label,
      icon: name,
      draw: (element, state) => {
        drawParts(element, state, track.parts, 'part-audio');
        // §5.4 mechanism 5, drawn: the media in the file is contiguous and the
        // hole lives only in `recording.json`, so this is the only place a person
        // can see that a device stopped producing.
        for (const part of track.parts) {
          for (const gap of part.gaps) {
            const box = document.createElement('div');
            box.className = 'gap';
            box.title = `No audio for ${gap.durationSec.toFixed(2)}s (${gap.cause})`;
            place(box, xOf(state.view, gap.atSec), spanPx(state.view, gap.durationSec));
            element.append(box);
          }
        }
      },
    });
  }

  lanes.push({
    label: 'Zoom',
    icon: 'zoomIn',
    draw: drawZoomKeys,
    muted: true,
  });

  return lanes;
}

function drawParts(
  element: HTMLElement,
  state: TimelineState,
  parts: readonly { startTimeSec: Seconds; durationSec: Seconds }[],
  className: string,
): void {
  element.replaceChildren();
  for (const part of parts) {
    const box = document.createElement('div');
    box.className = `part ${className}`;
    place(box, xOf(state.view, part.startTimeSec), spanPx(state.view, part.durationSec));
    element.append(box);
  }
}

/**
 * Every zoom keyframe in the document, on one lane.
 *
 * Read-only in this phase: `loom-p15` owns placing, moving and deleting them. It is
 * drawn anyway because a zoom the editor cannot show is a zoom the person watching
 * the preview cannot account for — and because the lane existing, in source time,
 * under the same ruler as the clip it applies to, is what that change needs to
 * exist before it can be written.
 *
 * Source-domain tracks only. A `timeline`-domain track describes the *output*
 * (§3.2) and its keys are not at these coordinates; drawing them here would put
 * them under the wrong frames, which is worse than not drawing them.
 */
function drawZoomKeys(element: HTMLElement, state: TimelineState): void {
  element.replaceChildren();
  let drawn = 0;
  for (const track of state.document.tracks) {
    if (track.target !== 'zoom' || !track.enabled || track.domain !== 'source') continue;
    for (const channel of Object.values(track.channels)) {
      for (const key of channel.keys) {
        const diamond = document.createElement('div');
        diamond.className = 'kf';
        diamond.style.left = `${String(xOf(state.view, key.t))}px`;
        element.append(diamond);
        drawn += 1;
      }
    }
  }
  if (drawn > 0) return;
  const empty = document.createElement('span');
  empty.className = 'lane-empty';
  empty.textContent = 'No zoom yet';
  element.append(empty);
}

function spanPx(view: TimelineView, durationSec: Seconds): number {
  return xOf(view, durationSec) - xOf(view, 0);
}
