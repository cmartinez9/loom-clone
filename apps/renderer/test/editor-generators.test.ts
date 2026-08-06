/**
 * Running §6's generators from a window: reading the logs, and §3.5's lifecycle.
 *
 * The generators themselves are phase 10's and are measured on ten real recordings by
 * `packages/edl/test/phase10-gate.test.ts`. What is new — and what is tested here — is
 * the *editor's* half:
 *
 *  - **the reading of §2.5's logs**, whose one trap is that a line carrying an `e` is
 *    an event and not a cursor at (0, 0);
 *  - **the three states a generated track can be in** and which button each earns,
 *    with the rule that a **baked** track is never offered a regenerate;
 *  - **where a generated track lands in the stack**, because §3.5 puts it at the
 *    bottom and track order is stacking order.
 *
 * `readEventLogs` takes its `fetch` and its digest as parameters, so this runs with no
 * protocol handler and no `crypto.subtle`; the injected digest is what makes staleness
 * testable at all, since §3.5's fingerprint is a hash comparison.
 */

import { describe, expect, it } from 'vitest';
import {
  applyOps,
  newEditDocument,
  validateEditDocument,
  type EditDocument,
  type RecordingDoc,
} from '@loom/format';
import {
  GENERATOR_TRACK_ID,
  bakeOps,
  generatorStates,
  isRegenerable,
  parseClickLog,
  parseCursorLog,
  readEventLogs,
  runGenerator,
  type EventLogs,
} from '../src/editor/generators.ts';

const DURATION = 20;

/** A `recording.json` that declares both logs, with clicks marked live. */
function recordingWith(options: { clicks: boolean }): RecordingDoc {
  return {
    events: {
      cursor: { file: 'events/cursor.ndjson', hz: 120, sampleCount: 2400 },
      ...(options.clicks
        ? { clicks: { file: 'events/clicks.ndjson', available: true, source: 'cgeventtap' } }
        : {}),
    },
  } as unknown as RecordingDoc;
}

/** A drift across the frame at 120 Hz, as §2.5 would have written it. */
function cursorLog(seconds: number): string {
  const lines: string[] = [];
  const count = Math.round(seconds * 120);
  for (let i = 0; i < count; i++) {
    const t = i / 120;
    lines.push(JSON.stringify({ t, x: 0.15 + (0.7 * i) / count, y: 0.5, c: 'arrow', m: 0 }));
  }
  return `${lines.join('\n')}\n`;
}

function clickLog(times: readonly number[]): string {
  return `${times
    .flatMap((t) => [
      JSON.stringify({ t, e: 'down', b: 0, x: 0.4, y: 0.45, m: 0 }),
      JSON.stringify({ t: t + 0.05, e: 'up', b: 0, x: 0.4, y: 0.45, m: 0 }),
    ])
    .join('\n')}\n`;
}

function reader(files: Record<string, string>): {
  fetchText: (url: string) => Promise<string | null>;
  digest: (text: string) => Promise<string>;
} {
  return {
    fetchText: (url) => {
      const name = Object.keys(files).find((key) => url.endsWith(key));
      return Promise.resolve(name === undefined ? null : (files[name] ?? null));
    },
    // A stand-in for `crypto.subtle`: what §3.5 needs is that the same bytes give the
    // same string and different bytes do not.
    digest: (text) => Promise.resolve(`sha256:${String(text.length)}:${text.slice(0, 8)}`),
  };
}

