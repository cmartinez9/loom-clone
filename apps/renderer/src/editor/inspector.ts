/**
 * The inspector: the three panels that make the engine underneath reachable.
 *
 * *Zoom* (place, tune, override), *Automatic* (§3.5's regenerate and bake), and the
 * selection's own panel — a zoom region, a keyframe, or an annotation. It builds DOM
 * and calls back; it holds no state of its own and reads none it was not handed,
 * because the document is the state and `EditorProject` is the only thing allowed to
 * change it.
 *
 * ## Every number here is measured or authored, never assumed
 *
 * A keyframe's time is the key's own `t`; a region's extent is read back out of the
 * keys (`zoomRegionsOf`); a generator's key count is counted off the track it
 * produced. `@loom/design`'s `formatTimecodeCentis` formats every instant, so the
 * ruler, the transport and this panel say the same thing about the same moment —
 * which cost a round when they did not.
 *
 * ## Why the panels rebuild rather than reconcile
 *
 * `main.ts`'s header takes the framework decision and argues it on the two things
 * this window does sixty times a second. **The inspector is not one of them**: it is
 * rebuilt on a document change and on a selection change, which is a person's rate,
 * not a frame's. What the header also says is that an inspector growing a dozen
 * interdependent controls is the plausible way that choice stops paying — so the
 * controls here are deliberately flat: each reads one number out of the document and
 * sends one op, and none of them reads another control.
 *
 * ## The one panel that is split, and why that is the same rule rather than an exception
 *
 * The standing *Zoom* panel describes **the playhead**, and a playhead moves at a
 * frame's rate. Rebuilding it on a document change alone left it describing whatever
 * instant the last edit happened at: after an ordinary scrub its readout was a
 * magnification the picture no longer had, and *Take manual control* — the one
 * capability the captain named himself — was withheld on exactly the path a person
 * takes to reach it (scrub to the moment, then take control), so the feature read as
 * absent. {@link Inspector.paintZoom} is the per-frame half, and it is
 * `main.ts`'s `paintPlayhead` split applied one panel over: the **numbers** are text
 * writes guarded on the values changing, and a **rebuild** happens only when the
 * *shape* of the answer does — which region covers the playhead, and whether a
 * generated zoom under it makes *Take manual control* a thing that can be offered.
 * The rule the header states was never about avoiding text writes; it is about not
 * tearing down DOM structure on a timer, and this does not.
 *
 * The one thing that is *not* rebuilt is a field the person is typing in. Replacing a
 * focused `<input>` moves the caret to the end and drops the selection, and this
 * panel's inputs commit on `change` — so a rebuild triggered by somebody else's edit
 * in the middle of a number would eat it. {@link Inspector.render} keeps the focused
 * element when its identity has not changed.
 *
 * ## A slider is a gesture, and a gesture is one edit
 *
 * A `<input type="range">` is the one control here whose interaction outlives a single
 * event, and it needs both halves of {@link range} to be right. **Provisional on
 * `input`, committed on `change`** — the shape `TimelineUi`'s trim handles and
 * `StageUi`'s drags already use, so one drag of the thumb is one undo step rather than
 * sixty, and it is `EditorProject.preview` (not `commit`) that debounces the recompile
 * on §3.6's own 100 ms. And **the panel does not rebuild while the gesture is live**:
 * committing on `input` ran `replaceChildren` over the very element the pointer had
 * hold of, which ends the drag on first contact, and the focus/caret restore below
 * cannot put an in-flight pointer capture back. {@link Inspector.render} therefore
 * defers to a control that is mid-gesture; the readout under the thumb is written by
 * the slider itself, so nothing a person is looking at goes stale.
 */

import { formatTimecodeCentis, icon } from '@loom/design';
import type { Seconds, Track, Vec2 } from '@loom/format';
import {
  panelIsHeld,
  sliderStep,
  zoomPaintDecision,
  type ControlPhase,
  type ZoomReadout,
} from './gestures.ts';
import type { AnnotationKind } from '@loom/edl';
import { ANNOTATION_TOOLS, type AnnotationView } from './annotate.ts';
import { describeStaleness, type GeneratorState, type RunnableGenerator } from './generators.ts';
import type { Selection } from './tools.ts';
import {
  MAX_ZOOM_AMOUNT,
  MIN_ZOOM_AMOUNT,
  type KeyView,
  type ZoomRegion,
  type ZoomRegionInput,
} from './zoom.ts';

