/**
 * `InputSampler` against a scripted helper.
 *
 * The revoked path — the phase-5 gate — is tested against the real binary in
 * `accessibility-revoked.test.ts`. This file covers what that machine cannot
 * produce: a live tap, real clicks, and a tap that dies partway through a recording.
 * `fixtures/fake-sampler.mjs` explains why that split exists.
 *
 * The sink here is in memory, so the assertions are about the bytes the sampler
 * *produces*; `accessibility-revoked.test.ts` asserts the same bytes land in a real
 * bundle through `ProjectStore`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CursorIndexDoc, EventLogKind } from '@loom/format';
import { InputSampler } from '../src/sampler.ts';
import type { EventLogSink } from '../src/sink.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-sampler.mjs');

/**
 * An in-memory `EventLogSink` that records the same distinction the disk does:
 * a log that was created but never appended to is present-and-empty, and a log that
 * was never created is absent.
 */
class MemorySink implements EventLogSink {
  readonly logs = new Map<EventLogKind, string>();
  cursorIndex: CursorIndexDoc | null = null;
  readonly images = new Map<string, Uint8Array>();
  syncs = 0;

  create(log: EventLogKind): Promise<void> {
    if (!this.logs.has(log)) this.logs.set(log, '');
    return Promise.resolve();
  }

  append(log: EventLogKind, ndjson: string): Promise<void> {
    this.logs.set(log, (this.logs.get(log) ?? '') + ndjson);
    return Promise.resolve();
  }

  sync(): Promise<void> {
    this.syncs += 1;
    return Promise.resolve();
  }

  writeCursorImage(sha256: string, png: Uint8Array): Promise<void> {
    this.images.set(sha256, png);
    return Promise.resolve();
  }

  writeCursorIndex(doc: CursorIndexDoc): Promise<void> {
    this.cursorIndex = doc;
    return Promise.resolve();
  }