describe('reading §2.5’s logs', () => {
  it('drops event lines rather than reading them as a cursor at the origin', () => {
    // `{"e":"display"}` has no `x` at all. `packages/edl/test/corpus.ts` states the
    // same rule for the corpus loader; this is the product's copy of it.
    const text = [
      JSON.stringify({ t: 0, x: 0.1, y: 0.2, c: 'arrow' }),
      JSON.stringify({ t: 0.5, e: 'display', display: 1, logicalSize: [1, 1], scaleFactor: 2 }),
      JSON.stringify({ t: 1, x: 0.3, y: 0.4, c: 'ibeam' }),
    ].join('\n');
    const samples = parseCursorLog(text);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.x)).toEqual([0.1, 0.3]);
  });

  it('keeps the rest of a log when one line is malformed', () => {
    // §2.5's logs are streams rather than documents and carry no schema line, so one
    // bad append at a crash boundary must not cost the minutes before it.
    const text = [
      JSON.stringify({ t: 0, x: 0.1, y: 0.2, c: 'arrow' }),
      '{"t":1,"x":',
      JSON.stringify({ t: 2, x: 0.3, y: 0.4, c: 'arrow' }),
    ].join('\n');
    expect(parseCursorLog(text)).toHaveLength(2);
  });

  it('reads only `down`/`up` as click events', () => {
    const text = [
      JSON.stringify({ t: 1, e: 'down', b: 0, x: 0.5, y: 0.5 }),
      JSON.stringify({ t: 1.1, e: 'tapdisabled' }),
      JSON.stringify({ t: 1.2, e: 'up', b: 0, x: 0.5, y: 0.5 }),
    ].join('\n');
    expect(parseClickLog(text).map((c) => c.e)).toEqual(['down', 'up']);
  });

  it('does not read a click log the recording says was never live', () => {
    // Phase 5's whole point: an absent log and an empty one are different states, and
    // `available` is read from the sampler rather than inferred from the file.
    return readEventLogs(
      'r1',
      recordingWith({ clicks: false }),
      reader({ 'cursor.ndjson': cursorLog(2), 'clicks.ndjson': clickLog([1]) }),
    ).then((logs) => {
      expect(logs.clicks).toBeNull();
      expect(logs.cursor).not.toBeNull();
      expect(logs.digests['clicks']).toBeUndefined();
      expect(logs.digests['cursor']).toBeDefined();
    });
  });

  it('does NOT call a recording with no logs trouble — it is the ordinary state', async () => {
    // Every recording made before the sampler was wired in, and every one on a
    // machine that declined Accessibility. Reporting it as trouble puts a warning on
    // an editor where nothing is wrong; which generators can run is said by their own
    // `reason`, in the panel that offers them.
    const logs = await readEventLogs('r1', null, reader({}));
    expect(logs.cursor).toBeNull();
    expect(logs.clicks).toBeNull();
    expect(logs.trouble).toBeNull();
  });

  it('DOES say so when a log the document promised is not there', async () => {
    const logs = await readEventLogs('r1', recordingWith({ clicks: true }), reader({}));
    expect(logs.trouble).toMatch(/cursor and clicks/);
  });
});

async function logsFor(clicks: readonly number[] | null): Promise<EventLogs> {
  return readEventLogs(
    'r1',
    recordingWith({ clicks: clicks !== null }),
    reader({
      'cursor.ndjson': cursorLog(DURATION),
      ...(clicks === null ? {} : { 'clicks.ndjson': clickLog(clicks) }),
    }),
  );
}

function apply(doc: EditDocument, ops: Parameters<typeof applyOps>[1]): EditDocument {
  const next = applyOps(structuredClone(doc), ops);
  const result = validateEditDocument(next);
  expect(result.ok ? [] : result.issues).toEqual([]);
  return next;
}