/** Everything the panels read. Assembled by `main.ts` on every document change. */
export interface InspectorState {
  selection: Selection;
  regions: ZoomRegion[];
  keys: KeyView[];
  annotations: AnnotationView[];
  generators: GeneratorState[];
  /**
   * The manual region covering the playhead, by `ZoomRegion.index`, or `-1`.
   *
   * The index rather than the instant, because {@link Inspector.paintZoom} asks the
   * same question sixty times a second and two implementations of *"which region is
   * the playhead in"* is one predicate with a second answer beside it waiting to
   * drift. `main.ts` owns it, and both paths call the one function.
   */
  regionIndexAtPlayhead: number;
  /** The zoom `resolve` reports under the playhead, whatever produced it. */
  resolvedZoom: { amount: number; center: readonly [number, number] };
  /** The generated zoom track covering the playhead, if any — what *override* acts on. */
  generatedAt: Track | null;
  sourceDurationSec: Seconds;
}

/**
 * Where a control is in its own gesture.
 *
 * `'move'` is provisional — shown, never committed, never sent — and `'end'` is the
 * edit. The same two words `StageCallbacks` and `TimelineCallbacks` use, because a
 * slider drag and a handle drag are the same kind of thing and a second vocabulary for
 * it would be a second interaction model.
 */
export type { ControlPhase, ZoomReadout } from './gestures.ts';

/**
 * What the standing *Zoom* panel reads on the playhead's own frame.
 *
 * Everything in it is a number the caller already has: `main.ts`'s `paintPlayhead`
 * resolves once per frame for the timeline and the stage, and this is that same
 * reading handed on rather than a second one. The centre arrives as two numbers
 * because `resolve` returns the compiled timeline's **own** state object and
 * overwrites it in place — a tuple here would either be that object's or a fresh
 * allocation on a path that must not have one.
 */
/** Everything the panels do. One callback per edit; none of them applies one itself. */
export interface InspectorCallbacks {
  onPlaceZoom: () => void;
  onOverrideZoom: () => void;
  onUpdateZoom: (index: number, patch: Partial<ZoomRegionInput>, phase: ControlPhase) => void;
  onRemoveZoom: (index: number) => void;
  onSelect: (selection: Selection) => void;
  onSeek: (sourceSec: Seconds) => void;
  onMoveKey: (view: KeyView, toSec: Seconds) => void;
  onSetKeyValue: (view: KeyView, value: number | number[]) => void;
  onRemoveKey: (view: KeyView) => void;
  onStyleAnnotation: (spanId: string, patch: Record<string, unknown>, phase: ControlPhase) => void;
  onRetimeAnnotation: (spanId: string, times: { startSec?: Seconds; endSec?: Seconds }) => void;
  onRemoveAnnotation: (spanId: string) => void;
  onGenerate: (type: RunnableGenerator) => void;
  onBake: (type: RunnableGenerator) => void;
}

export interface InspectorElements {
  selection: HTMLElement;
  zoom: HTMLElement;
  generators: HTMLElement;
}

