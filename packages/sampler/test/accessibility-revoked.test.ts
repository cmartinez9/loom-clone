/**
 * **The phase-5 gate.** Architecture report §8, row 5:
 *
 * > Accessibility revoked → `clicks.available: false`, no empty file, no silent zeros.
 *
 * Everything here runs against the real native helper, a real `ProjectStore` and a
 * real `.loomrec` bundle on disk. Nothing about the permission is mocked, because
 * the failure this phase exists to prevent is precisely that the real API reports
 * success and then delivers nothing — a mock of that API would be a mock of the bug.
 *
 * `untrusted.ts` explains how a genuinely untrusted process is obtained and why the
 * test fails rather than skips if it cannot get one. `rate-control.ts` explains why the
 * sampling-rate bounds below are asserted against a timer measured on the machine
 * running them rather than blind.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLE } from '@loom/format';
import { buildNativeSampler } from '../native/build.mjs';
import { InputSampler } from '../src/sampler.ts';
import { probeInput } from '../src/native.ts';
import { ProjectStoreEventSink } from '../../../apps/main/src/input-sampler.ts';
import { ProjectStore } from '../../../apps/main/src/project-store.ts';
import { untrustedHelper, type UntrustedHelper } from './untrusted.ts';
import {
  buildRateControl,
  expectSampleCount,
  expectSampleHz,
  measureCeiling,
} from './rate-control.ts';

/**
 * Long enough for the 120 Hz sampler to produce a decisive number of samples and for
 * the helper's 1 Hz watchdog to have run at least once.
 */
const SAMPLE_WINDOW_MS = 1200;

/** Enough to show sampling still runs when clicks were declined, and no longer. */
const SHORT_WINDOW_MS = 300;

/** What §6.1 specifies, and what both the sampler and its control are asked for. */
const SAMPLE_HZ = 120;

interface Bundle {
  store: ProjectStore;
  id: string;
  dir: string;
  root: string;
}

