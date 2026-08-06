/**
 * The clip list is the only map between the two domains (§3.1), so the two
 * directions of it have to be each other's inverse — not approximately, and not
 * only for the one clip an editor happens to produce today.
 *
 * `timelineTimeAt` is pinned **against `sourceTimeAt`** rather than against
 * arithmetic written out a second time. Writing the expectation out is how a test
 * ends up agreeing with a defect: both sides would be the same mistake.
 */

import { describe, expect, it } from 'vitest';
import type { Clip } from '@loom/format';
import { clipIndexAt, compileClips, sourceTimeAt, timelineTimeAt } from '../src/clips.ts';

/** Timeline times spread across a compiled list, including both edges. */
function timelineSamples(durationSec: number, count = 97): number[] {
  return Array.from({ length: count }, (_, i) => (i / (count - 1)) * durationSec);
}

describe('timelineTimeAt inverts sourceTimeAt', () => {
  const cases: { name: string; clips: Clip[]; sourceDurationSec: number }[] = [
    {
      name: 'the whole recording, stated explicitly',
      clips: [{ id: 'c', sourceStart: 0, sourceEnd: 12, speed: 1 }],
      sourceDurationSec: 12,
    },
    {
      name: 'a trim off both ends — what phase 14 produces',
      clips: [{ id: 'c', sourceStart: 3.25, sourceEnd: 9.75, speed: 1 }],
      sourceDurationSec: 12,
    },
    {
      name: 'an empty list, which means the recording as captured',
      clips: [],
      sourceDurationSec: 12,
    },
    {
      name: 'three clips at three speeds, out of source order',
      clips: [
        { id: 'a', sourceStart: 8, sourceEnd: 10, speed: 2 },
        { id: 'b', sourceStart: 1, sourceEnd: 4, speed: 0.5 },
        { id: 'c', sourceStart: 5, sourceEnd: 6, speed: 1 },
      ],
      sourceDurationSec: 12,
    },
  ];

  for (const { name, clips: input, sourceDurationSec } of cases) {
    it(name, () => {
      const clips = compileClips(input, sourceDurationSec);
      expect(clips.durationSec).toBeGreaterThan(0);

      for (const t of timelineSamples(clips.durationSec)) {
        const source = sourceTimeAt(clips, clipIndexAt(clips, t), t);
        const back = timelineTimeAt(clips, source);
        expect(back, `source ${String(source)} came from timeline ${String(t)}`).not.toBeNull();
        // Not exact, and it cannot be: a round trip through `sourceStart + (t -
        // start) * speed` and back divides by the same speed it multiplied by.
        // A microsecond is four orders below one frame at 30 fps.
        expect(Math.abs((back ?? 0) - t)).toBeLessThan(1e-6);
      }
    });
  }
});

describe('a source instant the output does not contain', () => {
  const clips = compileClips([{ id: 'c', sourceStart: 3, sourceEnd: 9, speed: 1 }], 12);

  it('is null before the trim and after it', () => {
    expect(timelineTimeAt(clips, 2.999)).toBeNull();
    expect(timelineTimeAt(clips, 9.001)).toBeNull();
    expect(timelineTimeAt(clips, 12)).toBeNull();
  });

  it('is answered exactly on both cut points, which are in the output', () => {
    expect(timelineTimeAt(clips, 3)).toBeCloseTo(0, 12);
    expect(timelineTimeAt(clips, 9)).toBeCloseTo(6, 12);
  });

  it('is null in the hole between two clips that skip material', () => {
    const gapped = compileClips(
      [
        { id: 'a', sourceStart: 0, sourceEnd: 2, speed: 1 },
        { id: 'b', sourceStart: 8, sourceEnd: 10, speed: 1 },
      ],
      12,
    );
    expect(timelineTimeAt(gapped, 5)).toBeNull();
    expect(timelineTimeAt(gapped, 1)).toBeCloseTo(1, 12);
    expect(timelineTimeAt(gapped, 9)).toBeCloseTo(3, 12);
  });

  it('answers the FIRST occurrence when material is used twice', () => {
    // Stability under editing, which the docstring argues for: adding a later clip
    // over the same material must not move the answer for the earlier one.
    const twice = compileClips(
      [
        { id: 'a', sourceStart: 0, sourceEnd: 2, speed: 1 },
        { id: 'b', sourceStart: 0, sourceEnd: 2, speed: 1 },
      ],
      12,
    );
    expect(timelineTimeAt(twice, 1)).toBeCloseTo(1, 12);
  });
});