export class Inspector {
  readonly #elements: InspectorElements;
  readonly #callbacks: InspectorCallbacks;
  /**
   * The `name` of a control that is mid-gesture, or `null`.
   *
   * Set by {@link Inspector.#slider} while the thumb is between its first `input` and
   * its `change`. Nothing else is a gesture: every other field here commits on
   * `change` alone, so it is never holding an element a rebuild would take away.
   */
  #gesture: string | null = null;
  /**
   * The two `<dd>`s the standing Zoom panel's per-frame half writes.
   *
   * Held from the rebuild that made them rather than found again by position: a
   * position in a list is not identity, and `zoom.ts`'s `regionCenter` is what
   * forgetting that costs.
   */
  #zoomAmountValue: HTMLElement | null = null;
  #zoomCenterValue: HTMLElement | null = null;
  /**
   * What the standing Zoom panel last said, and what it is being asked to say.
   *
   * Two {@link ZoomReadout}s allocated once with the `Inspector` and **mutated in
   * place**, never rebuilt. {@link Inspector.paintZoom} runs on the playhead's own
   * frame — every frame while it moves — and §4.3's first rule is that nothing on that
   * path allocates, which is the same reason `zoomRegionIndexAt` and
   * `generatedSegmentIndexAt` answer indexes rather than objects.
   */
  readonly #painted: ZoomReadout = {
    regionIndex: -1,
    generated: false,
    amount: Number.NaN,
    centerX: Number.NaN,
    centerY: Number.NaN,
  };
  readonly #pending: ZoomReadout = {
    regionIndex: -1,
    generated: false,
    amount: Number.NaN,
    centerX: Number.NaN,
    centerY: Number.NaN,
  };
  /** Has this panel ever been built? `#painted` means nothing until it has. */
  #hasPainted = false;

  constructor(elements: InspectorElements, callbacks: InspectorCallbacks) {
    this.#elements = elements;
    this.#callbacks = callbacks;
  }

  /**
   * The standing Zoom panel's per-frame half. Returns `true` when it needs rebuilding.
   *
   * The split is `paintPlayhead`'s, deliberately, because a second interaction model
   * for the same kind of thing is a second thing to keep right: the **numbers** are
   * text writes guarded on the values changing, and the *shape* of the answer — which
   * region covers the playhead, and whether *Take manual control* can be offered at
   * all — is a two-field comparison whose only outcome is asking the caller for the
   * rebuild it already knows how to do. Nothing here allocates.
   *
   * A control that is mid-gesture owns this panel, exactly as in {@link
   * Inspector.render}: asking for a rebuild that is deliberately ignored, sixty times
   * a second, is worse than being one gesture behind.
   */
  paintZoom(
    regionIndex: number,
    generated: boolean,
    amount: number,
    centerX: number,
    centerY: number,
  ): boolean {
    // Scalars in, and the readout the decision reads is this instance's own — the
    // caller runs on the playhead's frame, so a literal here or at the call site is an
    // allocation per frame on the path whose whole rule is that there are none.
    const pending = this.#pending;
    pending.regionIndex = regionIndex;
    pending.generated = generated;
    pending.amount = amount;
    pending.centerX = centerX;
    pending.centerY = centerY;
    // The decision is `gestures.ts`'s and the doing is here. It was inline until a
    // lost GPU context showed that the only thing guarding it was a gate that
    // composites — see that module's header.
    const previous = this.#hasPainted ? this.#painted : null;
    switch (zoomPaintDecision(previous, pending, panelIsHeld(this.#gesture))) {
      case 'rebuild':
        return true;
      case 'nothing':
        return false;
      case 'write':
        this.#painted.amount = amount;
        this.#painted.centerX = centerX;
        this.#painted.centerY = centerY;
        if (this.#zoomAmountValue !== null) this.#zoomAmountValue.textContent = amountText(amount);
        if (this.#zoomCenterValue !== null)
          this.#zoomCenterValue.textContent = centreText(centerX, centerY);
        return false;
    }
  }

  render(state: InspectorState): void {
    // A control that is mid-gesture owns its own element until the gesture ends.
    // `replaceChildren` here would remove the `<input type="range">` the pointer has
    // hold of — the drag stops after one step, which is the control not working
    // rather than the control needing polish. The provisional document a drag shows
    // reaches the picture through `PreviewHost`; this panel catches up on release.
    if (panelIsHeld(this.#gesture)) return;

    // What has focus, and where the caret is, so a rebuild does not eat a number
    // somebody is halfway through typing. Keyed by the field's `name`, which is
    // stable across rebuilds because it names what the field edits.
    const active = document.activeElement;
    const focused =
      active instanceof HTMLInputElement && this.#owns(active)
        ? { name: active.name, start: active.selectionStart, end: active.selectionEnd }
        : null;

    this.#renderSelection(state);
    this.#renderZoom(state);
    this.#renderGenerators(state);

    if (focused !== null) {
      const next = this.#find(focused.name);
      if (next !== null) {
        next.focus();
        if (next.type === 'text' || next.type === 'number') {
          try {
            next.setSelectionRange(focused.start, focused.end);
          } catch {
            // `setSelectionRange` throws on an input type that has no selection.
            // Focus is the part that matters; the caret is a nicety.
          }
        }
      }
    }
  }

  /** The three panels, as a list. Written out because `Object.values` loses the type. */
  #panels(): HTMLElement[] {
    return [this.#elements.selection, this.#elements.zoom, this.#elements.generators];
  }

  #owns(input: HTMLInputElement): boolean {
    return this.#panels().some((element) => element.contains(input));
  }

  #find(name: string): HTMLInputElement | null {
    for (const element of this.#panels()) {
      const found = element.querySelector<HTMLInputElement>(`input[name="${CSS.escape(name)}"]`);
      if (found !== null) return found;
    }
    return null;
  }

  // ------------------------------------------------------------- selection

  #renderSelection(state: InspectorState): void {
    const host = this.#elements.selection;
    const selection = state.selection;
    if (selection === null) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    host.hidden = false;

    if (selection.kind === 'zoom') {
      const region = state.regions.find((r) => r.index === selection.index);
      if (region === undefined) {
        host.hidden = true;
        return;
      }
      // "Selected zoom", not "Zoom": the standing panel below is titled *Zoom* and
      // two adjacent headers reading the same word is a screenshot's finding, not a
      // test's.
      host.replaceChildren(header('Selected zoom'), ...this.#zoomRegionFields(region, state));
      return;
    }

    if (selection.kind === 'key') {
      const view = state.keys.find(
        (k) =>
          k.trackId === selection.ref.trackId &&
          k.channel === selection.ref.channel &&
          k.t === selection.ref.t,
      );
      if (view === undefined) {
        host.hidden = true;
        return;
      }
      host.replaceChildren(header('Keyframe'), ...this.#keyFields(view, state));
      return;
    }

    const view = state.annotations.find((a) => a.span.id === selection.spanId);
    if (view === undefined) {
      host.hidden = true;
      return;
    }
    host.replaceChildren(header(labelOf(view.kind)), ...this.#annotationFields(view, state));
  }

  #zoomRegionFields(region: ZoomRegion, state: InspectorState): HTMLElement[] {
    const update = (patch: Partial<ZoomRegionInput>, phase: ControlPhase): void => {
      this.#callbacks.onUpdateZoom(region.index, patch, phase);
    };
    return [
      body(
        // The magnification, on a slider and in a number beside it. Both write the
        // same op; the slider is for finding a framing by eye and the number is for
        // repeating one, and neither is the source of truth — the document is.
        this.#slider({
          name: 'zoom-amount',
          label: 'Amount',
          min: MIN_ZOOM_AMOUNT,
          max: MAX_ZOOM_AMOUNT,
          step: 0.05,
          value: region.amount,
          format: (value) => `${value.toFixed(2)}×`,
          onChange: (amount, phase) => {
            update({ amount }, phase);
          },
        }),
        pair({
          name: 'zoom-center',
          label: 'Centre',
          value: region.center,
          step: 0.01,
          onChange: (center) => {
            update({ center }, 'end');
          },
        }),
        time({
          name: 'zoom-start',
          label: 'Starts',
          value: region.startSec,
          max: state.sourceDurationSec,
          onChange: (startSec) => {
            update({ startSec }, 'end');
          },
        }),
        time({
          name: 'zoom-end',
          label: 'Ends',
          value: region.endSec,
          max: state.sourceDurationSec,
          onChange: (endSec) => {
            update({ endSec }, 'end');
          },
        }),
        actions(
          button('Go to', 'clock', () => {
            this.#callbacks.onSeek(region.startSec);
          }),
          danger('Remove', 'trash', () => {
            this.#callbacks.onRemoveZoom(region.index);
          }),
        ),
        note(
          'Drag the picture with the zoom tool to move the shot. This zoom is yours: ' +
            'regenerating the automatic ones leaves it alone.',
        ),
      ),
    ];
  }

  #keyFields(view: KeyView, state: InspectorState): HTMLElement[] {
    const value = view.key.v;
    const fields: HTMLElement[] = [
      facts([
        ['Channel', view.channel],
        ['Track', trackLabel(view, state)],
        ['Easing', view.key.ease.kind],
      ]),
    ];
    if (!view.editable) {
      fields.push(
        note(
          'This keyframe belongs to a generated track. Regenerating rewrites that ' +
            'track, so an edit made here would be thrown away without warning — take ' +
            'manual control below, or bake the track to make its keyframes yours.',
        ),
      );
      return [body(...fields)];
    }
    fields.push(
      time({
        name: 'key-t',
        label: 'At',
        value: view.t,
        max: state.sourceDurationSec,
        onChange: (t) => {
          this.#callbacks.onMoveKey(view, t);
        },
      }),
    );
    if (typeof value === 'number') {
      fields.push(
        number({
          name: 'key-v',
          label: 'Value',
          value,
          step: 0.05,
          onChange: (next) => {
            this.#callbacks.onSetKeyValue(view, next);
          },
        }),
      );
    } else {
      fields.push(
        pair({
          name: 'key-v',
          label: 'Value',
          value: [value[0] ?? 0, value[1] ?? 0],
          step: 0.01,
          onChange: (next) => {
            this.#callbacks.onSetKeyValue(view, [next[0], next[1]]);
          },
        }),
      );
    }
    fields.push(
      actions(
        button('Go to', 'clock', () => {
          this.#callbacks.onSeek(view.t);
        }),
        danger('Delete', 'trash', () => {
          this.#callbacks.onRemoveKey(view);
        }),
      ),
    );
    return [body(...fields)];
  }

  #annotationFields(view: AnnotationView, state: InspectorState): HTMLElement[] {
    const style = view.span.style ?? {};
    const fields: HTMLElement[] = [
      time({
        name: 'span-start',
        label: 'From',
        value: view.startSec,
        max: state.sourceDurationSec,
        onChange: (startSec) => {
          this.#callbacks.onRetimeAnnotation(view.span.id, { startSec });
        },
      }),
      time({
        name: 'span-end',
        label: 'To',
        value: view.endSec,
        max: state.sourceDurationSec,
        onChange: (endSec) => {
          this.#callbacks.onRetimeAnnotation(view.span.id, { endSec });
        },
      }),
    ];

    if (view.kind === 'text') {
      fields.push(
        text({
          name: 'span-text',
          label: 'Text',
          value: typeof style['text'] === 'string' ? style['text'] : '',
          onChange: (value) => {
            this.#callbacks.onStyleAnnotation(view.span.id, { text: value }, 'end');
          },
        }),
      );
    }
    if (view.kind === 'blur') {
      fields.push(
        this.#slider({
          name: 'span-blur',
          label: 'Strength',
          min: 4,
          max: 96,
          step: 1,
          value: typeof style['blurPx'] === 'number' ? style['blurPx'] : 24,
          format: (value) => `${String(Math.round(value))} px`,
          onChange: (blurPx, phase) => {
            this.#callbacks.onStyleAnnotation(view.span.id, { blurPx }, phase);
          },
        }),
      );
    }
    // Every kind but the two privacy ones takes a colour. A mask is black and opaque
    // because "make this unreadable" has one answer, and a blur's fill is not drawn
    // at all — offering either a swatch would be offering a control that does nothing.
    if (view.kind !== 'blur' && view.kind !== 'mask') {
      const key = view.kind === 'highlight' || view.kind === 'text' ? 'fill' : 'stroke';
      fields.push(
        colour({
          name: 'span-colour',
          label: 'Colour',
          value: typeof style[key] === 'string' ? style[key] : DEFAULT_COLOUR,
          onChange: (value) => {
            this.#callbacks.onStyleAnnotation(view.span.id, { [key]: value }, 'end');
          },
        }),
      );
    }

    fields.push(
      actions(
        button('Go to', 'clock', () => {
          this.#callbacks.onSeek(view.startSec);
        }),
        danger('Delete', 'trash', () => {
          this.#callbacks.onRemoveAnnotation(view.span.id);
        }),
      ),
    );
    if (view.kind === 'blur' || view.kind === 'mask') {
      fields.push(
        note(
          'This is placed on the picture, not on the frame, so a zoom cannot slide ' +
            'it off what it is covering.',
        ),
      );
    }
    return [body(...fields)];
  }

  /**
   * A slider, wired to this panel's own gesture guard.
   *
   * The only reason it is a method rather than another free builder below: the guard
   * is per-inspector state and the slider is the one control that has to reach it.
   * Every slider in this file goes through here, so there is no second answer to what
   * a drag costs.
   */
  #slider(spec: {
    name: string;
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format: (value: number) => string;
    onChange: (value: number, phase: ControlPhase) => void;
  }): HTMLElement {
    return range({
      ...spec,
      onGesture: (active) => {
        this.#gesture = active ? spec.name : null;
      },
    });
  }

  // ------------------------------------------------------------------ zoom

  #renderZoom(state: InspectorState): void {
    const inside = state.regionIndexAtPlayhead >= 0;
    const nodes: HTMLElement[] = [];

    // The two numbers this panel says about the playhead are written again by
    // {@link Inspector.paintZoom} as it moves, so the `<dd>`s are kept and the
    // formatting lives in one function each. The "Yours" row is not one of them: it
    // is *shape*, and a change to it arrives here as a rebuild.
    const amountValue = factValue(amountText(state.resolvedZoom.amount));
    const centerValue = factValue(
      centreText(state.resolvedZoom.center[0] ?? 0.5, state.resolvedZoom.center[1] ?? 0.5),
    );
    this.#zoomAmountValue = amountValue;
    this.#zoomCenterValue = centerValue;
    this.#painted.amount = state.resolvedZoom.amount;
    this.#painted.centerX = state.resolvedZoom.center[0] ?? 0.5;
    this.#painted.centerY = state.resolvedZoom.center[1] ?? 0.5;
    this.#painted.regionIndex = state.regionIndexAtPlayhead;
    this.#painted.generated = state.generatedAt !== null;
    this.#hasPainted = true;

    nodes.push(
      factList([
        ['At playhead', amountValue],
        ['Centre', centerValue],
        ['Yours', factValue(inside ? 'yes' : 'no')],
      ]),
    );

    // The captain's own row of the capability table, as one button. It is offered
    // whenever a generated zoom track covers the playhead and the user has not
    // already taken control of that moment — which is exactly when "override what the
    // generator produced" means something.
    if (!inside && state.generatedAt !== null) {
      nodes.push(
        actions(
          primary('Take manual control', 'keyframe', () => {
            this.#callbacks.onOverrideZoom();
          }),
        ),
        note(
          'The automatic zoom keeps running everywhere else. Yours wins only over ' +
            'the stretch it covers, and it survives a regenerate.',
        ),
      );
    } else if (!inside) {
      nodes.push(
        actions(
          primary('Zoom here', 'zoomIn', () => {
            this.#callbacks.onPlaceZoom();
          }),
        ),
      );
    }

    if (state.regions.length > 0) {
      nodes.push(
        list(
          state.regions.map((region) => ({
            label: `${formatTimecodeCentis(region.startSec)} · ${region.amount.toFixed(2)}×`,
            selected: state.selection?.kind === 'zoom' && state.selection.index === region.index,
            onPick: () => {
              this.#callbacks.onSelect({ kind: 'zoom', index: region.index });
              this.#callbacks.onSeek(region.startSec);
            },
          })),
        ),
      );
    } else {
      nodes.push(note('No zoom of your own yet. Place one here, or with the zoom tool.'));
    }

    this.#elements.zoom.replaceChildren(...nodes);
  }

  // ------------------------------------------------------------ generators

  #renderGenerators(state: InspectorState): void {
    this.#elements.generators.replaceChildren(
      ...state.generators.map((generator) => this.#generatorRow(generator)),
    );
  }

  #generatorRow(generator: GeneratorState): HTMLElement {
    const row = document.createElement('div');
    row.className = 'gen';
    row.dataset['generator'] = generator.type;

    const title = document.createElement('div');
    title.className = 'gen-t';
    title.textContent = generator.label;
    const state = document.createElement('span');
    state.className = 'chip chip-muted';
    state.textContent = statusOf(generator);
    if (generator.staleness?.stale === true) state.className = 'chip chip-accent';
    title.append(state);
    row.append(title);

    const stale = describeStaleness(generator);
    if (stale !== '') row.append(note(stale));
    else if (generator.reason !== '') row.append(note(generator.reason));
    else if (generator.baked)
      row.append(
        note('Baked: its keyframes are yours now, and regenerating cannot overwrite them.'),
      );

    const buttons: HTMLElement[] = [];
    if (!generator.baked) {
      const label = generator.track === null ? 'Generate' : 'Regenerate';
      const run = button(label, 'restart', () => {
        this.#callbacks.onGenerate(generator.type);
      });
      (run as HTMLButtonElement).disabled = generator.status !== 'runnable';
      run.dataset['action'] = 'generate';
      buttons.push(run);
    }
    // §3.5: a baked track is *detached* from regeneration, and offering it a bake
    // again would be offering an operation with nothing to do. `isRegenerable` is the
    // predicate that says so and it is asked rather than re-derived here.
    if (generator.track !== null && !generator.baked) {
      const bake = button('Bake', 'magnet', () => {
        this.#callbacks.onBake(generator.type);
      });
      bake.dataset['action'] = 'bake';
      buttons.push(bake);
    }
    if (buttons.length > 0) row.append(actions(...buttons));
    return row;
  }
}