describe('running a generator from the editor', () => {
  it('produces a track that validates, at the BOTTOM of the stack', async () => {
    const logs = await logsFor(null);
    // A manual zoom is already there, at the top. §3.5 puts a generated cursor-follow
    // track at the bottom, and a `track.add` that appended instead would put the
    // generator over the user's keyframes — a valid document and a wrong picture.
    const withManual: EditDocument = {
      ...newEditDocument(),
      tracks: [{ ...MANUAL_STUB }],
    };
    const run = runGenerator('cursor-follow', withManual, logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: false }),
      generatedAt: '2026-08-06T00:00:00.000Z',
    });
    expect('error' in run).toBe(false);
    if ('error' in run) return;
    const doc = apply(withManual, run.ops);
    expect(doc.tracks.map((t) => t.id)).toEqual([
      GENERATOR_TRACK_ID['cursor-follow'],
      MANUAL_STUB.id,
    ]);
    expect(run.keyCount).toBeGreaterThan(0);
  });

  it('replaces its own track IN PLACE on a second run, keeping the stacking order', async () => {
    const logs = await logsFor(null);
    const withManual: EditDocument = { ...newEditDocument(), tracks: [{ ...MANUAL_STUB }] };
    const first = runGenerator('cursor-follow', withManual, logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: false }),
      generatedAt: '2026-08-06T00:00:00.000Z',
    });
    if ('error' in first) throw new Error(first.error);
    const once = apply(withManual, first.ops);

    const second = runGenerator('cursor-follow', once, logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: false }),
      generatedAt: '2026-08-06T00:00:01.000Z',
    });
    if ('error' in second) throw new Error(second.error);
    expect(second.ops.map((op) => op.op)).toEqual(['track.remove', 'track.add']);
    const twice = apply(once, second.ops);
    expect(twice.tracks.map((t) => t.id)).toEqual(once.tracks.map((t) => t.id));
    // And the user's track is untouched: §3.5's *"user edits survive by construction,
    // because they were never in that track"*.
    expect(twice.tracks.find((t) => t.id === MANUAL_STUB.id)).toEqual(
      once.tracks.find((t) => t.id === MANUAL_STUB.id),
    );
  });

  it('refuses auto-zoom when the tap was never live, with the sentence §6.5 requires', async () => {
    const logs = await logsFor(null);
    const run = runGenerator('auto-zoom-on-click', newEditDocument(), logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: false }),
    });
    expect('error' in run).toBe(true);
    if (!('error' in run)) return;
    expect(run.error).toMatch(/click/i);
  });

  it('says so — rather than silently doing nothing — when nobody clicked', async () => {
    const logs = await readEventLogs(
      'r1',
      recordingWith({ clicks: true }),
      reader({ 'cursor.ndjson': cursorLog(DURATION), 'clicks.ndjson': '' }),
    );
    const run = runGenerator('auto-zoom-on-click', newEditDocument(), logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: true }),
    });
    expect('error' in run).toBe(false);
    if ('error' in run) return;
    expect(run.warning).not.toBeNull();
  });

  it('produces zoom segments from real clicks', async () => {
    const logs = await logsFor([4, 4.4, 12]);
    const run = runGenerator('auto-zoom-on-click', newEditDocument(), logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: true }),
      generatedAt: '2026-08-06T00:00:00.000Z',
    });
    expect('error' in run).toBe(false);
    if ('error' in run) return;
    const doc = apply(newEditDocument(), run.ops);
    const track = doc.tracks[0];
    expect(track?.origin).toBe('generated');
    expect(track?.generator?.type).toBe('auto-zoom-on-click');
    // §6.5 step 1's `clusterGapSec` is 2.6 s, so 4 and 4.4 are one cluster and 12 is
    // its own — two segments, which is the `activeRanges` the track carries.
    expect(track?.activeRanges.length).toBe(2);
  });
});

