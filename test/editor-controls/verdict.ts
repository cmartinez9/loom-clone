/**
 * Whether the phase 15 gate has a verdict to give, and about which of its claims.
 *
 * `test/gate/budget-control.ts` and `test/export-golden/verdict.ts` ask the same
 * question of phases 6 and 8, and this borrows their vocabulary deliberately —
 * {@link instrumentOutOfCalibration}, a withheld judgement, a **NOT JUDGED** banner, a
 * test that reports *skipped* rather than passed. One idea, one set of words.
 *
 * It is a third, separately-typed function rather than a shared one for the reason
 * `verdict.ts` gives about the two that came before it: each is typed to its own
 * report, and a predicate three gates share is a predicate a widening in one gate
 * silently applies to the others. Sharing the *code* would mean editing
 * `test/export-golden/verdict.ts`, whose judgement policy is settled and which this
 * change is not permitted to touch.
 *
 * ## What "out of calibration" means here, and how it differs from phase 8's
 *
 * Phase 6's instrument is a stopwatch and it comes back wrong. Phase 8's is a pair of
 * WebGL2 contexts and it comes back **absent**. This gate's instrument is the *export
 * pipeline* — a hidden window, its own GL context, a decoder and an encoder — and it
 * comes back **refused**: `ExportRenderLoop` consults `Compositor.contextLost` before
 * and after every composite and throws `ExportContextLostError` rather than encoding
 * frames nothing drew (§10.2). That refusal is the product behaving correctly. What was
 * missing is this gate's ability to say so.
 *
 * Measured on CI runs 31134549671, 31136423113 and 31137779565 — three launches of the
 * same commit, failing identically, so a host condition rather than a flake:
 *
 * ```
 * export A-generated  FAILED the WebGL context was lost while compositing output
 *     frame 72; the export is refused rather than encoding frames nothing drew
 *     (architecture report §10.2). … 0.000s 0B verified=false
 *   slider      never driven
 *   return trip never driven
 * ```
 *
 * Twelve assertions then failed, every one of them on a *missing reading* rather than
 * on a wrong one: `the gate never took a reading called "manual, inside"`, `expected
 * null not to be null`, `expected [ … ] to have a length of 2 but got 1`. §4.5's export
 * agreement was neither met nor missed on that run. It was not measured.
 *
 * ## The withhold is per CLAIM, not per run, and that is the important part
 *
 * Phase 8 withholds its whole verdict because a lost context empties its whole report.
 * This gate is different in a way that matters: the context died at export A, which is
 * step 4 of eight, so steps 1–3 **were measured on a healthy context** — the generator
 * ran over a real click log, the picture changed, the document reached the disk. Those
 * are readings, and a gate that threw them away because a later step lost the GPU would
 * be discarding evidence it holds.
 *
 * So {@link exportInstrumentLost} keys the withhold on the export claims alone, and the
 * claims that do not need the export are judged exactly as hard as before. That is the
 * literal reading of the instruction this was built to: *key the withhold on the proven
 * instrument failure and nothing else — a pixel disagreement on a healthy context must
 * still fail hard, that is the whole gate.*
 *
 * ## What makes it safe to withhold before the assertions rather than after
 *
 * Phase 6 puts its `skip()` last, so a withheld verdict is structurally unable to
 * suppress a real one. This gate cannot: a refused export empties the readings the
 * export claims are made of, so those assertions would fail on the absence. The safety
 * therefore lives in the predicate, and it is two conditions that must **both** hold:
 *
 *  1. the export failed with the **proven** signature — `ExportContextLostError`'s own
 *     sentence, matched on {@link CONTEXT_LOST_SIGNATURE}, which no other failure in
 *     this pipeline produces. A verification failure, a stall, an encoder error, a
 *     muxer error, a destination error: none of them match, and every one of them is
 *     judged and fails the gate;
 *  2. **no** reading of what reached a file survives — {@link exportReadingsTaken}
 *     enumerates every one a `ControlsReport` can carry, field by field, and a single
 *     one is enough to refuse to withhold. That is `mayDeleteSources`'s discipline
 *     applied to a verdict: refuse on what the record *says*, field by field, because a
 *     record claiming some of it is one to refuse whatever else it says.
 *
 * ## What the context dying at the *second* export cost, and why the second condition
 * is about pictures rather than about pipelines
 *
 * The three runs above lost the context at export **A**, so nothing about either export
 * survived and the first version of this predicate could count a finished export as a
 * reading and still be right. CI run 31161802868 is the shape that showed it was not:
 * export A finished and **verified**, the GPU process then died with
 * `Failed to allocate texture` inside `Skia_Wrapped_YUVPlane` 0.16 s after export B's
 * `export.html` loaded, and export B refused at output frame 7. One export reading
 * survived, the gate judged, and *"expected +0 to be 2"* is a verdict on §4.5's export
 * agreement that nothing on that run measured — the disease this module exists for,
 * arriving one export later than it was written for.
 *
 * So the second condition asks for readings **of the picture that reached a file**:
 * decoded frames and the two deltas, which are what every withheld claim is made of. A
 * finished export is a reading of the *pipeline* — it says the encoder and the muxer
 * worked once on this host — and it cannot say whether the manual zoom is inside the
 * file, because that comparison needs both files. It is not thrown away: it is printed,
 * by label and by byte count, in {@link describeWithheld}'s banner.
 *
 * Nothing in the strict direction moved. Condition 1 is untouched, so a §7.5
 * verification failure, a decode stall, an encoder error and a muxer refusal are still
 * each judged and each fail — including when they land on the second export after the
 * first finished. What newly withholds is one shape and it is the instrument's:
 * an export refused for a **proven** context loss, on a run where no frame was ever
 * decoded back out of a file.
 *
 * ## Honest about reach, which is the whole point of saying it out loud
 *
 * If the paravirtual CI runner loses the context on every attempt — and on the three
 * runs measured so far it has — then **this gate's export claims are never judged on
 * CI, and are only ever judged on a real Mac**. A skipped test must not be read as
 * coverage. `describeWithheld` says so in the banner and `AGENTS.md` says so in prose,
 * because an honest never-judged-here is worth having and a quiet one is not.
 *
 * The gate deliberately does **not** answer this with more attempts. It gets one
 * launch, as it always has.
 */