// ---------------------------------------------------------------- controls

const DEFAULT_COLOUR = '#FF3B30';

function statusOf(generator: GeneratorState): string {
  if (generator.baked) return 'baked';
  if (generator.track === null) return 'off';
  if (generator.staleness?.stale === true) return 'stale';
  return 'on';
}

function labelOf(kind: AnnotationKind): string {
  const index = (ANNOTATION_TOOLS as readonly string[]).indexOf(kind);
  if (index < 0) return kind;
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Which track a key came from, in the words §3.5 uses for the three states. */
function trackLabel(view: KeyView, state: InspectorState): string {
  const generator = state.generators.find((g) => g.track?.id === view.trackId);
  if (generator === undefined) return view.editable ? 'yours' : 'generated';
  if (generator.baked) return `${generator.label} (baked)`;
  return generator.label;
}

function header(title: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'insp-h';
  const label = document.createElement('span');
  label.className = 't-d4';
  label.textContent = title;
  element.append(label);
  return element;
}

function body(...children: HTMLElement[]): HTMLElement {
  const element = document.createElement('div');
  element.className = 'insp-body';
  element.append(...children);
  return element;
}

function facts(entries: readonly (readonly [string, string])[]): HTMLElement {
  return factList(entries.map(([term, said]) => [term, factValue(said)]));
}

/** One fact's `<dd>`, handed back so a per-frame writer can hold the node it owns. */
function factValue(said: string): HTMLElement {
  const dd = document.createElement('dd');
  dd.textContent = said;
  return dd;
}

/** The list {@link facts} builds, from `<dd>`s the caller made. */
function factList(entries: readonly (readonly [string, HTMLElement])[]): HTMLElement {
  const list_ = document.createElement('dl');
  list_.className = 'insp-facts insp-facts-tight';
  for (const [term, dd] of entries) {
    const group = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = term;
    group.append(dt, dd);
    list_.append(group);
  }
  return list_;
}

/**
 * The two numbers the standing Zoom panel says, each in one function.
 *
 * One place each, because they are written twice — once by the rebuild and once per
 * frame as the playhead moves — and a panel that formatted the same number two ways
 * would read as changing when nothing had.
 */
function amountText(amount: number): string {
  return `${amount.toFixed(2)}×`;
}

function centreText(x: number, y: number): string {
  return `${x.toFixed(3)}, ${y.toFixed(3)}`;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const element = document.createElement('label');
  element.className = 'fld';
  const text_ = document.createElement('span');
  text_.className = 'fld-l';
  text_.textContent = label;
  element.append(text_, control);
  return element;
}

function input(name: string, type: string): HTMLInputElement {
  const element = document.createElement('input');
  element.className = 'inp';
  element.type = type;
  element.name = name;
  return element;
}

function number(spec: {
  name: string;
  label: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}): HTMLElement {
  const control = input(spec.name, 'number');
  control.step = String(spec.step);
  control.value = spec.value.toFixed(decimalsFor(spec.step));
  // `change`, not `input`: a number typed digit by digit passes through values the
  // user never meant, and each one would be an op, a revision and an undo step.
  control.addEventListener('change', () => {
    const parsed = Number.parseFloat(control.value);
    if (Number.isFinite(parsed)) spec.onChange(parsed);
  });
  return field(spec.label, control);
}

function time(spec: {
  name: string;
  label: string;
  value: Seconds;
  max: Seconds;
  onChange: (value: Seconds) => void;
}): HTMLElement {
  const control = input(spec.name, 'number');
  control.step = '0.05';
  control.min = '0';
  control.max = spec.max.toFixed(2);
  control.value = spec.value.toFixed(2);
  const readout = document.createElement('span');
  readout.className = 'fld-r';
  // The same formatter the ruler and the transport use, so three surfaces cannot
  // disagree about one instant at some length nobody tested.
  readout.textContent = formatTimecodeCentis(spec.value);
  control.addEventListener('change', () => {
    const parsed = Number.parseFloat(control.value);
    if (Number.isFinite(parsed)) spec.onChange(parsed);
  });
  const wrapper = document.createElement('span');
  wrapper.className = 'fld-c';
  wrapper.append(control, readout);
  return field(spec.label, wrapper);
}

function pair(spec: {
  name: string;
  label: string;
  value: Vec2;
  step: number;
  onChange: (value: Vec2) => void;
}): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'fld-c';
  const controls = (['x', 'y'] as const).map((axis, i) => {
    const control = input(`${spec.name}-${axis}`, 'number');
    control.step = String(spec.step);
    control.value = (spec.value[i] ?? 0).toFixed(decimalsFor(spec.step));
    control.addEventListener('change', () => {
      const x = Number.parseFloat(controls[0]?.value ?? '');
      const y = Number.parseFloat(controls[1]?.value ?? '');
      if (Number.isFinite(x) && Number.isFinite(y)) spec.onChange([x, y]);
    });
    return control;
  });
  wrapper.append(...controls);
  return field(spec.label, wrapper);
}

