/**
 * **The phase-10 gate.** §8: *"Seasickness budget assertions pass on 10 real
 * recordings; hostile-input fixtures do not crash."*
 *
 * Both halves are here, and so is the control that makes the first half mean
 * something.
 *
 * ## What "10 real recordings" is
 *
 * `packages/edl/test/corpus/` — ten `.loomrec` bundles recorded by
 * `scripts/record-cursor-corpus.mjs` on this machine. Everything below
 * `CGWarpMouseCursorPosition` is the shipping path: the real `loom-input-sampler`
 * polling the window server at 120 Hz, the real `InputSampler` writing §2.5's shapes,
 * the real `createBundle`. `manifest.json` records what moved the mouse — a script by
 * default, since the corpus is recorded unattended, and a person under `--manual` —
 * and this test **asserts there are ten of them and that the manifest says which**, so
 * a corpus quietly reduced to the two easy ones cannot pass.
 *
 * ## Why the control is not optional
 *
 * A comfort budget is three inequalities. If nothing a generator could plausibly
 * produce breaks them, they would keep passing with the dead zone deleted, and the
 * gate would be decoration — the argument `kill-mid-write.test.ts` makes with its naive
 * writer. So `jittery-control.ts` follows the *same ten logs* with §6.2 and §6.3
 * removed, and this test requires that to **fail** on every one of them.
 *
 * ## Numbers are printed even when it passes
 *
 * `phase6-gate.test.ts` does the same, for the same reason: a gate that only speaks
 * when it fails cannot show a margin shrinking.
 */

import { describe, expect, it } from 'vitest';
import { validateEditDocument } from '@loom/format';
import type { Track } from '@loom/format';
import { generateAutoZoom } from '../src/generators/auto-zoom.ts';
import {
  describeSeasickness,
  measurementDocument,
  measureTrack,
  SEASICKNESS_BUDGET,
} from '../src/generators/budget.ts';
import { clickSourceFrom, unavailableClicks } from '../src/generators/clicks.ts';
import { conditionCursor } from '../src/generators/conditioning.ts';
import {
  COMFORT_LADDER,
  DEFAULT_FOLLOW_AMOUNT,
  generateCursorFollow,
} from '../src/generators/cursor-follow.ts';
import {
  constantFollowGeometry,
  followTarget,
  DEFAULT_REST_BOX,
} from '../src/generators/dead-zone.ts';
import { loadCorpus, loadCorpusManifest } from './corpus.ts';
import { hostileFixtures } from './hostile.ts';
import { jitteryDeadZoneOnly, jitteryFollowTrack, jitterySpringOnly } from './jittery-control.ts';

/** Every keyframe finite, strictly ordered, and inside the channel's declared bounds. */
function expectWellFormed(track: Track): void {
  for (const [name, channel] of Object.entries(track.channels)) {
    let previous = Number.NEGATIVE_INFINITY;
    for (const key of channel.keys) {
      expect(Number.isFinite(key.t), `${track.id}.${name} key t`).toBe(true);
      expect(key.t, `${track.id}.${name} keys must be strictly ordered`).toBeGreaterThan(previous);
      previous = key.t;
      const components = Array.isArray(key.v) ? key.v : [key.v];
      for (const value of components) {
        expect(Number.isFinite(value), `${track.id}.${name} key value at t=${key.t}`).toBe(true);
      }
    }
  }
  for (const [start, end] of track.activeRanges) {
    expect(Number.isFinite(start) && Number.isFinite(end)).toBe(true);
    expect(end).toBeGreaterThanOrEqual(start);
  }
  // The postcondition that matters beyond "did not throw": a generated track has to
  // survive the trip to disk, or the recording it was generated into stops opening.
  const result = validateEditDocument(
    measurementDocument([track], Math.max(1, previousEnd(track))),
  );
  expect(result.ok ? [] : result.issues).toEqual([]);
}