describe('§3.5’s three states, and which button each earns', () => {
  it('offers Generate for a recording that has never had one', async () => {
    const logs = await logsFor([4]);
    const states = generatorStates(newEditDocument(), logs);
    const auto = states.find((s) => s.type === 'auto-zoom-on-click');
    expect(auto?.track).toBeNull();
    expect(auto?.runnable).toBe(true);
    expect(auto?.baked).toBe(false);
  });

  it('reports a generated track as fresh while its inputs match', async () => {
    const logs = await logsFor([4]);
    const run = runGenerator('auto-zoom-on-click', newEditDocument(), logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: true }),
      generatedAt: '2026-08-06T00:00:00.000Z',
    });
    if ('error' in run) throw new Error(run.error);
    const doc = apply(newEditDocument(), run.ops);
    const auto = generatorStates(doc, logs).find((s) => s.type === 'auto-zoom-on-click');
    expect(auto?.staleness?.stale).toBe(false);
  });

  it('reports it as STALE once the log underneath it changes', async () => {
    const logs = await logsFor([4]);
    const run = runGenerator('auto-zoom-on-click', newEditDocument(), logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: true }),
      generatedAt: '2026-08-06T00:00:00.000Z',
    });
    if ('error' in run) throw new Error(run.error);
    const doc = apply(newEditDocument(), run.ops);
    // §3.5: *"If the cursor log's hash no longer matches, the UI shows 'regenerate'
    // rather than silently serving stale motion."*
    const relogged = await logsFor([4, 9, 14]);
    const auto = generatorStates(doc, relogged).find((s) => s.type === 'auto-zoom-on-click');
    expect(auto?.staleness?.stale).toBe(true);
    expect(auto?.staleness?.changedInputs).toContain('clicks');
  });

  it('bakes to `origin: manual` with the spec kept, and then offers no regenerate', async () => {
    const logs = await logsFor([4]);
    const run = runGenerator('auto-zoom-on-click', newEditDocument(), logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: true }),
      generatedAt: '2026-08-06T00:00:00.000Z',
    });
    if ('error' in run) throw new Error(run.error);
    const doc = apply(newEditDocument(), run.ops);
    const track = doc.tracks[0];
    expect(track).toBeDefined();
    expect(isRegenerable(track!)).toBe(true);

    const baked = apply(doc, bakeOps(track!));
    const after = baked.tracks[0];
    expect(after?.origin).toBe('manual');
    expect(after?.generatedFrom?.type).toBe('auto-zoom-on-click');
    // Removed **by name**, so the undo survives `JSON.stringify` — a key set to
    // `undefined` reaches the journal as `"patch":{}` and replays as a no-op.
    expect(after?.generator).toBeUndefined();
    expect(isRegenerable(after!)).toBe(false);

    const state = generatorStates(baked, logs).find((s) => s.type === 'auto-zoom-on-click');
    expect(state?.baked).toBe(true);
    // A baked track is detached from regeneration (§3.5), so it has no staleness to
    // report — asking would be asking whether a track nobody will rewrite is out of
    // date with the log it no longer reads.
    expect(state?.staleness).toBeNull();
  });

  it('keeps the baked track’s keyframes byte-for-byte', async () => {
    const logs = await logsFor([4]);
    const run = runGenerator('auto-zoom-on-click', newEditDocument(), logs, {
      durationSec: DURATION,
      recording: recordingWith({ clicks: true }),
      generatedAt: '2026-08-06T00:00:00.000Z',
    });
    if ('error' in run) throw new Error(run.error);
    const doc = apply(newEditDocument(), run.ops);
    const baked = apply(doc, bakeOps(doc.tracks[0]!));
    expect(baked.tracks[0]?.channels).toEqual(doc.tracks[0]?.channels);
    expect(baked.tracks[0]?.activeRanges).toEqual(doc.tracks[0]?.activeRanges);
  });
});

/** A hand-authored zoom track, standing in for whatever the user placed first. */
const MANUAL_STUB = {
  id: 't-zoom-manual',
  kind: 'transform' as const,
  target: 'zoom',
  domain: 'source' as const,
  origin: 'manual' as const,
  blend: 'replace' as const,
  blendMs: 300,
  activeRanges: [[2, 6]] as [number, number][],
  enabled: true,
  channels: {
    amount: {
      keys: [
        { t: 2, v: 1, ease: { kind: 'hold' as const } },
        { t: 3, v: 2, ease: { kind: 'hold' as const } },
      ],
    },
  },
};