/**
 * A slider: two phases, one edit, and an element that survives its own drag.
 *
 * `input` is **provisional** and `change` **commits** — the shape `TimelineUi`'s trim
 * handles and `StageUi`'s drags already use. Both halves matter and each closes a
 * different defect. A slider that committed on `input` put one op, one revision and
 * one undo entry on the stack per step of the thumb, so undoing a drag afterwards
 * would mean pressing undo as many times as the pointer moved. And it recompiled on
 * every one of them: it is `EditorProject.preview` that debounces on §3.6's own
 * 100 ms and `commit` deliberately clears that debounce, so *"a drag costs one compile
 * rather than sixty"* was only ever a statement about the call this now makes.
 *
 * {@link range} bracketing its own gesture is the other half. Committing on `input`
 * ran `replaceChildren` over this very element on its first event, which ends the
 * drag on first contact — the panel's focus/caret restore can put focus back and
 * cannot put a pointer capture back. The bracket is `input`/`change` rather than
 * pointer events so a keyboard arrow, which fires both in that order, is one gesture
 * on the same path.
 */
function range(spec: {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number, phase: ControlPhase) => void;
  /** `true` when the gesture starts, `false` when it ends. */
  onGesture: (active: boolean) => void;
}): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'fld-c';
  const control = input(spec.name, 'range');
  control.min = String(spec.min);
  control.max = String(spec.max);
  control.step = String(spec.step);
  control.value = String(spec.value);
  const readout = document.createElement('span');
  readout.className = 'fld-r';
  readout.textContent = spec.format(spec.value);
  // Written here rather than by a rebuild, which is what lets the panel stand still
  // for the length of the gesture without anything a person is looking at going stale.
  // The three handlers are one decision each, and the decision is `gestures.ts`'s:
  // `input` is a *move* and `change` is an *end*, the guard is armed before the value
  // is reported and disarmed before the commit, and `blur` is the backstop for a
  // gesture the window interrupted. That module's header says why it is not inline.
  const step = (event: 'input' | 'change' | 'blur'): void => {
    const action = sliderStep(event, control.value);
    if (action.gesture !== null) spec.onGesture(action.gesture);
    if (action.value !== null) readout.textContent = spec.format(action.value);
    if (action.value !== null && action.phase !== null) spec.onChange(action.value, action.phase);
  };
  control.addEventListener('input', () => {
    step('input');
  });
  control.addEventListener('change', () => {
    step('change');
  });
  control.addEventListener('blur', () => {
    step('blur');
  });
  wrapper.append(control, readout);
  return field(spec.label, wrapper);
}

