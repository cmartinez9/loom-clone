/**
 * The stage's one invariant: a gesture that began provisionally ends in exactly one of
 * commit or cancel.
 *
 * Every `'move'` a drag on the picture dispatches leaves a **provisional** document on
 * `EditorProject` — the frame under the pointer — and only the terminal `'end'`, or a
 * cancel, clears it. So an exit from a live drag that dispatches neither is invisible
 * data drift: the preview and the inspector go on showing geometry that is in no
 * `edit.json` until some later commit or undo happens by, with nothing on screen that
 * says so. `apps/renderer/src/editor/main.ts`'s `edit(ops, phase, label)` is the
 * boundary that answers the *"this changes nothing"* half of that class; this file
 * covers the half that never reaches a callback at all.
 *
 * The reachable exit is the **letterbox**. `outputToSource` answers `null` off the
 * picture rather than clamping (phase 11's privacy argument, restated at the seam a
 * pointer crosses), and the letterbox exists on every bundle whose capture aspect
 * differs from `edit.output.size` — which is every bundle on this machine, since
 * nothing sets `output.size` from the recording. Pointer capture is on the overlay, so
 * a release past the edge of the picture still arrives here.
 *
 * ## Why a stub DOM, and what it is and is not evidence of
 *
 * `vitest.config.ts` runs in `node`, and `apps/renderer/test/export-encode.test.ts`
 * already stubs `VideoEncoder`/`AudioEncoder` the same way. What is under test is
 * `StageUi`'s own control flow — which exits dispatch and which do not — and that is
 * not a claim about DOM fidelity. The claim that a real pointer on a real window
 * reaches these handlers at all belongs to `test/phase15-gate.test.ts`, which drives
 * `sendInputEvent` into the shipping page; this is the guard that cannot withhold.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vec2 } from '@loom/format';
import { StageUi, type StageCallbacks, type StageState } from '../src/editor/stage.ts';
import type { AnnotationView } from '../src/editor/annotate.ts';

/**
 * The output is 4:3 and the capture is 2:1, so the contain-fit leaves a letterbox
 * across the top and bottom sixth of the canvas: `y` in `[1/6, 5/6]` is the picture
 * and anything outside it has no source coordinate.
 */
const MAPPING = {
  outputSize: [400, 300] as const,
  sourceSize: [400, 200] as const,
  zoom: { amount: 1, center: [0.5, 0.5] as const },
};

const ON_PICTURE = { x: 0.5, y: 0.5 };
const ALSO_ON_PICTURE = { x: 0.6, y: 0.55 };
const ON_LETTERBOX = { x: 0.5, y: 0.02 };

class FakeElement {
  className = '';
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  remove(): void {
    // Detaching a node the test never looks at again.
  }

  setPointerCapture(): void {
    // The real one can throw; `StageUi` already catches that and it is not this test's.
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 400, height: 300 };
  }

  /** The one thing this stub adds: fire a listener the way the platform would. */
  fire(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

/** A pointer event at `0..1` of the canvas, on a target with the given `role`. */
function pointer(at: { x: number; y: number }, target: FakeElement | null): unknown {
  return {
    pointerId: 1,
    clientX: at.x * 400,
    clientY: at.y * 300,
    target,
    preventDefault: () => {
      // The real handler calls it; nothing here reads it.
    },
  };
}

/** A placed mask, selected — the kind whose move drag is the one under test. */
function selectedMask(): AnnotationView {
  return {
    span: { id: 's-mask-1', type: 'mask', start: 0, end: 4, channels: {} },
    kind: 'mask',
    startSec: 0,
    endSec: 4,
    center: [0.5, 0.5] as Vec2,
    size: [0.2, 0.2] as Vec2,
    from: null,
    to: null,
  } as unknown as AnnotationView;
}

function stageState(): StageState {
  return { tool: 'select', mapping: MAPPING, selected: selectedMask(), selectedVisible: true };
}

let root: FakeElement;
let callbacks: {
  onDraw: ReturnType<typeof vi.fn>;
  onEditAnnotation: ReturnType<typeof vi.fn>;
  onPick: ReturnType<typeof vi.fn>;
  onZoomTo: ReturnType<typeof vi.fn>;
  onCancelGesture: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('document', { createElement: () => new FakeElement() });
  root = new FakeElement();
  callbacks = {
    onDraw: vi.fn(),
    onEditAnnotation: vi.fn(),
    onPick: vi.fn(),
    onZoomTo: vi.fn(),
    onCancelGesture: vi.fn(),
  };
  const stage = new StageUi(root as unknown as HTMLElement, callbacks satisfies StageCallbacks);
  stage.render(stageState());
});

