/**
 * The phase-12 import: `events/drawing.ndjson` → one generated annotation track.
 *
 * Two of §8's three phase-12 sentences are answered here and one is not. *"Deletable
 * in the editor"* is answered, and answered the way the brief requires — through the
 * **existing** §2.7 op vocabulary, with the inverse that undoes it, rather than
 * through a drawing-shaped special case. *"Absent from the raw capture"* is
 * `overlay-content-protection` in `apps/main/src/verify/permissions-harness.ts`,
 * because it is a claim about pixels a screen capture actually contains — which
 * cannot be made in a unit test, and cannot be made at all without the Screen
 * Recording grant. *"Strokes appear live"* is `test/phase12-overlay.test.ts`'s, for
 * the first half of that reason.
 *
 * What this file adds beyond those is the reading a log has to survive: a torn last
 * line, a stroke rubbed out mid-recording, a tap of the pen, and a document that
 * still validates afterwards — because an import that produced an `edit.json` the
 * validator refuses would brick the recording it was supposed to enrich.
 */

import { describe, expect, it } from 'vitest';
import { applyOps, validateEditDocument, type EditDocument, type Track } from '@loom/format';
import {
  DRAWING_SPAN_PREFIX,
  DRAWING_TRACK_ID,
  drawingTrack,
  EditHistory,
  importDrawingLog,
  parseDrawingLog,
  readStrokePoints,
  strokeEndSec,
} from '../src/index.ts';

const GENERATED_AT = '2026-08-05T12:00:00.000Z';

function stroke(
  id: string,
  t: number,
  t1: number,
  p: number[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    e: 'stroke',
    t,
    t1,
    id,
    tool: 'pen',
    color: '#DC3F12',
    w: 0.004,
    p,
    ...extra,
  });
}

/** A short L: two segments, a real corner, and a bounding box with area. */
const L = [0.2, 0.2, 0.2, 0.4, 0.5, 0.4];