function text(spec: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}): HTMLElement {
  const control = input(spec.name, 'text');
  control.value = spec.value;
  control.addEventListener('change', () => {
    spec.onChange(control.value);
  });
  return field(spec.label, control);
}

/**
 * A colour swatch.
 *
 * `<input type="color">` gives `#rrggbb`, which is exactly one of the four forms
 * `parseColor` reads — deliberately not a CSS colour parser, because §4.5 does not
 * let two implementations answer what `color(display-p3 …)` means in the target's
 * encoding.
 */
function colour(spec: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}): HTMLElement {
  const control = input(spec.name, 'color');
  control.value = /^#[0-9a-f]{6}$/i.test(spec.value) ? spec.value : DEFAULT_COLOUR;
  control.addEventListener('change', () => {
    spec.onChange(control.value);
  });
  return field(spec.label, control);
}

function actions(...children: HTMLElement[]): HTMLElement {
  const element = document.createElement('div');
  element.className = 'insp-actions';
  element.append(...children);
  return element;
}

function button(label: string, name: Parameters<typeof icon>[0], onClick: () => void): HTMLElement {
  const element = document.createElement('button');
  element.className = 'btn btn-sm';
  element.type = 'button';
  const slot = document.createElement('span');
  slot.className = 'ic-slot';
  slot.innerHTML = icon(name, 14);
  element.append(slot, document.createTextNode(label));
  element.addEventListener('click', onClick);
  return element;
}

function primary(
  label: string,
  name: Parameters<typeof icon>[0],
  onClick: () => void,
): HTMLElement {
  const element = button(label, name, onClick);
  element.className = 'btn btn-sm btn-primary';
  return element;
}

function danger(label: string, name: Parameters<typeof icon>[0], onClick: () => void): HTMLElement {
  const element = button(label, name, onClick);
  element.className = 'btn btn-sm btn-danger';
  return element;
}

function list(
  items: readonly { label: string; selected: boolean; onPick: () => void }[],
): HTMLElement {
  const element = document.createElement('div');
  element.className = 'insp-list';
  for (const item of items) {
    const row = document.createElement('button');
    row.className = 'insp-item';
    row.type = 'button';
    row.setAttribute('aria-pressed', String(item.selected));
    row.textContent = item.label;
    row.addEventListener('click', item.onPick);
    element.append(row);
  }
  return element;
}

function note(message: string): HTMLElement {
  const element = document.createElement('p');
  element.className = 'insp-note';
  element.textContent = message;
  return element;
}

/** How many decimals a step implies, so a field does not print `0.30000000000000004`. */
function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(step)));
}
