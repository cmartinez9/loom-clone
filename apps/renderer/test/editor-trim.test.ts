/**
 * The pure halves of the editor's timeline: what a trim means, where a second lands
 * on screen, and what the ruler writes beside a tick.
 *
 * All three are wrong in ways nobody can see by looking at the window — a handle
 * that stops one pixel early, a ruler whose ticks drift off their labels, a timecode
 * that only disagrees with the one next to it past an hour — so they are separated
 * from the DOM and pinned here. `rulerLabel` is imported from `timeline.ts` rather
 * than copied: it is the label the window actually draws, and the point of testing it
 * is that it agrees with `@loom/design`.
 */

import { describe, expect, it } from 'vitest';
import { formatTimecode, formatTimecodeCentis } from '@loom/design';
import { newEditDocument, type EditDocument } from '@loom/format';
import { MIN_TRIM_SEC, moveHandle, readTrim, trimOp } from '../src/editor/trim.ts';
import { rulerLabel } from '../src/editor/timeline.ts';
import {
  clampZoom,
  scrollSecOf,
  ticks,
  timeOf,
  visibleSpanSec,
  xOf,
  zoomAbout,
  type TimelineView,
} from '../src/editor/timeline-geometry.ts';

const DURATION = 240;

function docWith(clips: EditDocument['clips']): EditDocument {
  return { ...newEditDocument(), clips };
}

function view(overrides: Partial<TimelineView> = {}): TimelineView {
  return { durationSec: DURATION, zoom: 1, scrollSec: 0, widthPx: 1000, ...overrides };
}

describe('what the document says the trim is', () => {
  it('reads an empty clip list as the whole recording, not as nothing', () => {
    // `compileClips` reads it that way, `newEditDocument` documents it that way,
    // and drawing the handles at 0/0 for a fresh recording would put both of them
    // on top of each other at the left edge.
    expect(readTrim(docWith([]), DURATION)).toEqual({ startSec: 0, endSec: DURATION });
  });

  it('reads one clip as its own bounds', () => {
    const doc = docWith([{ id: 'trim', sourceStart: 12, sourceEnd: 100, speed: 1 }]);
    expect(readTrim(doc, DURATION)).toEqual({ startSec: 12, endSec: 100 });
  });

  it('reads several clips as their outer bounds', () => {
    const doc = docWith([
      { id: 'b', sourceStart: 90, sourceEnd: 120, speed: 1 },
      { id: 'a', sourceStart: 10, sourceEnd: 20, speed: 1 },
    ]);
    expect(readTrim(doc, DURATION)).toEqual({ startSec: 10, endSec: 120 });
  });

  it('ignores a clip the model would drop anyway', () => {
    const doc = docWith([
      { id: 'zero', sourceStart: 5, sourceEnd: 5, speed: 1 },
      { id: 'real', sourceStart: 10, sourceEnd: 20, speed: 1 },
    ]);
    expect(readTrim(doc, DURATION)).toEqual({ startSec: 10, endSec: 20 });
  });
});

describe('moving a handle', () => {
  const trim = { startSec: 20, endSec: 100 };

  it('clamps into the recording at both ends', () => {
    expect(moveHandle(trim, 'start', -50, DURATION).startSec).toBe(0);
    expect(moveHandle(trim, 'end', DURATION + 50, DURATION).endSec).toBe(DURATION);
  });

  it('stops short of the other handle rather than pushing it', () => {
    // Pushing is what makes a fast drag past the far end silently discard the
    // whole recording; stopping leaves both handles where a person can find them.
    const pushed = moveHandle(trim, 'start', 500, DURATION);
    expect(pushed.startSec).toBeCloseTo(100 - MIN_TRIM_SEC, 12);
    expect(pushed.endSec).toBe(100);

    const pulled = moveHandle(trim, 'end', -500, DURATION);
    expect(pulled.startSec).toBe(20);
    expect(pulled.endSec).toBeCloseTo(20 + MIN_TRIM_SEC, 12);
  });

  it('never leaves a clip the document validator would refuse', () => {
    for (const to of [-10, 0, 19.999, 20, 100, 100.5, 1e9]) {
      for (const which of ['start', 'end'] as const) {
        const moved = moveHandle(trim, which, to, DURATION);
        expect(moved.endSec - moved.startSec, `${which} -> ${String(to)}`).toBeGreaterThanOrEqual(
          MIN_TRIM_SEC - 1e-9,
        );
      }
    }
  });
});