import type { ControlsReport, ExportReading } from './report.ts';

/**
 * `ExportContextLostError`'s own words, as the harness records them on the export.
 *
 * Matched on the message rather than on a flag because the message is what crosses the
 * process boundary — `ExportProgress.error` is a string by the time the harness sees
 * it — and because this exact sentence is written in one place
 * (`apps/renderer/src/export/render-loop.ts`) and is the only failure in the export
 * pipeline that produces it. A stall says *"has not arrived"*, a verification failure
 * names its check, an encoder failure carries the encoder's own `DOMException`.
 *
 * If that sentence is ever reworded, this stops matching and the gate goes back to
 * judging every failed export — which is the safe direction to break in, and is why
 * this is a substring of the sentence's most specific clause rather than a loose
 * keyword like "context".
 */
export const CONTEXT_LOST_SIGNATURE = 'the WebGL context was lost while compositing';

/** Did this export fail with the proven instrument failure, rather than any other way? */
export function lostTheContext(reading: ExportReading): boolean {
  return !reading.ok && reading.error.includes(CONTEXT_LOST_SIGNATURE);
}

/**
 * Every reading of **what reached a file** this report carries, named. Empty means the
 * export claims have nothing behind them.
 *
 * Field by field, and the fields are `ControlsReport`'s own. A single entry is enough
 * to refuse to withhold: the gate then judges the run and fails on it, which is the
 * right way round.
 *
 * ## What is deliberately not on this list
 *
 * **A finished export**, which is the one that took a second CI shape to get right. It
 * is a reading of the *pipeline* rather than of the picture: it says the encoder and
 * the muxer worked once on this host, and it cannot answer whether the manual zoom is
 * inside the file, because every withheld claim compares **two** files. Counting it
 * made the gate judge run 31161802868 — export A verified, export B refused at output
 * frame 7 for a proven context loss, nothing decoded — and fail it on a reading nobody
 * took. It is still evidence and it is still reported: {@link describeWithheld} prints
 * every export by label, with its byte count or its own error.
 *
 * And everything that is not a reading of an **export** at all. `readings`, `disk`,
 * `lanes` and `tools` are readings of the editor taken before the first export;
 * `slider` and `settled` are readings of the editor taken *after* it. The dividing line
 * is not *when* a reading was taken but *what it is of*: none of the six is evidence
 * about a frame that reached a file, so none of them can stand in for the export
 * claims, and counting them here would make a run that measured the editor and lost the
 * GPU judge its export claims against nothing.
 *
 * That `slider` and `settled` sit after export A has a consequence worth being exact
 * about rather than glossing: their own gate tests call `withholdIfInstrumentLost`,
 * because a harness that died at export A never reached the gesture that produces
 * them. So they are withheld with the export claims — they are simply not what decides
 * whether to withhold. This is not an incomplete enumeration; it is the per-claim split
 * this module exists for. Do not finish it.
 */