async function makeBundle(): Promise<Bundle> {
  const root = await mkdtemp(join(tmpdir(), 'loom-p5-'));
  const store = new ProjectStore({
    recordingsRoot: join(root, 'recordings'),
    settingsPath: join(root, 'settings.json'),
    appVersion: '0.0.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
  const { id, paths } = await store.create('Phase 5');
  await store.openProject(id);
  return { store, id, dir: paths.dir, root };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Position samples, which is every line that is not a §2.5 `e` meta event. */
function positionSamples(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => line['e'] === undefined);
}

/**
 * The rate the sampler really delivered, between its first sample and its last — so
 * spawning the helper and starting AppKit, which are not sampling, are not counted
 * against it.
 */
function deliveredHz(samples: Record<string, unknown>[]): number {
  const first = samples.at(0)?.['t'] as number;
  const last = samples.at(-1)?.['t'] as number;
  return (samples.length - 1) / (last - first);
}

describe.skipIf(process.platform !== 'darwin')('phase 5 gate: Accessibility revoked', () => {
  let helper: UntrustedHelper;
  let scratch: string;
  /** The no-op timer the rate bounds below are held against. See `rate-control.ts`. */
  let control: string;

  beforeAll(async () => {
    const built = await buildNativeSampler();
    scratch = await mkdtemp(join(tmpdir(), 'loom-p5-helper-'));
    helper = await untrustedHelper(built, scratch);
    control = await buildRateControl(scratch);
  }, 60_000);

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('probes as untrusted, with a reason and not merely a false', async () => {
    const probe = await probeInput({ helperPath: helper.path });

    expect(probe.helperAvailable).toBe(true);
    expect(probe.clicks.axTrusted).toBe(false);
    expect(probe.clicks.available).toBe(false);
    // The distinction the whole phase turns on: *why* it is unavailable. `null`
    // would mean "clicks are fine", and a bare `false` would send phase 2 to prompt
    // for the wrong thing.
    expect(probe.clicks.reason).toBe('accessibility-denied');
    // The tap is never even built without the grant, so nothing can report success.
    expect(probe.clicks.tapCreated).toBe(false);
    expect(probe.clicks.tapEnabled).toBe(false);
  });

  it('records cursor position, refuses to create clicks.ndjson, and says why', async ({
    annotate,
  }) => {
    const bundle = await makeBundle();
    const sampler = new InputSampler({
      sink: new ProjectStoreEventSink(bundle.store, bundle.id),
      helperPath: helper.path,
      // Recording clocks start at the sampler's own epoch in this test; `t` is then
      // "seconds since we started", which is what the assertions below read.
      t0Us: 0,
      syncMs: 250,
    });

    const capability = await sampler.start();

    // ---- what `start()` promises: the answer is known before the first frame ----
    expect(capability.available).toBe(false);
    expect(capability.reason).toBe('accessibility-denied');
    expect(capability.axTrusted).toBe(false);
    // A grant is not present, so no relaunch would help. Saying otherwise would send
    // the user to restart the app for nothing.
    expect(capability.restartRequired).toBe(false);

    await new Promise((fulfil) => setTimeout(fulfil, SAMPLE_WINDOW_MS));
    await sampler.stop();
    await bundle.store.close(bundle.id);

    // ---- no silent zeros -----------------------------------------------------
    // `null`, never `0`. Phase 10's auto-zoom-on-click must not be able to read
    // "there were no clicks" out of a recording where clicks were never captured.
    expect(sampler.capability.count).toBeNull();
    expect(sampler.health.clicks).toBeNull();
    expect(sampler.capability.liveThroughout).toBe(false);

    // ---- no empty clicks.ndjson ----------------------------------------------
    const clickLog = join(bundle.dir, BUNDLE.clickLog);
    expect(await exists(clickLog)).toBe(false);

    // ---- position still works: it needs no permission and is the launch default -
    const cursorLog = join(bundle.dir, BUNDLE.cursorLog);
    expect(await exists(cursorLog)).toBe(true);
    const lines = readLines(await readFile(cursorLog, 'utf8'));
    const samples = positionSamples(lines);
    expect(sampler.health.samples).toBe(samples.length);

    // 120 Hz, per §6.1. Generous bounds: this asserts the sampler is running at the
    // specified rate, not that a loaded CI box has a real-time scheduler. Both bounds
    // stand as written; what decides whether they are the sampler's to meet is a no-op
    // timer asked for the same rate, measured in this same process tree beside this
    // same run — so "the sampler stopped sampling" and "this machine coalesces every
    // sub-16 ms timer anyone asks it for" can never be mistaken for one another. The
    // sampler is held to that measured ceiling either way: `rate-control.ts`.
    const evidence = {
      what: 'position sampling',
      hz: deliveredHz(samples),
      control: await measureCeiling(control, SAMPLE_HZ),
    };
    for (const shortfall of [
      expectSampleCount({
        ...evidence,
        count: samples.length,
        floor: 60,
        windowMs: SAMPLE_WINDOW_MS,
      }),
      expectSampleHz({ ...evidence, floor: 80 }),
    ]) {
      if (shortfall !== null) await annotate(shortfall, 'warning');
    }
    // No scheduler can push a rate *up*, so the ceiling needs no control.
    expect(evidence.hz).toBeLessThan(160);

    // Timestamps are monotonic and normalized positions are finite numbers.
    let previous = -Infinity;
    for (const sample of samples) {
      const t = sample['t'] as number;
      expect(t).toBeGreaterThanOrEqual(previous);
      previous = t;
      expect(Number.isFinite(sample['x'] as number)).toBe(true);
      expect(Number.isFinite(sample['y'] as number)).toBe(true);
      expect(typeof sample['m']).toBe('number');
    }

    // ---- the refusal is on disk, not only in memory --------------------------
    // It lands in `cursor.ndjson` as a §2.5 `e` event, because the file it is *about*
    // is the one that does not exist.
    const clickState = lines.filter((line) => line['e'] === 'clicks');
    expect(clickState.length).toBeGreaterThanOrEqual(1);
    expect(clickState[0]?.['available']).toBe(false);
    expect(clickState[0]?.['reason']).toBe('accessibility-denied');
    expect(clickState[0]?.['axTrusted']).toBe(false);
    expect(String(clickState[0]?.['note'])).toContain('Accessibility');

    // ---- and in the recording.json fragment ----------------------------------
    const events = sampler.recordingEvents();
    expect(events.clicks?.available).toBe(false);
    // Present, not omitted: `available: false` and an absent `clicks` key mean
    // different things, and the format distinguishes them (§7.3).
    expect(events.clicks?.file).toBe(BUNDLE.clickLog);
    expect(events.clicks?.source).toBe('cgeventtap');
    expect(events.cursor?.sampleCount).toBe(samples.length);
    expect(events.cursor?.hz).toBe(120);

    await rm(bundle.root, { recursive: true, force: true });
  }, 30_000);

  it('captures cursor bitmaps and names them, with no permission at all', async () => {
    const bundle = await makeBundle();
    const sampler = new InputSampler({
      sink: new ProjectStoreEventSink(bundle.store, bundle.id),
      helperPath: helper.path,
      t0Us: 0,
    });
    await sampler.start();
    await new Promise((fulfil) => setTimeout(fulfil, 600));
    await sampler.stop();
    await bundle.store.close(bundle.id);

    // §6.7: the cursor is composited from `cursors/<sha256>.png`, which is the only
    // reason "make the cursor bigger after the fact" works. It needs no permission.
    const index = JSON.parse(
      await readFile(join(bundle.dir, BUNDLE.cursorIndex), 'utf8'),
    ) as Record<string, unknown>;
    const images = index['images'] as Record<string, { file: string; shape: string }>;
    const ids = Object.keys(images);
    expect(ids.length).toBeGreaterThanOrEqual(1);

    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      const png = await readFile(join(bundle.dir, images[id]!.file));
      // PNG magic. The bitmap is a real image, not an empty placeholder.
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(typeof images[id]!.shape).toBe('string');
    }

    // Every sample's `c` resolves through the index — except the first few, before
    // the shape poll has run once.
    const lines = readLines(await readFile(join(bundle.dir, BUNDLE.cursorLog), 'utf8'));
    const named = lines.filter((line) => line['e'] === undefined && line['c'] !== '');
    expect(named.length).toBeGreaterThan(0);
    for (const sample of named) expect(ids).toContain(sample['c']);

    await rm(bundle.root, { recursive: true, force: true });
  }, 30_000);

  it('reports not-requested — not denied — when clicks were never asked for', async ({
    annotate,
  }) => {
    const bundle = await makeBundle();
    const sampler = new InputSampler({
      sink: new ProjectStoreEventSink(bundle.store, bundle.id),
      helperPath: helper.path,
      t0Us: 0,
      clicks: false,
    });

    const capability = await sampler.start();
    await new Promise((fulfil) => setTimeout(fulfil, SHORT_WINDOW_MS));
    await sampler.stop();
    await bundle.store.close(bundle.id);

    // A user who declined Accessibility and a user macOS refused are different
    // people with different next steps, and the log says which.
    expect(capability.reason).toBe('not-requested');
    expect(capability.requested).toBe(false);
    expect(sampler.capability.count).toBeNull();
    expect(await exists(join(bundle.dir, BUNDLE.clickLog))).toBe(false);

    // Declining clicks must not cost position sampling, so the rate is asserted here
    // too — against the same control, over this shorter window.
    const samples = positionSamples(
      readLines(await readFile(join(bundle.dir, BUNDLE.cursorLog), 'utf8')),
    );
    const shortfall = expectSampleCount({
      what: 'position sampling with clicks declined',
      hz: deliveredHz(samples),
      control: await measureCeiling(control, SAMPLE_HZ),
      count: sampler.health.samples,
      floor: 10,
      windowMs: SHORT_WINDOW_MS,
    });
    if (shortfall !== null) await annotate(shortfall, 'warning');

    await rm(bundle.root, { recursive: true, force: true });
  }, 30_000);

  /**
   * **The control's own control.**
   *
   * The two rate assertions above defer their absolute bound to CI on a machine whose
   * timers cannot reach it. That deferral is only honest while it stays unreachable by
   * a sampler that has stopped sampling — otherwise the throttled branch is a way to
   * pass by producing nothing, and the assertions above prove nothing on any developer
   * machine under this task policy. So both branches are exercised here directly, with
   * the two ceilings this has actually been measured against: 25.4 Hz under the policy,
   * 119.9 Hz from an ordinary shell.
   */
  it('CONTROL: a stalled sampler fails, throttled machine or not', () => {
    const throttled = { requestedHz: SAMPLE_HZ, ticks: 34, seconds: 1.337, hz: 25.4 };
    const unthrottled = { requestedHz: SAMPLE_HZ, ticks: 143, seconds: 1.2, hz: 119.9 };
    const stalled = { what: 'a sampler producing almost nothing', hz: 0 };

    // A machine that can deliver 120 Hz never reaches the reporting branch at all:
    // the gate's own numbers are what get asserted, and a slow sampler fails on them.
    expect(() =>
      expectSampleCount({
        ...stalled,
        control: unthrottled,
        count: 3,
        floor: 60,
        windowMs: SAMPLE_WINDOW_MS,
      }),
    ).toThrow(/under the required 60/);
    expect(() => expectSampleHz({ ...stalled, control: unthrottled, floor: 80 })).toThrow(
      /under the required 80/,
    );

    // And a machine that cannot still holds the sampler to the ceiling just measured
    // for it, so no amount of throttling excuses a sampler that has stopped.
    expect(() =>
      expectSampleCount({
        ...stalled,
        control: throttled,
        count: 3,
        floor: 60,
        windowMs: SAMPLE_WINDOW_MS,
      }),
    ).toThrow(/falling behind this machine's own ceiling/);
    expect(() => expectSampleHz({ ...stalled, control: throttled, floor: 80 })).toThrow(
      /falling behind this machine's own ceiling/,
    );

    // Only the sampler that does track that ceiling is reported rather than failed —
    // and it is reported, not silently passed.
    expect(
      expectSampleCount({
        what: 'a sampler riding the ceiling',
        hz: 24,
        control: throttled,
        count: 30,
        floor: 60,
        windowMs: SAMPLE_WINDOW_MS,
      }),
    ).toContain('this environment cannot sustain');
  });
});
