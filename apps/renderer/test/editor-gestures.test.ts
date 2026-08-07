/**
 * The second guard for the four editor-control properties that a GPU can take away.
 *
 * Every one of these was guarded **only** by `test/phase15-gate.test.ts`, which
 * composites and exports. That gate now withholds its export claims when the WebGL
 * context is lost, and `scripts/mutation-check.mjs` classifies a *file* as `no-verdict`
 * only when **every** test in it withheld — so a per-claim withhold left a mutation
 * nothing had judged scored as `SURVIVED`, a hole reported that was never measured. CI
 * run 31148316397 failed that way on `the-zoom-panel-does-not-follow-the-playhead`; run
 * 31150684807 passed only because that host kept its context.
 *
 * `WITHHOLDABLE_GUARDS` prescribes one remedy and this is it: **a second guard that
 * cannot withhold.** None of these four properties needs a frame composited — a panel
 * that does not follow the playhead, a slider that commits on every step, an inspector
 * that rebuilds under its own thumb, a gesture that strands its preview are all
 * decidable from numbers — so this runs in the node environment, on any host, with no
 * GPU, no window and no Electron.
 *
 * **It does not replace the gate.** The gate proves the *wiring* — that a real slider,
 * a real panel and a real pointer reach these decisions — which nothing here can. Both
 * are listed on each mutation, which is the same split `AGENTS.md` describes for seam
 * S4: the pure half holds the arithmetic that is wrong invisibly, the gate holds the
 * wiring.
 */

import { describe, expect, it } from 'vitest';
import type { EditOp } from '@loom/format';
import {
  applyGesture,
  panelIsHeld,
  playheadMoved,
  sliderStep,
  zoomPaintDecision,
  type ZoomReadout,
} from '../src/editor/gestures.ts';

const OPS: EditOp[] = [{ op: 'clips.set', clips: [] }];

function recorder(): {
  io: Parameters<typeof applyGesture>[3];
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    io: {
      preview: () => calls.push('preview'),
      commit: (_ops, label) => calls.push(`commit:${label}`),
      cancel: () => calls.push('cancel'),
    },
  };
}

describe('a two-phase gesture', () => {
  it('previews while it is moving and commits once when it ends', () => {
    const { io, calls } = recorder();
    applyGesture(OPS, 'move', 'Adjust zoom', io);
    applyGesture(OPS, 'move', 'Adjust zoom', io);
    applyGesture(OPS, 'end', 'Adjust zoom', io);
    // One undo step per gesture — the bargain the trim handles already make. Two
    // commits here would be two entries in the history for one drag.
    expect(calls).toEqual(['preview', 'preview', 'commit:Adjust zoom']);
  });

  it('CANCELS on null ops rather than returning — the stranded-preview bug', () => {
    // A gesture that ends where it started: a slider dragged away and back, a keyframe
    // returned to where it was, an annotation dropped where it was picked up. The
    // earlier `move` already left a provisional document and nothing else clears it,
    // so the preview and the inspector go on showing a value that is in no `edit.json`.
    const { io, calls } = recorder();
    applyGesture(OPS, 'move', 'Adjust zoom', io);
    applyGesture(null, 'end', 'Adjust zoom', io);
    expect(calls).toEqual(['preview', 'cancel']);
  });

  it('cancels on null ops mid-gesture too, and never commits them', () => {
    const { io, calls } = recorder();
    applyGesture(null, 'move', 'Adjust zoom', io);
    expect(calls).toEqual(['cancel']);
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false);
  });
});