export function exportReadingsTaken(report: ControlsReport): string[] {
  const readings: string[] = [];
  const frames = report.exports.reduce((sum, e) => sum + e.frames.length, 0);
  if (frames > 0) readings.push(`${String(frames)} frame(s) were decoded back out of a file`);
  if (report.deltas.length > 0) {
    readings.push(
      `${String(report.deltas.length)} delta(s) measured: ` +
        report.deltas.map((d) => `${d.label}=${d.meanAbs.toFixed(3)}`).join(', '),
    );
  }
  return readings;
}

/**
 * Was the export instrument taken away, leaving nothing to judge the export claims by?
 *
 * Two measured facts and nothing else — not CI, not an environment variable, not the
 * renderer string, not `report.ok`, and not `report.error`, which carries whichever
 * assertion happened to throw first:
 *
 *  1. at least one export failed with {@link lostTheContext}, and **no** export failed
 *     any *other* way. A run where one export lost the context and another failed
 *     verification has a real defect in it and is judged, and so is one where the
 *     *second* export failed for a real reason after the first finished;
 *  2. **no** reading of what reached a file survives — {@link exportReadingsTaken} is
 *     empty. A finished export is not one of those, and the module docblock says why.
 *
 * The second is the load-bearing half and the reason this may run before the export
 * assertions rather than after them.
 */
export function exportInstrumentLost(report: ControlsReport): boolean {
  const failed = report.exports.filter((e) => !e.ok);
  if (failed.length === 0) return false;
  if (!failed.every(lostTheContext)) return false;
  return exportReadingsTaken(report).length === 0;
}

/**
 * The banner, in phases 6 and 8's own shape.
 *
 * Written out rather than imported from `test/export-golden/verdict.ts` for the reason
 * phase 6 also has its own copy: the rule and the vocabulary are shared, the *evidence*
 * is each gate's own, and phase 8's text names phase 8's readings. Importing it would
 * print "PHASE 8 GATE" over a phase 15 run.
 */
export function notJudgedBanner(withheld: readonly string[]): string {
  const rule = '='.repeat(78);
  return [
    '',
    rule,
    '  PHASE 15 GATE — NO VERDICT on the export claims. This is not a pass.',
    '  Nothing here says the manual zoom reached the exported file, and nothing here',
    '  says it did not: the export refused to composite through a lost WebGL context,',
    '  so no frame was ever decoded back out of a file and no delta was measured.',
    '',
    '  The EDITOR claims are unaffected and were judged on this run — they are',
    '  measured before the export runs and on a healthy context. What is withheld is',
    '  every claim from the first export onward.',
    rule,
    ...withheld,
    rule,
    '',
  ].join('\n');
}

/**
 * The **NOT JUDGED** banner: what was taken away, on whose word, and what went unread.
 *
 * Carries the measured evidence rather than a summary, so a person reading a skipped
 * run can tell this apart from a gate that quietly does nothing.
 */
export function describeWithheld(report: ControlsReport): string[] {
  const lines: string[] = [
    'NOT JUDGED — the export instrument was taken away, so §4.5’s export agreement was',
    'neither met nor missed on this run. It was not measured.',
    '',
  ];
  for (const reading of report.exports) {
    lines.push(
      reading.ok
        ? `  export ${reading.label}: finished (${String(reading.bytes)}B)`
        : `  export ${reading.label}: ${reading.error}`,
    );
  }
  const missing = report.exports.length < 2 ? 2 - report.exports.length : 0;
  if (missing > 0) {
    lines.push(`  ${String(missing)} export(s) were never reached, so nothing followed them.`);
  }
  lines.push(
    '',
    '  The refusal is the product working: `ExportRenderLoop` consults',
    '  `Compositor.contextLost` before and after every composite and refuses rather than',
    '  encoding frames nothing drew (§10.2). What is withheld is this gate’s verdict, not',
    '  the export’s.',
    '',
    '  REACH: on the paravirtual CI runner this has happened on every attempt measured so',
    '  far (runs 31134549671, 31136423113, 31137779565 — three launches of one commit,',
    '  failing identically). Read that plainly: **the export claims of this gate are',
    '  effectively never judged on CI, and are only meaningful on a real Mac.** A skipped',
    '  test is not coverage. The editor claims below it are judged on every run and are',
    '  unaffected — they are measured before the export and on a healthy context.',
  );
  return lines;
}