function previousEnd(track: Track): number {
  let end = 0;
  for (const range of track.activeRanges) end = Math.max(end, range[1]);
  return end;
}

describe('phase 10 gate — the seasickness budget on ten real recordings', () => {
  it('has ten real recordings, and says whose hand moved the mouse', () => {
    const manifest = loadCorpusManifest();
    expect(manifest.recordings).toHaveLength(10);
    expect(['scripted', 'human']).toContain(manifest.hand);
    // Ten *different* sessions. Ten copies of the calm one would pass a budget and
    // measure nothing.
    expect(new Set(manifest.recordings.map((r) => r.name)).size).toBe(10);
    const paces = new Set(manifest.recordings.map((r) => r.profile?.pace ?? 0));
    expect(paces.size).toBeGreaterThanOrEqual(manifest.hand === 'scripted' ? 8 : 1);
  });

  it('cursor-follow meets §6.6 on all ten', () => {
    const corpus = loadCorpus();
    expect(corpus).toHaveLength(10);

    const lines: string[] = [];
    for (const recording of corpus) {
      const result = generateCursorFollow({
        cursor: recording.cursor,
        durationSec: recording.durationSec,
        inputs: { cursor: `corpus:${recording.entry.name}` },
        generatedAt: '2026-08-05T00:00:00.000Z',
      });
      const rung = result.attempts.length;
      lines.push(
        `  ${recording.entry.name.padEnd(28)} rung ${rung}/${COMFORT_LADDER.length} ` +
          `keys ${String(result.keyCount).padStart(4)}  ${describeSeasickness(result.budget)}`,
      );

      expectWellFormed(result.track);
      expect(result.warning, `${recording.entry.name}: ${result.warning ?? ''}`).toBeNull();
      expect(result.budget.failures, recording.entry.name).toEqual([]);
      expect(result.budget.panSpeedUvPerSec).toBeLessThanOrEqual(
        SEASICKNESS_BUDGET.panSpeedUvPerSec,
      );
      expect(result.budget.panAccelUvPerSec2).toBeLessThanOrEqual(
        SEASICKNESS_BUDGET.panAccelUvPerSec2,
      );
      expect(result.budget.travelRatio).toBeLessThanOrEqual(SEASICKNESS_BUDGET.travelRatio);
      // The budget is only a statement about the camera while the camera is what the
      // metric measured: a centre outside the visible range would be clamped away by
      // `sourceSampleRect` and the reading would be of a picture nobody sees.
      expect(result.budget.sampleCount).toBeGreaterThan(1000);
    }
    console.log(`\n§6.6 on ten real recordings (budget ${JSON.stringify(SEASICKNESS_BUDGET)}):`);
    console.log(lines.join('\n'));
  });

  it('CONTROL: the same ten logs, followed without §6.2 and §6.3, fail the same budget', () => {
    const corpus = loadCorpus();
    const lines: string[] = [];
    let failed = 0;
    for (const recording of corpus) {
      const cursor = conditionCursor(recording.cursor);
      const track = jitteryFollowTrack({
        cursor: recording.cursor,
        zoomAmount: DEFAULT_FOLLOW_AMOUNT,
      });
      const report = measureTrack(
        track,
        recording.durationSec,
        cursor,
        DEFAULT_FOLLOW_AMOUNT,
        SEASICKNESS_BUDGET,
      );
      lines.push(`  ${recording.entry.name.padEnd(28)} ${describeSeasickness(report)}`);
      expect(report.pass, `${recording.entry.name} must FAIL the budget`).toBe(false);
      // …and fail *inside* the recording, on cursor motion, rather than on the first
      // grid step. A control that fails at its own leading edge would fail on a
      // perfect camera too, and would prove nothing about the dead zone or the spring.
      expect(
        report.worstPanSpeedAtSec,
        `${recording.entry.name}: worst speed too early`,
      ).toBeGreaterThan(0.5);
      expect(
        report.worstPanAccelAtSec,
        `${recording.entry.name}: worst accel too early`,
      ).toBeGreaterThan(0.5);
      failed++;
    }
    console.log('\nCONTROL — no dead zone, no spring (must all FAIL):');
    console.log(lines.join('\n'));
    expect(failed).toBe(10);
  });

  it('CONTROL: the dead zone keeps the target still, measured against itself', () => {
    // §6.6's three inequalities are about how *violently* the camera moves. §6.2's own
    // claim is different and stronger — *"while the cursor is inside the rest box, the
    // target does not move at all"* — and the comfort ladder's target speed cap can
    // hold the budget while quietly losing it, because a capped camera is slow whether
    // or not it is still. So this measures the sentence: how many conditioned samples
    // leave the target where it was, with §6.2's box and with no box at all. The
    // recording is its own control and no threshold is invented for the comparison;
    // the one floor is what "still by default" has to mean at minimum.
    const lines: string[] = [];
    for (const recording of loadCorpus()) {
      const cursor = conditionCursor(recording.cursor);
      const geometry = constantFollowGeometry(DEFAULT_FOLLOW_AMOUNT);
      const withBox = followTarget(cursor, { restBox: DEFAULT_REST_BOX, geometry });
      const without = followTarget(cursor, { restBox: [0, 0], geometry });
      // In *time*, not in samples: §6.1 has already collapsed the intervals where the
      // cursor did not move to one sample each, so counting samples would measure the
      // share of the *moves* that the box absorbed rather than the share of the
      // recording the frame was still for — which is the sentence.
      const stillShare = (target: typeof withBox): number => {
        let still = 0;
        let total = 0;
        for (let i = 1; i < target.count; i++) {
          const dt = (target.t[i] ?? 0) - (target.t[i - 1] ?? 0);
          total += dt;
          const moved =
            (target.x[i] ?? 0) !== (target.x[i - 1] ?? 0) ||
            (target.y[i] ?? 0) !== (target.y[i - 1] ?? 0);
          if (!moved) still += dt;
        }
        return total > 0 ? still / total : 0;
      };
      const share = stillShare(withBox);
      const bare = stillShare(without);
      lines.push(
        `  ${recording.entry.name.padEnd(28)} target still for ${(share * 100).toFixed(1)}% of ` +
          `the recording, ${(bare * 100).toFixed(1)}% without a rest box`,
      );
      expect(bare, `${recording.entry.name}: the rest box held nothing`).toBeLessThan(share);
      expect(share, `${recording.entry.name}: the frame is not still by default`).toBeGreaterThan(
        0.5,
      );
    }
    console.log(
      '\nCONTROL — §6.2, the target at rest (must fall to near nothing without the box):',
    );
    console.log(lines.join('\n'));
  });

  it('CONTROL: removing either mechanism alone is enough to fail somewhere', () => {
    const corpus = loadCorpus();
    let deadZoneOnlyFailures = 0;
    let springOnlyFailures = 0;
    for (const recording of corpus) {
      const cursor = conditionCursor(recording.cursor);
      const measure = (track: Track): boolean =>
        measureTrack(track, recording.durationSec, cursor, DEFAULT_FOLLOW_AMOUNT).pass;
      if (
        !measure(
          jitteryDeadZoneOnly({ cursor: recording.cursor, zoomAmount: DEFAULT_FOLLOW_AMOUNT }),
        )
      ) {
        deadZoneOnlyFailures++;
      }
      if (
        !measure(jitterySpringOnly({ cursor: recording.cursor, zoomAmount: DEFAULT_FOLLOW_AMOUNT }))
      ) {
        springOnlyFailures++;
      }
    }
    console.log(
      `\nCONTROL — one mechanism at a time: dead zone without the spring fails ` +
        `${deadZoneOnlyFailures}/10, spring without the dead zone fails ${springOnlyFailures}/10`,
    );
    expect(deadZoneOnlyFailures).toBeGreaterThan(0);
    expect(springOnlyFailures).toBeGreaterThan(0);
  });

  it('auto-zoom runs on the corpus’ real click logs', () => {
    const corpus = loadCorpus();
    const lines: string[] = [];
    let generated = 0;
    let refused = 0;
    let segments = 0;
    let clicks = 0;
    for (const recording of corpus) {
      const source = clickSourceFrom(recording.recording, recording.clicks);
      const result = generateAutoZoom({
        clicks: source,
        cursor: recording.cursor,
        durationSec: recording.durationSec,
        generatedAt: '2026-08-05T00:00:00.000Z',
      });
      if (result.ok) {
        generated++;
        segments += result.segments.length;
        clicks += result.clicks;
        expectWellFormed(result.track);
        expect(result.budget.sampleCount).toBeGreaterThan(0);
        // `activeRanges` is the segment list, and between segments the track below
        // shows through — the whole of §3.5's handover on real data.
        expect(result.track.activeRanges).toHaveLength(result.segments.length);
        lines.push(
          `  ${recording.entry.name.padEnd(28)} ${String(result.clicks).padStart(3)} clicks → ` +
            `${result.segments.length} segments  ${describeSeasickness(result.budget)}`,
        );
      } else {
        refused++;
        // Never an empty track, and never a zero that could be read as "no clicks".
        expect(result.message.length).toBeGreaterThan(20);
        expect(['not-recorded', 'not-captured', 'log-unreadable']).toContain(result.reason);
        lines.push(`  ${recording.entry.name.padEnd(28)} refused: ${result.reason}`);
      }
    }
    console.log(`\nauto-zoom on the corpus (${generated} generated, ${refused} refused):`);
    console.log(lines.join('\n'));
    expect(generated + refused).toBe(10);

    // The corpus was recorded with Accessibility granted, so §6.5 is exercised against
    // real `CGEventTap` output rather than only against the refusal path. If a future
    // corpus is recorded without the grant this fails loudly and names why, instead of
    // quietly reducing the gate to "auto-zoom declines politely ten times".
    const measured = loadCorpusManifest().clickCapture;
    if (measured.measured) {
      expect(refused, 'the manifest says clicks were captured; auto-zoom refused anyway').toBe(0);
      expect(clicks).toBeGreaterThan(50);
      expect(segments).toBeGreaterThan(0);
    } else {
      expect(generated, 'the manifest says clicks were not captured').toBe(0);
    }
  });
});