describe('the op a trim sends', () => {
  it('is null when nothing moved, so a drag that went nowhere is not an edit', () => {
    const doc = docWith([{ id: 'trim', sourceStart: 12, sourceEnd: 100, speed: 1 }]);
    expect(trimOp(doc, { startSec: 12, endSec: 100 })).toBeNull();
  });

  it('is one clips.set with one clip at speed 1', () => {
    const op = trimOp(docWith([]), { startSec: 3, endSec: 9 });
    expect(op).toEqual({
      op: 'clips.set',
      clips: [{ id: 'trim', sourceStart: 3, sourceEnd: 9, speed: 1 }],
    });
  });

  it('writes the whole recording out rather than clearing the list', () => {
    // "Empty means the whole source" is a default. Replacing an explicit statement
    // with it loses the difference between untrimmed and trimmed-back-to-full,
    // which is what undoing the first trim has to restore.
    const doc = docWith([{ id: 'trim', sourceStart: 5, sourceEnd: 100, speed: 1 }]);
    const op = trimOp(doc, { startSec: 0, endSec: DURATION });
    expect(op).toEqual({
      op: 'clips.set',
      clips: [{ id: 'trim', sourceStart: 0, sourceEnd: DURATION, speed: 1 }],
    });
  });

  it('keeps the existing clip id, so a trim is an edit of one clip and not a new one', () => {
    const doc = docWith([{ id: 'whatever', sourceStart: 5, sourceEnd: 100, speed: 1 }]);
    const op = trimOp(doc, { startSec: 6, endSec: 100 });
    expect(op).not.toBeNull();
    if (op?.op !== 'clips.set') throw new Error('expected a clips.set');
    expect(op.clips[0]?.id).toBe('whatever');
  });
});