  lines(log: EventLogKind): Record<string, unknown>[] {
    const text = this.logs.get(log);
    if (text === undefined) return [];
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

async function runScenario(
  scenario: string,
  overrides: { clicks?: boolean } = {},
): Promise<{ sink: MemorySink; sampler: InputSampler }> {
  const previous = process.env['LOOM_FAKE_SCENARIO'];
  process.env['LOOM_FAKE_SCENARIO'] = scenario;
  try {
    const sink = new MemorySink();
    const sampler = new InputSampler({
      sink,
      helperPath: FAKE,
      // The fixture's fixed epoch, so every `t` below is "seconds into the recording".
      t0Us: 1_000_000_000,
      onError: () => undefined,
      ...overrides,
    });
    await sampler.start();
    // The fixture writes everything up front; one turn of the flush timer drains it.
    await new Promise((fulfil) => setTimeout(fulfil, 250));
    await sampler.stop();
    return { sink, sampler };
  } finally {
    if (previous === undefined) delete process.env['LOOM_FAKE_SCENARIO'];
    else process.env['LOOM_FAKE_SCENARIO'] = previous;
  }
}

describe('InputSampler', () => {
  it('creates an empty clicks.ndjson the moment the tap is live', async () => {
    const { sink, sampler } = await runScenario('granted');

    expect(sampler.capability.available).toBe(true);
    expect(sampler.capability.reason).toBeNull();
    expect(sampler.capability.liveThroughout).toBe(true);
    // Zero is the truth here, and it is a *different* truth from the revoked case:
    // the tap was watching and the user did not click.
    expect(sampler.capability.count).toBe(0);
    expect(sampler.health.clicks).toBe(0);

    // Present and empty — "we watched, nothing happened".
    expect(sink.logs.has('clicks')).toBe(true);
    expect(sink.logs.get('clicks')).toBe('');
    expect(sampler.recordingEvents().clicks?.available).toBe(true);
  });

  it('writes clicks in the §2.5 shape, on the recording clock', async () => {
    const { sink, sampler } = await runScenario('clicking');

    expect(sampler.capability.count).toBe(3);
    expect(sink.lines('clicks')).toEqual([
      { t: 1.2043, e: 'down', b: 0, x: 0.6001, y: 0.3312, m: 0 },
      { t: 1.2871, e: 'up', b: 0, x: 0.6001, y: 0.3312, m: 0 },
      // `m: 8` is cmd — a bitfield, not Cap's array of names.
      { t: 4.883, e: 'down', b: 1, x: 0.2214, y: 0.7702, m: 8 },
    ]);
  });

  it('reports a tap that dies mid-recording, and stops calling the log complete', async () => {
    const { sink, sampler } = await runScenario('granted-then-dead');

    // The clicks it did catch are real and on disk...
    expect(sink.lines('clicks')).toHaveLength(1);
    expect(sampler.capability.count).toBe(1);
    // ...but the log is not a faithful record of the recording, so nothing may treat
    // it as one. This is the difference between "one click happened" and "one click
    // was captured before we went blind".
    expect(sampler.capability.available).toBe(false);
    expect(sampler.capability.reason).toBe('tap-disabled-by-timeout');
    expect(sampler.capability.liveThroughout).toBe(false);
    expect(sampler.capability.degradedAtSec).toBeCloseTo(2, 6);
    expect(sampler.recordingEvents().clicks?.available).toBe(false);

    // And the moment it happened is on disk, in the log that still exists.
    const transitions = sink.lines('cursor').filter((line) => line['e'] === 'clicks');
    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.['available']).toBe(true);
    expect(transitions[1]).toMatchObject({
      t: 2,
      e: 'clicks',
      available: false,
      reason: 'tap-disabled-by-timeout',
    });
  });

  it('distinguishes "grant it" from "you granted it, now relaunch"', async () => {
    const { sampler } = await runScenario('needs-restart');

    expect(sampler.capability.available).toBe(false);
    expect(sampler.capability.axTrusted).toBe(true);
    expect(sampler.capability.restartRequired).toBe(true);
    // Never created: the tap was never live, so an empty file would be a lie.
    expect(sampler.capability.count).toBeNull();
  });

  it('surfaces dropped lines rather than absorbing them', async () => {
    const { sampler } = await runScenario('dropping');
    expect(sampler.health.dropped).toBe(41);
  });

  it('records a display reconfiguration into the cursor log', async () => {
    const { sink, sampler } = await runScenario('reconfigure');

    const reconfigure = sink.lines('cursor').filter((line) => line['e'] === 'display');
    expect(reconfigure).toHaveLength(2);
    expect(reconfigure[1]).toEqual({
      t: 12.771,
      e: 'display',
      display: 1,
      logicalSize: [1512, 982],
      scaleFactor: 2,
    });
    expect(sampler.displayInfo?.logicalSize).toEqual([1512, 982]);
  });

  it('survives a helper that dies, and says so instead of reporting zeros', async () => {
    const { sink, sampler } = await runScenario('crash');

    expect(sampler.capability.available).toBe(false);
    expect(sampler.capability.reason).toBe('helper-failed');
    expect(sampler.capability.count).toBeNull();
    expect(sampler.health.clicks).toBeNull();
    expect(sampler.recordingEvents().clicks?.available).toBe(false);

    // A helper that goes away is a click-availability transition like any other, so
    // it lands in `cursor.ndjson` too. A capability that lives only in memory is
    // gone by the time anyone reads the recording.
    const transitions = sink.lines('cursor').filter((line) => line['e'] === 'clicks');
    expect(transitions.at(-1)).toMatchObject({ available: false, reason: 'helper-failed' });
  });

  it('marks when a live tap stopped being trustworthy if the helper dies', async () => {
    const { sink, sampler } = await runScenario('granted-then-crash');

    // The clicks it caught are real; the log stops being a faithful record at the
    // moment the helper went, and that moment is both in memory and on disk.
    expect(sampler.capability.count).toBe(1);
    expect(sampler.capability.reason).toBe('helper-failed');
    expect(sampler.capability.liveThroughout).toBe(false);
    expect(sampler.capability.degradedAtSec).toBeCloseTo(2, 6);

    const transitions = sink.lines('cursor').filter((line) => line['e'] === 'clicks');
    expect(transitions).toHaveLength(2);
    expect(transitions[1]).toMatchObject({ t: 2, available: false, reason: 'helper-failed' });
  });

  it('bounds the wait for a helper that spawns and never speaks', async () => {
    const previous = process.env['LOOM_FAKE_SCENARIO'];
    process.env['LOOM_FAKE_SCENARIO'] = 'silent';
    try {
      const sink = new MemorySink();
      const sampler = new InputSampler({
        sink,
        helperPath: FAKE,
        t0Us: 0,
        startTimeoutMs: 200,
        onError: () => undefined,
      });

      // Without a bound this never resolves, and a recording starts by waiting
      // forever on a helper that will never answer.
      const capability = await sampler.start();
      await sampler.stop();

      expect(capability.reason).toBe('helper-failed');
      expect(capability.count).toBeNull();
      expect(sink.logs.has('clicks')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['LOOM_FAKE_SCENARIO'];
      else process.env['LOOM_FAKE_SCENARIO'] = previous;
    }
  });

  it('survives a helper that is not there', async () => {
    const sink = new MemorySink();
    const sampler = new InputSampler({
      sink,
      helperPath: '/nonexistent/loom-input-sampler',
      t0Us: 0,
      onError: () => undefined,
    });

    const capability = await sampler.start();
    await sampler.stop();

    // Not `accessibility-denied`: a missing binary is a packaging fault, and sending
    // phase 2 to prompt for a permission would be the wrong thing to tell the user.
    expect(capability.reason).toBe('helper-missing');
    expect(sink.logs.has('clicks')).toBe(false);
  });

  it('flags a helper speaking a protocol this build does not know', async () => {
    const previous = process.env['LOOM_FAKE_SCENARIO'];
    process.env['LOOM_FAKE_SCENARIO'] = 'future-protocol';
    const problems: string[] = [];
    try {
      const sampler = new InputSampler({
        sink: new MemorySink(),
        helperPath: FAKE,
        t0Us: 0,
        onError: (error) => problems.push(error.message),
      });
      await sampler.start();
      await sampler.stop();
    } finally {
      if (previous === undefined) delete process.env['LOOM_FAKE_SCENARIO'];
      else process.env['LOOM_FAKE_SCENARIO'] = previous;
    }
    expect(problems.join('\n')).toContain('protocol 99');
  });

  it('refuses to start twice', async () => {
    const sampler = new InputSampler({
      sink: new MemorySink(),
      helperPath: '/nonexistent/loom-input-sampler',
      t0Us: 0,
      onError: () => undefined,
    });
    await sampler.start();
    await expect(sampler.start()).rejects.toThrow('already been started');
  });
});