/** The node `render` drew for the whole box — the one a move drag grabs. */
function frame(): FakeElement {
  const found = root.children.find((child) => child.dataset['role'] === 'move');
  expect(found, 'the overlay drew no move handle').toBeDefined();
  return found!;
}

/** The phases `onEditAnnotation` was called with, in order. */
function phases(): string[] {
  return callbacks.onEditAnnotation.mock.calls.map((call) => String(call[2]));
}

describe('a drag released off the picture', () => {
  it('cancels the gesture rather than leaving its preview stranded', () => {
    root.fire('pointerdown', pointer(ON_PICTURE, frame()));
    root.fire('pointermove', pointer(ALSO_ON_PICTURE, root));
    // The move that leaves a provisional document behind. Without it there would be
    // nothing to strand and this test would pass on a stage that did nothing at all.
    expect(phases()).toEqual(['move']);

    root.fire('pointerup', pointer(ON_LETTERBOX, root));

    // No `'end'` is dispatched, because a point on the letterbox has no source
    // coordinate to move the mask to — that refusal is deliberate. What is required is
    // that the gesture still *ends*.
    expect(phases()).toEqual(['move']);
    expect(callbacks.onCancelGesture).toHaveBeenCalledTimes(1);
  });

  it('and the same for a gesture the platform takes away', () => {
    root.fire('pointerdown', pointer(ON_PICTURE, frame()));
    root.fire('pointermove', pointer(ALSO_ON_PICTURE, root));
    root.fire('pointercancel', pointer(ON_LETTERBOX, root));
    expect(callbacks.onCancelGesture).toHaveBeenCalledTimes(1);
  });
});

describe('the controls that keep that from passing vacuously', () => {
  it('commits — and does NOT cancel — when the same drag ends on the picture', () => {
    root.fire('pointerdown', pointer(ON_PICTURE, frame()));
    root.fire('pointermove', pointer(ALSO_ON_PICTURE, root));
    root.fire('pointerup', pointer(ALSO_ON_PICTURE, root));

    expect(phases()).toEqual(['move', 'end']);
    expect(callbacks.onCancelGesture).not.toHaveBeenCalled();
  });

  it('ends a gesture exactly once, so a release cannot both commit and cancel', () => {
    root.fire('pointerdown', pointer(ON_PICTURE, frame()));
    root.fire('pointerup', pointer(ALSO_ON_PICTURE, root));
    // A second release with no drag under it is not a gesture and must produce nothing.
    root.fire('pointerup', pointer(ON_LETTERBOX, root));
    expect(phases()).toEqual(['end']);
    expect(callbacks.onCancelGesture).not.toHaveBeenCalled();
  });

  it('never began a gesture at all when the press itself was on the letterbox', () => {
    // A press on the background deselects; nothing provisional exists, so the release
    // has nothing to cancel and must not report one.
    root.fire('pointerdown', pointer(ON_LETTERBOX, root));
    root.fire('pointerup', pointer(ON_LETTERBOX, root));
    expect(callbacks.onPick).toHaveBeenCalledWith(null);
    expect(callbacks.onCancelGesture).not.toHaveBeenCalled();
  });
});