describe('the Amount slider’s three events', () => {
  it('reports `input` as a MOVE, never an end', () => {
    // The captain's named control. Committing on `input` reaches `Inspector.render`
    // synchronously, whose `replaceChildren` removes the element the pointer is
    // holding — the drag stops after one step — and spends one undo entry per step.
    const step = sliderStep('input', '2.5');
    expect(step.phase).toBe('move');
    expect(step.value).toBe(2.5);
    // Armed before the value is reported, because reporting is what re-renders.
    expect(step.gesture).toBe(true);
  });

  it('reports `change` as an END, and disarms first', () => {
    const step = sliderStep('change', '4');
    expect(step.phase).toBe('end');
    expect(step.value).toBe(4);
    // Disarmed before the commit, so the rebuild that commit causes actually happens.
    expect(step.gesture).toBe(false);
  });

  it('disarms on `blur` without reporting anything', () => {
    // A gesture interrupted by the window going away never gets its `change`, and a
    // guard left armed would freeze the panel for the rest of the session.
    expect(sliderStep('blur', '3')).toEqual({ gesture: false, value: null, phase: null });
  });

  it('drops an unparseable value but still disarms on `change`', () => {
    expect(sliderStep('input', '')).toEqual({ gesture: null, value: null, phase: null });
    expect(sliderStep('change', 'nonsense')).toEqual({
      gesture: false,
      value: null,
      phase: null,
    });
  });
});

function readout(overrides: Partial<ZoomReadout> = {}): ZoomReadout {
  return {
    regionIndex: -1,
    generated: true,
    amount: 2.5,
    centerX: 0.4,
    centerY: 0.45,
    ...overrides,
  };
}

describe('what a repaint of the standing Zoom panel should do', () => {
  it('rebuilds when nothing has been painted yet', () => {
    expect(zoomPaintDecision(null, readout(), false)).toBe('rebuild');
  });

  it('REBUILDS when the button’s presence changes', () => {
    // `generated` is what decides whether *Take manual control* is offered. A `write`
    // here would leave the button in whatever state the last rebuild put it — which is
    // the defect: withheld on exactly the path a person takes to reach it.
    expect(
      zoomPaintDecision(readout({ generated: false }), readout({ generated: true }), false),
    ).toBe('rebuild');
  });

  it('REBUILDS when a different region covers the playhead', () => {
    expect(
      zoomPaintDecision(readout({ regionIndex: -1 }), readout({ regionIndex: 0 }), false),
    ).toBe('rebuild');
  });

  it('only WRITES when the numbers moved and the shape did not', () => {
    // The per-frame case during playback. It must not build DOM: §4.3's first
    // anti-stutter rule is that nothing allocates in the loop.
    expect(zoomPaintDecision(readout({ amount: 2.5 }), readout({ amount: 3.1 }), false)).toBe(
      'write',
    );
    expect(zoomPaintDecision(readout({ centerX: 0.4 }), readout({ centerX: 0.6 }), false)).toBe(
      'write',
    );
  });

  it('does NOTHING when nothing moved', () => {
    expect(zoomPaintDecision(readout(), readout(), false)).toBe('nothing');
  });

  it('does NOTHING while a gesture is live, whatever changed', () => {
    // A rebuild would take away the element the pointer is holding. Asking for one
    // sixty times a second and deliberately ignoring it is worse than being one
    // gesture behind.
    expect(
      zoomPaintDecision(readout({ generated: false }), readout({ generated: true }), true),
    ).toBe('nothing');
    expect(zoomPaintDecision(null, readout(), true)).toBe('nothing');
  });
});

describe('a control mid-gesture owns the panel', () => {
  it('is held while a gesture names itself, and free otherwise', () => {
    // Both `Inspector.render` and `paintZoom` ask this one predicate. They used to
    // carry independent copies of the condition, and breaking one left the other
    // covering for it — the mutation survived the gate while pointing at a line that
    // genuinely mattered.
    expect(panelIsHeld('zoom-amount')).toBe(true);
    expect(panelIsHeld(null)).toBe(false);
  });
});

describe('the panel follows the playhead', () => {
  it('repaints when the playhead moved to a different instant', () => {
    expect(playheadMoved(5, 8.8)).toBe(true);
  });

  it('does not repaint when it is still', () => {
    expect(playheadMoved(5, 5)).toBe(false);
  });

  it('is not inverted', () => {
    // The mutation this exists for flips the comparison, which repaints only while the
    // playhead is STILL. Both directions are asserted, because either one alone passes
    // under the flip.
    expect(playheadMoved(0, 0.033)).toBe(true);
    expect(playheadMoved(0.033, 0.033)).toBe(false);
  });
});
