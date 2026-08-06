/**
 * The tool rail, and what the editor can have selected.
 *
 * Two small things that would otherwise be spread across `main.ts`, `stage.ts` and
 * `inspector.ts` and would drift.
 *
 * ## The rail is built from the model, not written out in the page
 *
 * `editor.html` carries an empty `<nav class="rail">` and {@link buildRail} fills it
 * from {@link TOOLS}, which is derived from `ANNOTATION_TOOLS`. So an annotation kind
 * added to `@loom/edl`'s `ANNOTATION_KINDS` is either in the rail or is deliberately
 * excluded *in one place with a reason beside it* — never renderable by the
 * compositor and quietly unreachable from the only surface that can author one, which
 * is what phase 11 shipped and phase 15 is here to fix.
 *
 * ## Selection is one union, and the inspector is a function of it
 *
 * There is exactly one selected thing at a time — a zoom region, a keyframe, or an
 * annotation — and every panel reads it. A window that could have two would need a
 * rule for which one Delete removes, and the answer to that question is a mode.
 */

import { icon, type IconName } from '@loom/design';
import { ANNOTATION_TOOLS, type AnnotationTool } from './annotate.ts';
import type { KeyRef } from './zoom.ts';

/** Which pointer gesture the picture is currently interpreting. */
export type ToolId = 'select' | 'zoom' | AnnotationTool;

export interface ToolSpec {
  id: ToolId;
  label: string;
  icon: IconName;
  /** A rule below the picture, in the person's words. Shown while the tool is armed. */
  hint: string;
  /** Draw a separator above this tool in the rail. */
  group?: boolean;
}

const TOOL_ICON: Record<AnnotationTool, IconName> = {
  rect: 'box',
  ellipse: 'bubbleC',
  arrow: 'arrow',
  highlight: 'marker',
  text: 'textT',
  blur: 'blur',
  mask: 'lock',
};

const TOOL_LABEL: Record<AnnotationTool, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  arrow: 'Arrow',
  highlight: 'Highlight',
  text: 'Text',
  blur: 'Blur',
  mask: 'Mask',
};

const TOOL_HINT: Record<AnnotationTool, string> = {
  rect: 'Drag on the picture to draw a rectangle.',
  ellipse: 'Drag on the picture to draw an ellipse.',
  arrow: 'Drag on the picture from the tail to the point.',
  highlight: 'Drag on the picture to highlight.',
  text: 'Drag a box for the text, then type it in the panel.',
  blur: 'Drag over what should be unreadable. It travels with the content, so a zoom cannot slide it off.',
  mask: 'Drag over what should be covered. It travels with the content, so a zoom cannot slide it off.',
};

/** Select, written out so `toolSpec` has a fallback that is a value rather than an index. */
const SELECT_TOOL: ToolSpec = {
  id: 'select',
  label: 'Select',
  icon: 'cursor',
  hint: 'Click something on the picture or the timeline to select it.',
};

/**
 * The rail, in order.
 *
 * `stroke` is the one member of `ANNOTATION_KINDS` with no tool, and `annotate.ts`'s
 * `ANNOTATION_TOOLS` is where that exclusion is argued: a stroke's shape is its
 * `style.points`, written by the live pen during a recording, and a second pen in the
 * editor would draw on a canvas the presenter was never looking at.
 */
export const TOOLS: readonly ToolSpec[] = [
  SELECT_TOOL,
  {
    id: 'zoom',
    label: 'Zoom',
    icon: 'zoomIn',
    hint: 'Click the picture to zoom in on that point. Drag to move the shot.',
    group: true,
  },
  ...ANNOTATION_TOOLS.map((tool, index): ToolSpec => ({
    id: tool,
    label: TOOL_LABEL[tool],
    icon: TOOL_ICON[tool],
    hint: TOOL_HINT[tool],
    // A rule above the first annotation tool, and above the two privacy ones —
    // `isPrivacyKind`'s pair, which fail closed and are worth separating from the
    // decorations for exactly that reason.
    ...(index === 0 || tool === 'blur' ? { group: true } : {}),
  })),
];

export function toolSpec(id: ToolId): ToolSpec {
  return TOOLS.find((tool) => tool.id === id) ?? SELECT_TOOL;
}

/** Is this tool one that creates an annotation by dragging on the picture? */
export function isAnnotationToolId(id: ToolId): id is AnnotationTool {
  return (ANNOTATION_TOOLS as readonly string[]).includes(id);
}

/**
 * Fill the rail. Called once; the pressed state is written by {@link setPressedTool}.
 *
 * The buttons carry `data-tool` rather than a closure per button so that a gate — and
 * a person reading the DOM — can find one by name, and so the click handler is one
 * listener on the rail rather than one per tool.
 */
export function buildRail(rail: HTMLElement, onPick: (id: ToolId) => void): void {
  rail.replaceChildren(
    ...TOOLS.flatMap((tool) => {
      const button = document.createElement('button');
      button.className = 'tb';
      button.type = 'button';
      button.dataset['tool'] = tool.id;
      button.title = tool.label;
      button.setAttribute('aria-label', tool.label);
      button.setAttribute('aria-pressed', String(tool.id === 'select'));
      button.innerHTML = icon(tool.icon, 17);
      if (tool.group !== true) return [button];
      const rule = document.createElement('span');
      rule.className = 'rail-rule';
      return [rule, button];
    }),
  );
  rail.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest('.tb') : null;
    const id = target instanceof HTMLElement ? target.dataset['tool'] : undefined;
    if (id !== undefined) onPick(id as ToolId);
  });
}

export function setPressedTool(rail: HTMLElement, id: ToolId): void {
  for (const button of rail.querySelectorAll<HTMLElement>('.tb')) {
    button.setAttribute('aria-pressed', String(button.dataset['tool'] === id));
  }
}

// ---------------------------------------------------------------- selection

/** The one thing the editor has selected, or `null`. */
export type Selection =
  | { kind: 'zoom'; index: number }
  | { kind: 'key'; ref: KeyRef }
  | { kind: 'annotation'; spanId: string }
  | null;

/** Are these the same selection? Used to avoid rebuilding the inspector on every frame. */
export function sameSelection(a: Selection, b: Selection): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'zoom' && b.kind === 'zoom') return a.index === b.index;
  if (a.kind === 'annotation' && b.kind === 'annotation') return a.spanId === b.spanId;
  if (a.kind === 'key' && b.kind === 'key') {
    return (
      a.ref.trackId === b.ref.trackId && a.ref.channel === b.ref.channel && a.ref.t === b.ref.t
    );
  }
  return false;
}
