/**
 * The fence around phase 15's withheld verdict.
 *
 * `test/golden-verdict.test.ts` is this file's sibling and states the reason: a gate
 * that can decline to judge needs a test that enumerates **every bad-run shape and
 * requires that none of them earns a withhold**. Without it, "no verdict" is one edit
 * away from "no failures", and a gate that never goes red is a gate nobody can trust.
 *
 * The specific hazard here is sharper than phase 8's. Phase 8 withholds when its whole
 * report is empty, which is a hard condition to reach by accident. Phase 15 withholds
 * **per claim**, against a report that still carries the editor's readings — so the
 * predicate has to be exact about which failures are the instrument being taken away
 * and which are the product being wrong. Every case below is a run that must be
 * **JUDGED**, except the two that are the real thing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LOST_SIGNATURE,
  describeWithheld,
  exportInstrumentLost,
  exportReadingsTaken,
  lostTheContext,
} from './editor-controls/verdict.ts';
import type { ControlsReport, ExportReading } from './editor-controls/report.ts';

/** `ExportContextLostError`'s real sentence, as `render-loop.ts` writes it. */
const REAL_CONTEXT_LOST =
  'the WebGL context was lost while compositing output frame 72; the export is refused ' +
  'rather than encoding frames nothing drew (architecture report §10.2). A lost context ' +
  'is silent — every GL call becomes a no-op and the canvas keeps its last contents — so ' +
  'continuing would write a file that passes every §7.5 check and shows nothing.';

/** Where the sentence is actually written. The fence reads it rather than trusting a copy. */
const RENDER_LOOP = fileURLToPath(
  new URL('../apps/renderer/src/export/render-loop.ts', import.meta.url),
);

/**
 * The production source with its string-literal seams closed and its whitespace flat.
 *
 * `CONTEXT_LOST_SIGNATURE` has to be pinned to what the product throws, not to a copy
 * of it — but a template literal is free to be re-wrapped by prettier at any point,
 * including through the middle of the phrase. So adjacent literals are joined and runs
 * of whitespace collapse to one space: the assertion then fails when the sentence is
 * **reworded**, which is what would silently send the gate back to judging every failed
 * export, and never when it is merely reflowed.
 */