function log(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function importOf(ndjson: string, durationSec = 60): Track {
  const track = importDrawingLog(ndjson, { durationSec, generatedAt: GENERATED_AT });
  expect(track, 'the import produced no track').not.toBeNull();
  return track!;
}

describe('parsing events/drawing.ndjson', () => {
  it('reads strokes, erases and clears, in time order', () => {
    const events = parseDrawingLog(
      log(
        // Written in the order the strokes *ended*, which is not the order they
        // started: a long stroke begun first can be finished last.
        stroke('b', 5, 6, L),
        stroke('a', 1, 9, L),
        JSON.stringify({ e: 'erase', t: 12, ids: ['a'] }),
        JSON.stringify({ e: 'clear', t: 20 }),
      ),
    );
    expect(events.map((e) => [e.e, e.t])).toEqual([
      ['stroke', 1],
      ['stroke', 5],
      ['erase', 12],
      ['clear', 20],
    ]);
  });

  it('drops a torn last line instead of throwing', () => {
    // A `SIGKILL` mid-append leaves a fragment of a line. §2.5's whole design is
    // that this costs the tail and nothing else — so the good stroke before it must
    // still arrive.
    const ndjson = `${stroke('a', 1, 2, L)}\n${stroke('b', 3, 4, L).slice(0, 30)}`;
    const events = parseDrawingLog(ndjson);
    expect(events).toHaveLength(1);
    expect(events[0]?.e).toBe('stroke');
  });

  it('refuses a stroke whose numbers are not numbers', () => {
    const bad = JSON.stringify({
      e: 'stroke',
      t: 1,
      t1: 2,
      id: 'a',
      w: 0.004,
      p: [0.1, 'nope', 0.2, 0.3],
    });
    expect(parseDrawingLog(`${bad}\n`)).toHaveLength(0);
  });

  it('refuses a stroke that ends before it began', () => {
    expect(parseDrawingLog(log(stroke('a', 5, 4, L)))).toHaveLength(0);
  });
});

describe('a stroke ends when it is rubbed out', () => {
  it('runs to the end of the recording when nothing removes it', () => {
    const track = importOf(log(stroke('a', 1, 2, L)), 42);
    expect(track.spans?.[0]?.end).toBe(42);
  });

  it('ends at the erase that names it, and not at one that does not', () => {
    const events = parseDrawingLog(
      log(
        stroke('a', 1, 2, L),
        stroke('b', 1, 2, L),
        JSON.stringify({ e: 'erase', t: 10, ids: ['b'] }),
      ),
    );
    const a = events[0];
    const b = events[1];
    if (a?.e !== 'stroke' || b?.e !== 'stroke') throw new Error('parse lost a stroke');
    expect(strokeEndSec(a, events, 60)).toBe(60);
    expect(strokeEndSec(b, events, 60)).toBe(10);
  });

  it('ends at a clear, whichever stroke it is', () => {
    const track = importOf(
      log(stroke('a', 1, 2, L), stroke('b', 3, 4, L), JSON.stringify({ e: 'clear', t: 30 })),
      60,
    );
    expect(track.spans?.map((s) => s.end)).toEqual([30, 30]);
  });

  it('is unaffected by an erase that happened before it was drawn', () => {
    // The overlay reuses no ids, but a log is append-only and replayed forwards:
    // an erase at t=5 says nothing about a stroke begun at t=9.
    const track = importOf(
      log(JSON.stringify({ e: 'erase', t: 5, ids: ['a'] }), stroke('a', 9, 10, L)),
      60,
    );
    expect(track.spans?.[0]?.end).toBe(60);
  });
});

describe('the generated track', () => {
  it('is §3.5 generated, source-anchored, and named so a re-import replaces it', () => {
    const track = importOf(log(stroke('a', 1, 2, L)));
    expect(track.id).toBe(DRAWING_TRACK_ID);
    expect(track.kind).toBe('object');
    expect(track.target).toBe('annotation');
    // §3.2, applied to ink: an annotation is placed on the content, so a trim
    // carries it rather than sliding it.
    expect(track.domain).toBe('source');
    expect(track.origin).toBe('generated');
    expect(track.generator?.type).toBe('live-drawing');
  });

  it('fingerprints the log it was built from, so a stale track is knowable', () => {
    const track = importDrawingLog(log(stroke('a', 1, 2, L)), {
      durationSec: 10,
      generatedAt: GENERATED_AT,
      logHash: 'sha256:41ba',
    });
    expect(track?.generator?.inputs).toEqual({ drawing: 'sha256:41ba' });
  });

  it('is null when nothing was drawn, rather than an empty row in the editor', () => {
    expect(
      importDrawingLog('', { durationSec: 10, generatedAt: GENERATED_AT }),
      'an empty log produced a track',
    ).toBeNull();
    expect(
      importDrawingLog(log(JSON.stringify({ e: 'clear', t: 1 })), {
        durationSec: 10,
        generatedAt: GENERATED_AT,
      }),
    ).toBeNull();
  });

  it('normalizes the points into the span’s own box, so center/size place them', () => {
    const track = importOf(log(stroke('a', 1, 2, L)));
    const span = track.spans?.[0];
    const points = readStrokePoints(span?.style ?? null);
    expect(points).not.toBeNull();
    // The L's bounding box is x 0.2–0.5, y 0.2–0.4 → centre (0.35, 0.3), half
    // (0.15, 0.1). The three points therefore land at the box's corners.
    const center = span?.channels?.['center']?.keys[0]?.v as number[];
    const size = span?.channels?.['size']?.keys[0]?.v as number[];
    expect(center[0]).toBeCloseTo(0.35, 12);
    expect(center[1]).toBeCloseTo(0.3, 12);
    expect(size[0]).toBeCloseTo(0.3, 12);
    expect(size[1]).toBeCloseTo(0.2, 12);
    expect([...(points ?? [])].map((n) => Math.round(n * 100) / 100)).toEqual([
      -1, -1, -1, 1, 1, 1,
    ]);
  });

  it('pads a degenerate axis rather than dividing by zero', () => {
    // A perfectly straight vertical line has no width. The padding is in the
    // document, where it is visible, rather than guarded around in the renderer.
    const track = importOf(log(stroke('a', 1, 2, [0.5, 0.2, 0.5, 0.8])));
    const size = track.spans?.[0]?.channels?.['size']?.keys[0]?.v as number[];
    expect(size[0]).toBeGreaterThan(0);
    const points = readStrokePoints(track.spans?.[0]?.style ?? null);
    expect([...(points ?? [])].every((n) => Number.isFinite(n))).toBe(true);
  });

  it('reveals a stroke over the interval the hand took to draw it', () => {
    const track = importOf(log(stroke('a', 4, 4.75, L)));
    const keys = track.spans?.[0]?.channels?.['progress']?.keys ?? [];
    expect(keys.map((k) => [k.t, k.v])).toEqual([
      [4, 0],
      [4.75, 1],
    ]);
  });

  it('gives a tap of the pen one key, not two at the same instant', () => {
    // Two keys at the same `t` is a validation error (§3.4's sorted, unique `t`),
    // so a dot must not produce one — a document that fails to validate over a tap
    // of the pen would be an import that bricks the recording.
    const track = importOf(log(stroke('a', 4, 4, [0.5, 0.5])));
    expect(track.spans?.[0]?.channels?.['progress']?.keys).toHaveLength(1);
  });

  it('puts a highlighter’s translucency in the document, where it is editable', () => {
    const track = importOf(log(stroke('a', 1, 2, L, { tool: 'highlighter', color: '#C1841A' })));
    expect(track.spans?.[0]?.style?.['stroke']).toBe('#C1841A59');
  });
});

describe('the document it produces', () => {
  function documentWith(track: Track): EditDocument {
    return {
      schema: 'loom.edit/1',
      revision: 1,
      output: { size: [1280, 720], fps: 30, background: { kind: 'none' } },
      clips: [{ id: 'c1', sourceStart: 0, sourceEnd: 60, speed: 1 }],
      tracks: [track],
    };
  }

  it('validates, which an import that bricked a recording would not', () => {
    const doc = documentWith(
      importOf(
        log(
          stroke('a', 1, 2, L),
          stroke('b', 3, 3, [0.5, 0.5]),
          stroke('c', 4, 9, L, { tool: 'highlighter' }),
          JSON.stringify({ e: 'erase', t: 12, ids: ['a'] }),
        ),
      ),
    );
    const result = validateEditDocument(doc);
    expect(
      result.ok,
      result.ok ? '' : result.issues.map((i) => `${i.path}: ${i.message}`).join('\n'),
    ).toBe(true);
  });

  it('keeps a stroke drawn in the last instant of the recording, rather than dropping it', () => {
    // Reachable, not theoretical: `RecorderSession.sourceTimeNowSec()` interpolates
    // past the last frame on purpose — the HUD's timer must stall when the capture
    // stalls, but a stroke stamped at the last frame's time would be most of a
    // second early on an idle desktop where ScreenCaptureKit emits 1.4 fps. So a
    // stroke lands *at* or *after* `durationSec`, its span comes out empty, and the
    // import used to drop it with no diagnostic. The user drew that stroke.
    const track = importOf(
      log(stroke('at-the-end', 60, 60, [0.5, 0.5]), stroke('past', 60.4, 60.9, L)),
      60,
    );
    expect(track.spans).toHaveLength(2);
    for (const span of track.spans ?? []) {
      expect(span.end, `${span.id} came out as an empty span`).toBeGreaterThan(span.start);
    }
  });

  it('and the document those spans are in still validates', () => {
    // The whole postcondition, not merely "it did not throw": a span the validator
    // refuses leaves a recording that stops opening, which is a worse outcome than
    // the silent drop this replaced.
    const doc = documentWith(
      importOf(log(stroke('at-the-end', 60, 60, [0.5, 0.5]), stroke('past', 60.4, 60.9, L)), 60),
    );
    const result = validateEditDocument(doc);
    expect(
      result.ok,
      result.ok ? '' : result.issues.map((i) => `${i.path}: ${i.message}`).join('\n'),
    ).toBe(true);
  });
});

describe('deletable in the editor — §8’s third sentence', () => {
  function documentWith(track: Track): EditDocument {
    return {
      schema: 'loom.edit/1',
      revision: 1,
      output: { size: [1280, 720], fps: 30, background: { kind: 'none' } },
      clips: [{ id: 'c1', sourceStart: 0, sourceEnd: 60, speed: 1 }],
      // A hand-authored track *under* the drawing track, so a removal that took the
      // wrong one, or put the wrong one back, is visible in the order.
      tracks: [
        {
          id: 'trk_manual',
          kind: 'object',
          target: 'annotation',
          domain: 'source',
          origin: 'manual',
          blend: 'replace',
          blendMs: 0,
          activeRanges: [[0, 1e9]],
          enabled: true,
          channels: {},
          spans: [],
        },
        track,
      ],
    };
  }

  it('is removed by an ordinary track.remove, with no drawing-shaped special case', () => {
    const doc = documentWith(importOf(log(stroke('a', 1, 2, L))));
    const next = applyOps(doc, [{ op: 'track.remove', trackId: DRAWING_TRACK_ID }]);
    expect(next.tracks.map((t) => t.id)).toEqual(['trk_manual']);
    expect(validateEditDocument(next).ok).toBe(true);
  });

  it('undoes back into the position it held, because track order is stacking order', () => {
    // Restoring a middle track by appending leaves a valid document and a wrong
    // picture, which is the hardest kind of bug to see. `EditHistory` is the same
    // inverse-op stack an editor uses; nothing here is drawing-specific.
    const doc = documentWith(importOf(log(stroke('a', 1, 2, L))));
    const history = new EditHistory(doc);
    history.apply([{ op: 'track.remove', trackId: DRAWING_TRACK_ID }]);
    expect(history.document.tracks.map((t) => t.id)).toEqual(['trk_manual']);

    const undone = history.undo();
    expect(undone, 'the removal was not undoable').not.toBeNull();
    expect(history.document.tracks.map((t) => t.id)).toEqual(['trk_manual', DRAWING_TRACK_ID]);
    expect(history.document.tracks[1]?.spans?.[0]?.id).toBe(`${DRAWING_SPAN_PREFIX}a`);
    expect(validateEditDocument(history.document).ok).toBe(true);
  });

  it('deletes one stroke at a time with span.remove, which is the same vocabulary', () => {
    const doc = documentWith(importOf(log(stroke('a', 1, 2, L), stroke('b', 3, 4, L))));
    const next = applyOps(doc, [
      { op: 'span.remove', trackId: DRAWING_TRACK_ID, spanId: `${DRAWING_SPAN_PREFIX}a` },
    ]);
    expect(next.tracks[1]?.spans?.map((s) => s.id)).toEqual([`${DRAWING_SPAN_PREFIX}b`]);
  });

  it('CONTROL: removing a track id that is not there fails rather than passing quietly', () => {
    // Without this the two tests above would pass against an `applyOps` that
    // silently ignored every removal.
    const doc = documentWith(importOf(log(stroke('a', 1, 2, L))));
    expect(() => applyOps(doc, [{ op: 'track.remove', trackId: 'trk_absent' }])).toThrow();
  });
});

describe('a re-import rewrites only the generated track (§3.5)', () => {
  it('produces the same track id, so a second import replaces rather than stacks', () => {
    const first = importOf(log(stroke('a', 1, 2, L)));
    const second = importOf(log(stroke('a', 1, 2, L), stroke('b', 5, 6, L)));
    expect(second.id).toBe(first.id);
    expect(second.spans).toHaveLength(2);
  });

  it('honours an explicit track id and activeRanges, so a parked track stays parked', () => {
    const track = drawingTrack(parseDrawingLog(log(stroke('a', 1, 2, L))), {
      durationSec: 60,
      generatedAt: GENERATED_AT,
      trackId: 'trk_other',
      // §3.5: an empty `activeRanges` means never active. A parked track has no
      // opinion — the rule the mute and annotation fixes both restored.
      activeRanges: [],
    });
    expect(track?.id).toBe('trk_other');
    expect(track?.activeRanges).toEqual([]);
  });
});