describe('seconds to pixels and back', () => {
  it('round-trips at every zoom and scroll', () => {
    for (const zoom of [1, 2.5, 17, 480]) {
      for (const scrollSec of [0, 30, 239]) {
        const v = view({ zoom, scrollSec });
        for (const x of [0, 1, 250, 999.5, 1000]) {
          const back = xOf(v, timeOf(v, x));
          // `timeOf` clamps into the recording, so a pixel naming a time past the
          // end round-trips to the end rather than to itself. Everything inside is
          // exact to floating point.
          const clamped = timeOf(v, x) > 0 && timeOf(v, x) < v.durationSec;
          if (clamped) expect(Math.abs(back - x)).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('never scrolls past the end of the recording', () => {
    const v = view({ zoom: 4, scrollSec: 1e9 });
    expect(scrollSecOf(v)).toBeCloseTo(DURATION - visibleSpanSec(v), 9);
    expect(scrollSecOf(view({ scrollSec: -50 }))).toBe(0);
  });

  it('holds zoom between the whole recording and half a second of it', () => {
    expect(clampZoom(view(), 0.1)).toBe(1);
    expect(clampZoom(view(), 1e9)).toBe(DURATION / 0.5);
    // The bound is a span rather than a multiple, so it means the same thing on a
    // ten-second recording as on a four-minute one.
    expect(clampZoom(view({ durationSec: 10 }), 1e9)).toBe(20);
  });

  it('keeps the anchored instant under the same pixel when it zooms', () => {
    const before = view({ zoom: 2, scrollSec: 40 });
    const anchor = timeOf(before, 640);
    const after = zoomAbout(before, 9, anchor);
    expect(xOf(after, anchor)).toBeCloseTo(640, 6);
  });

  it('does not run off the left edge when the anchor is near zero', () => {
    const zoomed = zoomAbout(view({ zoom: 1, scrollSec: 0 }), 8, 0.2);
    expect(scrollSecOf(zoomed)).toBeGreaterThanOrEqual(0);
  });

  it('keeps both ends of the recording clear of the clipped edges', () => {
    // The defect `test/editor-gate.test.ts` found by dragging: the lane area is
    // `overflow: hidden`, so a trim handle centred on `x = widthPx` has half of
    // itself — including its hit target — clipped away, and "trim the very end" is
    // a grab that lands on nothing. Both extremes must sit far enough in for an
    // 11 px target to be whole.
    const v = view();
    const half = 11 / 2;
    expect(xOf(v, 0)).toBeGreaterThanOrEqual(half);
    expect(xOf(v, DURATION)).toBeLessThanOrEqual(v.widthPx - half);
  });

  it('reserves the same room at both ends, so the ruler stays centred', () => {
    const v = view();
    expect(xOf(v, 0)).toBeCloseTo(v.widthPx - xOf(v, DURATION), 9);
  });
});

describe('the ruler', () => {
  it('labels ticks far enough apart to read, at every zoom', () => {
    for (const zoom of [1, 3, 20, 200, 480]) {
      const labelled = ticks(view({ zoom })).filter((tick) => tick.major);
      for (let i = 1; i < labelled.length; i++) {
        const gap = (labelled[i]?.x ?? 0) - (labelled[i - 1]?.x ?? 0);
        expect(gap, `zoom ${String(zoom)}`).toBeGreaterThanOrEqual(70);
      }
    }
  });

  it('puts every tick on its own exact multiple, so labels cannot drift', () => {
    // Counted in ladder steps rather than accumulated in seconds: adding 0.1 four
    // hundred times lands at 40.00000000000031.
    for (const tick of ticks(view({ zoom: 400, scrollSec: 40 }))) {
      const times10 = tick.t * 10;
      expect(Math.abs(times10 - Math.round(times10))).toBeLessThan(1e-6);
    }
  });

  it('stays inside the recording and inside the visible span', () => {
    const v = view({ zoom: 6, scrollSec: 100 });
    const span = visibleSpanSec(v);
    for (const tick of ticks(v)) {
      expect(tick.t).toBeGreaterThanOrEqual(scrollSecOf(v) - 1e-9);
      expect(tick.t).toBeLessThanOrEqual(Math.min(scrollSecOf(v) + span, DURATION) + 1e-9);
    }
  });

  it('answers nothing rather than looping when it has no width', () => {
    expect(ticks(view({ widthPx: 0 }))).toEqual([]);
    expect(ticks(view({ durationSec: 0, widthPx: 0 }))).toEqual([]);
  });
});

describe('the ruler’s labels', () => {
  it('rolls over into hours, like every other timecode in the window', () => {
    // Composed by hand this printed `61:01` while the transport readout beside it,
    // two elements away in the same window, printed `1:01:01.00` for the same
    // instant. The ladder's top rung is a 1800 s step, so an hour-plus recording is
    // a length the ruler is expected to draw rather than a hypothetical one.
    expect(rulerLabel(3661)).toBe('1:01:01');
    expect(rulerLabel(3600)).toBe('1:00:00');
  });

  it('is the transport readout’s own timecode, without the hundredths', () => {
    // The binding relationship, stated as one: `#tcode` and `#tl-tc` are
    // `formatTimecodeCentis`, which is `formatTimecode` with a hundredths column
    // after it. A whole-second tick's label is therefore that readout's own prefix,
    // at every length — which is what a second implementation cannot promise.
    for (const t of [0, 15, 90, 599, 3599, 3661, 7322]) {
      expect(rulerLabel(t), `t=${String(t)}`).toBe(formatTimecode(t));
      expect(formatTimecodeCentis(t).startsWith(`${rulerLabel(t)}.`)).toBe(true);
    }
  });

  it('shows a tenth only for a tick that is not on a whole second', () => {
    // The rule is about the tick's own time and knows nothing of `TICK_LADDER`, so
    // it cannot drift from it: 40.0 is `0:40` however far the ruler is zoomed in,
    // and 40.5 is `0:40.5` however far it is zoomed out.
    expect(rulerLabel(40)).toBe('0:40');
    expect(rulerLabel(40.5)).toBe('0:40.5');
    expect(rulerLabel(0.1)).toBe('0:00.1');
    expect(rulerLabel(3661.5)).toBe('1:01:01.5');
  });

  it('labels every tick the ruler actually produces, at every zoom', () => {
    // The whole part of a label is the whole part of the tick's time — no rounding
    // up, because a timecode names an instant you can seek to.
    for (const zoom of [1, 3, 20, 200, 480]) {
      for (const tick of ticks(view({ zoom })).filter((t) => t.major)) {
        const label = rulerLabel(tick.t);
        expect(label.startsWith(formatTimecode(tick.t)), `t=${String(tick.t)}`).toBe(true);
        expect(label, `t=${String(tick.t)}`).toMatch(/^\d+:\d\d(:\d\d)?(\.\d)?$/);
      }
    }
  });
});