function flattenedSource(path: string): string {
  return readFileSync(path, 'utf8')
    .replaceAll(/['`]\s*\+\s*['`]/g, '')
    .replaceAll(/\s+/g, ' ');
}

function anExport(overrides: Partial<ExportReading> = {}): ExportReading {
  return {
    label: 'A-generated',
    ok: false,
    error: REAL_CONTEXT_LOST,
    path: '',
    bytes: 0,
    durationSec: 0,
    verified: false,
    sourcesDeleted: false,
    frames: [],
    ...overrides,
  };
}

/**
 * A report that carries the editor's readings, as every real run does.
 *
 * The editor half is deliberately **non-empty** in every case below, because that is
 * the state the predicate has to be exact about: a run that measured the editor and
 * then lost the GPU must still withhold its *export* claims, and a run that measured
 * the editor and then got a *wrong export answer* must not.
 */
function aReport(overrides: Partial<ControlsReport> = {}): ControlsReport {
  return {
    ok: false,
    error: 'the gate never took a reading called "manual, inside"',
    recording: { id: 'r1', durationSec: 10, frameCount: 300, size: [320, 180] },
    logs: { cursorSamples: 1200, clickDowns: 4 },
    openedFromLibrary: true,
    lanes: ['Screen', 'Zoom', 'Notes'],
    tools: ['select', 'zoom'],
    readings: [],
    disk: [],
    exports: [anExport()],
    deltas: [],
    slider: null,
    settled: null,
    notes: [],
    ...overrides,
  };
}

describe('the signature is the product’s own sentence, not a keyword', () => {
  it('matches `ExportContextLostError` verbatim', () => {
    expect(lostTheContext(anExport())).toBe(true);
    expect(REAL_CONTEXT_LOST).toContain(CONTEXT_LOST_SIGNATURE);
  });

  it('is pinned to the sentence `render-loop.ts` actually throws', () => {
    // The one place this property can break. `verdict.ts` argues that a reworded
    // message breaks in the safe direction — the gate goes back to judging every
    // failed export — but that is precisely the CI state this branch exists to fix,
    // and it would return with nothing going red. So the fence reads the source.
    const source = flattenedSource(RENDER_LOOP);
    expect(source, 'the export loop no longer throws the sentence the gate matches on').toContain(
      CONTEXT_LOST_SIGNATURE,
    );
    // The control, so a search that matched anything would not pass: a reworded
    // signature is exactly what this must be able to say no to.
    expect(source).not.toContain('the WebGL context was mislaid while compositing');
  });

  it('does NOT match a failure that merely mentions a context', () => {
    // The bound this file exists to hold. A loose keyword like "context" would turn
    // any error that names one into an excuse not to judge.
    expect(lostTheContext(anExport({ error: 'the export window lost its IPC context' }))).toBe(
      false,
    );
  });

  it('does not withhold for a successful export', () => {
    expect(lostTheContext(anExport({ ok: true, error: '' }))).toBe(false);
  });
});

describe('runs that must be JUDGED rather than withheld', () => {
  /**
   * Each case is a real way this gate can go wrong. Every one of them must return
   * `false` — i.e. the gate judges the run and fails on it.
   */
  const judged: { name: string; report: ControlsReport }[] = [
    {
      name: 'the exports finished and the deltas are simply wrong',
      report: aReport({
        exports: [anExport({ ok: true, error: '', bytes: 1000 })],
        deltas: [
          { label: 'inside', meanAbs: 0.4 },
          { label: 'outside', meanAbs: 51.2 },
        ],
      }),
    },
    {
      name: 'the export failed §7.5 verification — a real defect, not an instrument',
      report: aReport({
        exports: [anExport({ error: 'the exported file’s duration is 9.400s, not 10.000s' })],
      }),
    },
    {
      name: 'the export stalled on a decode',
      report: aReport({
        exports: [
          anExport({ error: 'the decoder has not produced the frame at 4.20s for 5000ms' }),
        ],
      }),
    },
    {
      name: 'the encoder failed',
      report: aReport({ exports: [anExport({ error: 'EncodingError: encoder failure' })] }),
    },
    {
      name: 'one export lost the context and the OTHER failed for a real reason',
      report: aReport({
        exports: [anExport(), anExport({ label: 'B-manual', error: 'the muxer refused a sample' })],
      }),
    },
    {
      name: 'the context was lost but a delta was measured anyway',
      report: aReport({
        exports: [anExport()],
        deltas: [{ label: 'inside', meanAbs: 53.6 }],
      }),
    },
    {
      name: 'the context was lost but a frame was decoded back out of a file',
      report: aReport({
        exports: [
          anExport({ frames: [{ label: 'inside', timelineSec: 5, hash: 'ab', mean: [1, 2, 3] }] }),
        ],
      }),
    },
    {
      name: 'the context was lost on one export after the other finished',
      report: aReport({
        exports: [anExport({ ok: true, error: '', bytes: 1000 }), anExport({ label: 'B-manual' })],
      }),
    },
    {
      name: 'no export failed at all',
      report: aReport({ exports: [anExport({ ok: true, error: '' })] }),
    },
    {
      name: 'the harness died before it reached any export',
      report: aReport({ exports: [] }),
    },
  ];

  for (const { name, report } of judged) {
    it(`judges: ${name}`, () => {
      expect(exportInstrumentLost(report)).toBe(false);
    });
  }
});

describe('the one shape that earns a withheld verdict', () => {
  it('withholds when the only failure is the proven context loss and nothing was read', () => {
    const report = aReport();
    expect(exportInstrumentLost(report)).toBe(true);
    expect(exportReadingsTaken(report)).toEqual([]);
  });

  it('withholds when both exports lost it', () => {
    expect(
      exportInstrumentLost(aReport({ exports: [anExport(), anExport({ label: 'B-manual' })] })),
    ).toBe(true);
  });

  it('is not swayed by the editor half being full', () => {
    // The per-claim split, stated as a property: the editor's readings are present in
    // every real run and must never keep the export claims from being withheld, nor
    // cause them to be.
    const withEditor = aReport({
      readings: [{ label: 'generated, inside' } as ControlsReport['readings'][number]],
      disk: [{ label: 'after generating' } as ControlsReport['disk'][number]],
    });
    expect(exportInstrumentLost(withEditor)).toBe(true);
  });
});

describe('the banner carries the evidence, not a summary', () => {
  it('names the failure, the reach, and that it is not a pass', () => {
    const lines = describeWithheld(aReport()).join('\n');
    expect(lines).toContain('NOT JUDGED');
    // The reach statement firstmate required: a skipped test must not read as coverage.
    expect(lines).toContain('never judged on CI');
    expect(lines).toContain('only meaningful on a real Mac');
    // And the product's own refusal, so a reader can tell the guard working from a bug.
    expect(lines).toContain(CONTEXT_LOST_SIGNATURE);
  });

  it('says how many exports were never reached', () => {
    expect(describeWithheld(aReport()).join('\n')).toContain('1 export(s) were never reached');
  });
});
