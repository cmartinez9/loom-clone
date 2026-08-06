/**
 * The control for §6.6 — a deliberately jittery generator that the same assertions
 * must **fail**.
 *
 * `packages/format/test/kill-mid-write.test.ts` is the pattern and the argument: it
 * kills a *naive* writer beside the real one and requires the naive one to tear, so
 * "no torn file" is a property of `writeAtomic` rather than of the test never having
 * looked. §6.6 needs the same thing. A comfort budget is three inequalities over
 * numbers a generator produced; if the generator could not have produced numbers that
 * break them, the check is decoration and it would keep passing after the dead zone,
 * the spring or the phase lead were deleted.
 *
 * ## What is jittery about it, and what is not
 *
 * This is not a random-number generator and it is not a strawman: it is the *same*
 * cursor log, followed **without §6.2's dead zone and without §6.3's spring** — the
 * naive "point the camera at the cursor" that §6.2's first sentence describes:
 *
 * > A pure spring-to-cursor follows every wobble, just smoothly. That is what makes
 * > people queasy.
 *
 * So the control isolates exactly the two mechanisms under test. It uses `linear`
 * keys on the same `center` channel, at the same conditioned sample times, with the
 * same frame-safe clamp — so it stays inside the visible range and cannot fail on the
 * technicality that its centre was outside the frame. Everything that differs is a
 * mechanism §6 specifies, and everything that fails is a consequence of removing one.
 *
 * `jitteryDeadZoneOnly` and `jitterySpringOnly` remove one mechanism each, so the test
 * can say which assertion each one is holding up rather than only that both together
 * matter.
 */

import type { Keyframe, Seconds, Track, Vec2 } from '@loom/format';
import { conditionCursor } from '../src/generators/conditioning.ts';
import { clampCentre, followTarget, halfViewport } from '../src/generators/dead-zone.ts';
import { constantFollowGeometry } from '../src/generators/dead-zone.ts';
import { DEFAULT_SPRING } from '../src/tracks.ts';
import type { CursorEventStream } from '../src/streams.ts';

export interface ControlInput {
  cursor: CursorEventStream | null;
  zoomAmount: number;
  trackId?: string;
  /** Keep §6.2's dead zone. Off by default — that is the mechanism being removed. */
  deadZone?: boolean;
  /** Keep §6.3's spring. Off by default. */
  spring?: boolean;
}

function centreKeys(input: ControlInput): Keyframe<Vec2>[] {
  const cursor = conditionCursor(input.cursor);
  const geometry = constantFollowGeometry(input.zoomAmount);
  const half = halfViewport(input.zoomAmount);
  const keys: Keyframe<Vec2>[] = [];
  const ease: Keyframe['ease'] = input.spring === true ? { kind: 'spring' } : { kind: 'linear' };

  if (input.deadZone === true) {
    const target = followTarget(cursor, { restBox: [0.35, 0.45], geometry });
    for (let i = 0; i < target.count; i++) {
      pushKey(keys, {
        t: target.t[i] ?? 0,
        v: [clampCentre(target.x[i] ?? 0.5, half), clampCentre(target.y[i] ?? 0.5, half)],
        ease,
      });
    }
    return keys;
  }

  for (let i = 0; i < cursor.count; i++) {
    pushKey(keys, {
      t: cursor.t[i] ?? 0,
      // Clamped exactly as the real generator clamps, so the control fails on motion
      // and never on `sourceSampleRect` quietly absorbing an illegal centre.
      v: [clampCentre(cursor.x[i] ?? 0.5, half), clampCentre(cursor.y[i] ?? 0.5, half)],
      ease,
    });
  }
  return keys;
}

function pushKey(keys: Keyframe<Vec2>[], key: Keyframe<Vec2>): void {
  const previous = keys[keys.length - 1];
  if (previous !== undefined && !(key.t > previous.t)) {
    previous.v = key.v;
    return;
  }
  keys.push(key);
}

/**
 * The naive follow: the camera *is* the cursor, and every wobble is a camera move.
 *
 * `origin: 'generated'` and a `cursor-follow` generator block, because it must be the
 * same *kind* of thing as the real output — a control that the model treated
 * differently would prove nothing about the model.
 */
export function jitteryFollowTrack(input: ControlInput): Track {
  const keys = centreKeys(input);
  const spring = input.spring === true ? { spring: { ...DEFAULT_SPRING } } : {};
  return {
    id: input.trackId ?? 't-zoom-jittery-control',
    kind: 'transform',
    target: 'zoom',
    domain: 'source',
    origin: 'generated',
    generator: {
      type: 'cursor-follow',
      params: {
        control: 1,
        deadZone: input.deadZone === true ? 1 : 0,
        spring: input.spring === true ? 1 : 0,
      },
      inputs: {},
      generatedAt: '2026-08-05T00:00:00.000Z',
    },
    blend: 'replace',
    blendMs: 0,
    // From zero, exactly like the real generator's range — **not** from the first key.
    // A range that opens at the first sample puts the window's 0→1 step one grid point
    // before the first value, and the measurement reads that as a 31 UV/s pan in the
    // first 40 ms of every recording. The control would then "fail" on its own leading
    // edge on any input at all, including a perfect camera, which is the same
    // decoration this file exists to prevent, arriving from the other side.
    activeRanges: keys.length > 0 ? [[0, keys[keys.length - 1]?.t ?? 0] as [Seconds, Seconds]] : [],
    enabled: true,
    channels: { center: { keys, ...spring } },
  };
}

/** §6.2 kept, §6.3 removed: a dead zone whose target snaps rather than springs. */
export function jitteryDeadZoneOnly(input: ControlInput): Track {
  return jitteryFollowTrack({ ...input, deadZone: true, spring: false });
}

/** §6.3 kept, §6.2 removed: a spring chasing the cursor's exact position. */
export function jitterySpringOnly(input: ControlInput): Track {
  return jitteryFollowTrack({ ...input, deadZone: false, spring: true });
}
