/**
 * The hostile cursor and click fixtures. §6.6, and §8's phase-10 gate.
 *
 * > These same assertions are unit tests over fixture cursor logs — including a
 * > hostile one (teleports, NaNs, duplicated timestamps, zero-length recordings),
 * > which is a test Cap has and which is worth copying (`zoom_spring.rs:1212`).
 *
 * Each fixture names one way a log can be wrong, and the four §6.6 lists are all here
 * plus the ones the format makes possible: a log that is entirely non-finite, a single
 * sample, time that runs backwards, positions off the recorded display (a second
 * monitor), a cursor that never moves at all, and clicks that arrive out of order or
 * outside the frame.
 *
 * **The bar is "does not crash", and it is a bar with a shape.** A generator that
 * returned a track full of `NaN` would not crash here either — and would then be
 * refused by `validateEditDocument` on the way to disk, leaving a recording that does
 * not open. So `phase10-gate.test.ts` asserts the whole postcondition: no throw, every
 * keyframe finite and strictly ordered, and the document the generator produced
 * validates.
 */

import {
  arrayClickStream,
  arrayCursorStream,
  type ClickEventInput,
  type ClickEventStream,
  type CursorEventStream,
  type CursorSampleInput,
} from '../src/streams.ts';

export interface HostileFixture {
  name: string;
  what: string;
  cursor: CursorEventStream | null;
  clicks: ClickEventStream | null;
}

const HZ = 120;

function ramp(count: number, at: (i: number) => Partial<CursorSampleInput>): CursorSampleInput[] {
  const out: CursorSampleInput[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ t: i / HZ, x: 0.5, y: 0.5, c: 'arrow', ...at(i) });
  }
  return out;
}

export function hostileFixtures(): HostileFixture[] {
  const fixtures: HostileFixture[] = [];
  const add = (
    name: string,
    what: string,
    samples: CursorSampleInput[] | null,
    clicks: ClickEventInput[] | null = null,
  ): void => {
    fixtures.push({
      name,
      what,
      cursor: samples === null ? null : arrayCursorStream(samples),
      clicks: clicks === null ? null : arrayClickStream(clicks),
    });
  };

  add('no-cursor-stream', 'the recording has no cursor log at all', null);
  add('zero-length', 'a log with no samples in it', []);
  add('single-sample', 'one sample: no interval to take a derivative over', [
    { t: 0, x: 0.5, y: 0.5, c: 'arrow' },
  ]);

  add(
    'all-nan',
    'every field non-finite — nothing survives the sanity pass',
    ramp(200, (i) => ({
      t: i % 3 === 0 ? Number.NaN : Number.POSITIVE_INFINITY,
      x: Number.NaN,
      y: -Number.NaN,
    })),
  );

  add(
    'nan-scattered',
    'one sample in five is NaN, in a log that is otherwise ordinary',
    ramp(600, (i) => ({
      x: i % 5 === 0 ? Number.NaN : 0.2 + 0.6 * ((i % 240) / 240),
      y: i % 7 === 0 ? Number.POSITIVE_INFINITY : 0.5,
    })),
  );

  add(
    'duplicated-timestamps',
    'every timestamp appears twice — a doubled append, or a clock that stood still',
    ramp(600, (i) => ({ t: Math.floor(i / 2) / HZ, x: 0.2 + 0.6 * ((i % 240) / 240) })),
  );

  add(
    'time-runs-backwards',
    'the second half of the log is timestamped before the first',
    ramp(600, (i) => ({ t: (i < 300 ? i : 600 - i) / HZ, x: 0.3 + 0.4 * ((i % 120) / 120) })),
  );

  add(
    'teleports',
    'full-frame jumps every eighth of a second — a display change, or a warp',
    ramp(1200, (i) => ({
      x: (i >> 4) % 2 === 0 ? 0.02 : 0.98,
      y: (i >> 5) % 2 === 0 ? 0.02 : 0.98,
    })),
  );

  add(
    'off-display',
    'positions far outside [0,1] — the cursor is on a second monitor',
    ramp(600, (i) => ({ x: -3 + 0.01 * i, y: 4.5 - 0.004 * i })),
  );

  add(
    'never-moves',
    'a perfectly still cursor: the travel-ratio denominator is zero',
    ramp(1200, () => ({ x: 0.4, y: 0.6 })),
  );

  add(
    'one-pixel-jitter',
    'a hand resting on the mouse and nothing else — everything §6.1 should remove',
    ramp(2400, (i) => ({
      x: 0.5 + ((i % 2 === 0 ? 1 : -1) * 1) / 1728,
      y: 0.5 + ((i % 3 === 0 ? 1 : -1) * 1) / 1117,
    })),
  );

  add(
    'shape-flicker',
    'the cursor image changes every 60 ms for the whole recording',
    ramp(1200, (i) => ({ c: ['arrow', 'ibeam', 'pointinghand'][((i / 8) | 0) % 3] ?? 'arrow' })),
  );

  add(
    'enormous-timestamps',
    'a log whose clock never had its origin subtracted — machine uptime, in seconds',
    ramp(600, (i) => ({ t: 2_678_930 + i / HZ, x: 0.3 + 0.4 * ((i % 240) / 240) })),
  );

  // ---- clicks -------------------------------------------------------------
  const ordinaryCursor = ramp(1200, (i) => ({ x: 0.3 + 0.4 * ((i % 240) / 240) }));

  add('clicks-empty', 'a live tap that saw nothing', ordinaryCursor, []);
  add(
    'clicks-nan',
    'clicks with non-finite positions and times',
    ordinaryCursor,
    Array.from({ length: 40 }, (_, i) => ({
      t: i % 4 === 0 ? Number.NaN : i * 0.2,
      e: i % 2 === 0 ? ('down' as const) : ('up' as const),
      b: 0,
      x: i % 3 === 0 ? Number.POSITIVE_INFINITY : 0.5,
      y: Number.NaN,
    })),
  );
  add(
    'clicks-out-of-order',
    'clicks whose timestamps decrease',
    ordinaryCursor,
    Array.from({ length: 40 }, (_, i) => ({
      t: (40 - i) * 0.2,
      e: 'down' as const,
      b: 0,
      x: 0.5,
      y: 0.5,
    })),
  );
  add(
    'clicks-all-at-once',
    'two hundred clicks inside one 8 ms grid step',
    ordinaryCursor,
    Array.from({ length: 200 }, (_, i) => ({
      t: 1 + i * 1e-6,
      e: 'down' as const,
      b: 0,
      x: 0.1 + (i % 9) * 0.1,
      y: 0.1 + (i % 7) * 0.12,
    })),
  );
  add(
    'clicks-off-display',
    'clicks at positions outside the recorded display',
    ordinaryCursor,
    Array.from({ length: 30 }, (_, i) => ({
      t: i * 0.4,
      e: 'down' as const,
      b: 0,
      x: -2 + i * 0.2,
      y: 3.5,
    })),
  );
  add(
    'clicks-before-zero',
    'clicks timestamped before the recording started, so the pre-roll goes negative',
    ordinaryCursor,
    Array.from({ length: 12 }, (_, i) => ({
      t: -0.4 + i * 0.05,
      e: 'down' as const,
      b: 0,
      x: 0.5,
      y: 0.5,
    })),
  );

  return fixtures;
}