describe('phase 10 gate — hostile-input fixtures do not crash', () => {
  const fixtures = hostileFixtures();

  it('has a fixture for each of §6.6’s four named hazards', () => {
    const names = fixtures.map((f) => f.name);
    expect(names).toContain('teleports');
    expect(names).toContain('nan-scattered');
    expect(names).toContain('duplicated-timestamps');
    expect(names).toContain('zero-length');
  });

  for (const fixture of fixtures) {
    it(`cursor-follow survives: ${fixture.name} — ${fixture.what}`, () => {
      const result = generateCursorFollow({
        cursor: fixture.cursor,
        generatedAt: '2026-08-05T00:00:00.000Z',
      });
      expectWellFormed(result.track);
      expect(Number.isFinite(result.budget.panSpeedUvPerSec)).toBe(true);
      expect(Number.isFinite(result.budget.panAccelUvPerSec2)).toBe(true);
      expect(Number.isFinite(result.budget.travelRatio)).toBe(true);
      expect(result.attempts.length).toBeGreaterThanOrEqual(1);
    });

    it(`auto-zoom survives: ${fixture.name}`, () => {
      const source =
        fixture.clicks === null
          ? unavailableClicks('not-recorded')
          : ({ kind: 'captured', stream: fixture.clicks } as const);
      const result = generateAutoZoom({
        clicks: source,
        cursor: fixture.cursor,
        generatedAt: '2026-08-05T00:00:00.000Z',
      });
      if (result.ok) expectWellFormed(result.track);
      else expect(result.message.length).toBeGreaterThan(20);
    });
  }
});
