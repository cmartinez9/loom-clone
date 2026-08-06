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
 * The one thing that is *not* rebuilt is a field the person is typing in. Replacing a
 * focused `<input>` moves the caret to the end and drops the selection, and this
 * panel's inputs commit on `change` — so a rebuild triggered by somebody else's edit
 * in the middle of a number would eat it. {@link Inspector.render} keeps the focused
 * element when its identity has not changed.
 */

import { formatTimecodeCentis, icon } from '@loom/design';
import type { Seconds, Track, Vec2 } from '@loom/format';
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
  /** Where the playhead is, in source seconds — what "at the playhead" means. */
  playheadSourceSec: Seconds;
  /** The zoom `resolve` reports under the playhead, whatever produced it. */
  resolvedZoom: { amount: number; center: readonly [number, number] };
  /** The generated zoom track covering the playhead, if any — what *override* acts on. */
  generatedAt: Track | null;
  sourceDurationSec: Seconds;
}

/** Everything the panels do. One callback per edit; none of them applies one itself. */
export interface InspectorCallbacks {
  onPlaceZoom: () => void;
  onOverrideZoom: () => void;
  onUpdateZoom: (index: number, patch: Partial<ZoomRegionInput>) => void;
  onRemoveZoom: (index: number) => void;
  onSelect: (selection: Selection) => void;
  onSeek: (sourceSec: Seconds) => void;
  onMoveKey: (view: KeyView, toSec: Seconds) => void;
  onSetKeyValue: (view: KeyView, value: number | number[]) => void;
  onRemoveKey: (view: KeyView) => void;
  onStyleAnnotation: (spanId: string, patch: Record<string, unknown>) => void;
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

  constructor(elements: InspectorElements, callbacks: InspectorCallbacks) {
    this.#elements = elements;
    this.#callbacks = callbacks;
  }

  render(state: InspectorState): void {
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
    const update = (patch: Partial<ZoomRegionInput>): void => {
      this.#callbacks.onUpdateZoom(region.index, patch);
    };
    return [
      body(
        // The magnification, on a slider and in a number beside it. Both write the
        // same op; the slider is for finding a framing by eye and the number is for
        // repeating one, and neither is the source of truth — the document is.
        range({
          name: 'zoom-amount',
          label: 'Amount',
          min: MIN_ZOOM_AMOUNT,
          max: MAX_ZOOM_AMOUNT,
          step: 0.05,
          value: region.amount,
          format: (value) => `${value.toFixed(2)}×`,
          onInput: (amount) => {
            update({ amount });
          },
        }),
        pair({
          name: 'zoom-center',
          label: 'Centre',
          value: region.center,
          step: 0.01,
          onChange: (center) => {
            update({ center });
          },
        }),
        time({
          name: 'zoom-start',
          label: 'Starts',
          value: region.startSec,
          max: state.sourceDurationSec,
          onChange: (startSec) => {
            update({ startSec });
          },
        }),
        time({
          name: 'zoom-end',
          label: 'Ends',
          value: region.endSec,
          max: state.sourceDurationSec,
          onChange: (endSec) => {
            update({ endSec });
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
            this.#callbacks.onStyleAnnotation(view.span.id, { text: value });
          },
        }),
      );
    }
    if (view.kind === 'blur') {
      fields.push(
        range({
          name: 'span-blur',
          label: 'Strength',
          min: 4,
          max: 96,
          step: 1,
          value: typeof style['blurPx'] === 'number' ? style['blurPx'] : 24,
          format: (value) => `${String(Math.round(value))} px`,
          onInput: (blurPx) => {
            this.#callbacks.onStyleAnnotation(view.span.id, { blurPx });
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
            this.#callbacks.onStyleAnnotation(view.span.id, { [key]: value });
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

  // ------------------------------------------------------------------ zoom

  #renderZoom(state: InspectorState): void {
    const inside = state.regions.find(
      (region) =>
        state.playheadSourceSec >= region.startSec &&
        state.playheadSourceSec <= region.windowEndSec,
    );
    const nodes: HTMLElement[] = [];

    nodes.push(
      facts([
        ['At playhead', `${state.resolvedZoom.amount.toFixed(2)}×`],
        [
          'Centre',
          `${(state.resolvedZoom.center[0] ?? 0.5).toFixed(3)}, ${(state.resolvedZoom.center[1] ?? 0.5).toFixed(3)}`,
        ],
        ['Yours', inside === undefined ? 'no' : 'yes'],
      ]),
    );

    // The captain's own row of the capability table, as one button. It is offered
    // whenever a generated zoom track covers the playhead and the user has not
    // already taken control of that moment — which is exactly when "override what the
    // generator produced" means something.
    if (inside === undefined && state.generatedAt !== null) {
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
    } else if (inside === undefined) {
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
      (run as HTMLButtonElement).disabled = !generator.runnable;
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
  const list_ = document.createElement('dl');
  list_.className = 'insp-facts insp-facts-tight';
  for (const [term, value] of entries) {
    const group = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    group.append(dt, dd);
    list_.append(group);
  }
  return list_;
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

function range(spec: {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onInput: (value: number) => void;
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
  // `input` here and `change` on a typed number, deliberately: a slider's whole
  // point is that the picture follows the thumb, and `EditorProject` debounces the
  // recompile on §3.6's own 100 ms so a drag costs one compile rather than sixty.
  control.addEventListener('input', () => {
    const parsed = Number.parseFloat(control.value);
    if (!Number.isFinite(parsed)) return;
    readout.textContent = spec.format(parsed);
    spec.onInput(parsed);
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
