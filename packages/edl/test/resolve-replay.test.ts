/**
 * **Phase 7 gate, half one.** Architecture report §8:
 *
 * > Property test: `resolve()` after a random op sequence == `resolve()` after
 * > save+reload+replay.
 *
 * ## What this is actually proving
 *
 * §2.7 splits one mechanism two ways: the journal gives crash-safety and the same
 * ops give undo. Both rest on a claim that is easy to state and easy to break —
 * **the document in the editor's memory and the document that comes back off disk
 * are the same document**, in the only sense that matters, which is what `resolve`
 * says about them. Anything that survives in memory but not through JSON, or that a
 * replay reconstructs in a different order, produces an editor whose preview does
 * not match its own file after a restart. That is the class of bug this gate exists
 * to make impossible.
 *
 * So the comparison is deliberately end-to-end: ops go through the shipping
 * `applyOps`, the snapshot through `JSON.stringify`/`JSON.parse` and
 * `validateEditDocument`, the journal through the same NDJSON `JournalWriter`
 * writes and `parseJournal`/`replayJournal` read, and both documents through
 * `compile`/`resolve` at several hundred times each — including every keyframe,
 * every `activeRanges` edge, every crossfade shoulder, every span edge and a nudge
 * either side of each.
 *
 * ## Why it cannot pass vacuously
 *
 * Four times on this project a test has passed for a reason unrelated to what it
 * claimed to prove, so this file follows `kill-mid-write.test.ts`'s pattern:
 *
 * 1. **The corpus is asserted, not assumed.** Every op kind in §2.7's vocabulary,
 *    every target, both time domains, all three blend modes, all four ease kinds,
 *    spring channels, clamps, crossfades, spans and non-unit clip speeds must all
 *    appear — and the resolved states must actually *vary* across the sample times.
 *    A generator that quietly stopped producing spring channels would fail here
 *    rather than making the gate cheaper to pass.
 * 2. **There are controls.** Eleven deliberate corruptions of the saved bytes, each
 *    one a plausible way for a "save" to lose something — a dropped `ease`, a
 *    rounded `t`, a dropped `clamp`, reordered tracks, a flipped `domain` — are run
 *    through the identical comparator, and **every one of them must be caught**. If
 *    the comparator ever stops catching them, the assertion above proves nothing and
 *    this file fails instead of passing quietly.
 */

import { describe, expect, it } from 'vitest';
import { validateEditDocument, type EditDocument } from '@loom/format';
import {
  corpusContext,
  firstDifference,
  generateSequence,
  journalText,
  reloadAndReplay,
  resolveAll,
  sampleTimes,
  snapshotText,
  type StateSnapshot,
} from './helpers/pipeline.ts';
import { CORPUS_DURATION_SEC, emptyCoverage } from './helpers/random-ops.ts';

/** One context, shared by every path in every run — see `corpusContext`. */
const CTX = corpusContext();

/** Enough sequences that a rare op ordering shows up; small enough to stay quick. */
const SEEDS = 40;
const OPS_PER_SEQUENCE = 45;

interface Run {
  seed: number;
  live: EditDocument;
  replayed: EditDocument;
  times: number[];
  liveStates: StateSnapshot[];
  replayedStates: StateSnapshot[];
  baseJson: string;
  journal: string;
}

function runSequence(
  seed: number,
  coverage = emptyCoverage(),
): { run: Run; coverage: typeof coverage } {
  const { sequence } = generateSequence(seed, OPS_PER_SEQUENCE, coverage);
  const baseJson = snapshotText(sequence.base);
  const journal = journalText(sequence.entries);
  const replayed = reloadAndReplay(baseJson, journal);
  const times = sampleTimes(sequence.live, CORPUS_DURATION_SEC);
  return {
    run: {
      seed,
      live: sequence.live,
      replayed,
      times,
      liveStates: resolveAll(sequence.live, times, CTX),
      replayedStates: resolveAll(replayed, times, CTX),
      baseJson,
      journal,
    },
    coverage,
  };
}

describe('resolve() after a random op sequence == resolve() after save + reload + replay', () => {
  const coverage = emptyCoverage();
  const runs: Run[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) runs.push(runSequence(seed, coverage).run);

  it('is identical, over many independent random sequences', () => {
    for (const run of runs) {
      const difference = firstDifference(run.liveStates, run.replayedStates);
      expect(
        difference,
        difference === null
          ? ''
          : `seed ${run.seed}: replayed document resolves differently at t=` +
              `${String(run.times[difference.index])} (field ${String(difference.field)}): ` +
              `${String(difference.a)} vs ${String(difference.b)}`,
      ).toBeNull();
      // The revision travels too: a replay that lost an op would still have to be
      // caught by the states above, but a replay that lost the *count* is a
      // different bug and this is where it shows.
      expect(run.replayed.revision).toBe(run.live.revision);
    }
  });

  it('survives a second save: the replayed document round-trips through JSON unchanged', () => {
    // The other half of §2.7's cycle — main snapshots the replayed document back to
    // `edit.json` two seconds later, and that snapshot has to resolve the same way.
    for (const run of runs) {
      const reSnapshot: unknown = JSON.parse(snapshotText(run.replayed));
      const validation = validateEditDocument(reSnapshot);
      expect(validation.ok, `seed ${run.seed}: re-snapshot failed validation`).toBe(true);
      if (!validation.ok) continue;
      const again = resolveAll(validation.value, run.times, CTX);
      expect(firstDifference(run.liveStates, again), `seed ${run.seed}`).toBeNull();
    }
  });

  it('exercised the whole model, not a corner of it', () => {
    // Without this the gate above could be passing on forty documents of one empty
    // zoom track, which is exactly the shape of "passed for an unrelated reason".
    expect([...coverage.opKinds].sort()).toEqual([
      'clips.set',
      'key.remove',
      'key.set',
      'span.remove',
      'span.set',
      'track.add',
      'track.patch',
      'track.remove',
    ]);
    expect([...coverage.targets].sort()).toEqual([
      'annotation',
      'audio:mic',
      'audio:system',
      'bubble',
      'cursor',
      'zoom',
    ]);
    expect([...coverage.domains].sort()).toEqual(['source', 'timeline']);
    expect([...coverage.blends].sort()).toEqual(['add', 'multiply', 'replace']);
    expect([...coverage.easeKinds].sort()).toEqual(['cubic', 'hold', 'linear', 'spring']);
    expect(coverage.springChannels).toBeGreaterThan(0);
    expect(coverage.clampedChannels).toBeGreaterThan(0);
    expect(coverage.crossfadedTracks).toBeGreaterThan(0);
    expect(coverage.spans).toBeGreaterThan(0);
    expect(coverage.nonUnitSpeeds).toBeGreaterThan(0);
  });

  it('resolved something that moves — the states are not all the same', () => {
    // A model that returned the identity at every time would satisfy every equality
    // above. It must not be able to.
    let varying = 0;
    for (const run of runs) {
      const distinct = new Set(run.liveStates.map((s) => JSON.stringify(s)));
      if (distinct.size > 1) varying++;
      // Every run resolves at hundreds of times; a run with one distinct state is a
      // document with nothing in it.
      expect(run.liveStates.length).toBeGreaterThan(100);
    }
    expect(varying, 'no generated sequence produced a state that changed over time').toBe(
      runs.length,
    );
  });
});

// ---------------------------------------------------------------------------
// The controls.
// ---------------------------------------------------------------------------

/**
 * A deliberate corruption of the saved bytes.
 *
 * Each one is a way a save could plausibly lose something — the exact failures the
 * gate above claims to rule out. `mutate` returns the new `[baseJson, journal]`, or
 * `null` when this sequence has nothing for it to bite on.
 */
interface Corruption {
  name: string;
  mutate: (baseJson: string, journal: string) => [string, string] | null;
}

/** Rewrite every JSON object in the journal text through `f`. */
function rewriteJournal(journal: string, f: (line: Record<string, unknown>) => void): string {
  const lines = journal.split('\n').filter((l) => l.length > 0);
  return (
    lines
      .map((line, index) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (index > 0) f(parsed);
        return JSON.stringify(parsed);
      })
      .join('\n') + '\n'
  );
}

/** Walk every object in a parsed JSON tree. */
function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

function corruptEveryOp(name: string, visit: (node: Record<string, unknown>) => void): Corruption {
  return {
    name,
    mutate: (baseJson, journal) => [
      baseJson,
      rewriteJournal(journal, (line) => {
        walk(line, visit);
      }),
    ],
  };
}

const CORRUPTIONS: readonly Corruption[] = [
  corruptEveryOp('drops `ease` from every keyframe', (node) => {
    if ('t' in node && 'v' in node && 'ease' in node) delete node['ease'];
  }),
  corruptEveryOp('coerces every ease to linear', (node) => {
    if ('kind' in node && typeof node['kind'] === 'string' && node['kind'] !== 'linear') {
      const kind = node['kind'];
      if (kind === 'hold' || kind === 'cubic' || kind === 'spring') node['kind'] = 'linear';
    }
  }),
  corruptEveryOp('rounds every keyframe `t` to two decimals', (node) => {
    if ('t' in node && typeof node['t'] === 'number' && 'v' in node) {
      node['t'] = Math.round(node['t'] * 100) / 100;
    }
  }),
  corruptEveryOp('drops every channel `clamp`', (node) => {
    if ('keys' in node && 'clamp' in node) delete node['clamp'];
  }),
  corruptEveryOp('drops every channel `spring`', (node) => {
    if ('keys' in node && 'spring' in node) delete node['spring'];
  }),
  corruptEveryOp('flips every `domain` to timeline', (node) => {
    if (node['domain'] === 'source') node['domain'] = 'timeline';
  }),
  corruptEveryOp('zeroes every `blendMs`', (node) => {
    if ('blendMs' in node && typeof node['blendMs'] === 'number' && node['blendMs'] > 0) {
      node['blendMs'] = 0;
    }
  }),
  corruptEveryOp('drops every `activeRanges`', (node) => {
    if ('activeRanges' in node) node['activeRanges'] = [];
  }),
  corruptEveryOp('forces every `blend` to replace', (node) => {
    if (node['blend'] === 'add' || node['blend'] === 'multiply') node['blend'] = 'replace';
  }),
  corruptEveryOp('perturbs every clip `speed` by one part in ten thousand', (node) => {
    if ('sourceStart' in node && typeof node['speed'] === 'number') {
      node['speed'] = node['speed'] * 1.0001;
    }
  }),
  {
    // Not a lossy field but a lost *order* — §3.5 resolves tracks in array order, so
    // a replay that reordered them would change which track wins.
    name: 'drops every `track.add` insertion index',
    mutate: (baseJson, journal) => [
      baseJson,
      rewriteJournal(journal, (line) => {
        const op = line['op'];
        if (
          typeof op === 'object' &&
          op !== null &&
          (op as Record<string, unknown>)['op'] === 'track.add'
        ) {
          delete (op as Record<string, unknown>)['at'];
        }
      }),
    ],
  },
];

describe('CONTROL: the comparator catches a save that loses something', () => {
  for (const corruption of CORRUPTIONS) {
    it(`catches a save that ${corruption.name}`, () => {
      let applied = 0;
      let caught = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { sequence } = generateSequence(seed, OPS_PER_SEQUENCE);
        const baseJson = snapshotText(sequence.base);
        const journal = journalText(sequence.entries);
        const mutated = corruption.mutate(baseJson, journal);
        if (mutated === null) continue;
        const [mutatedBase, mutatedJournal] = mutated;
        if (mutatedBase === baseJson && mutatedJournal === journal) continue;
        applied++;

        const times = sampleTimes(sequence.live, CORPUS_DURATION_SEC);
        const liveStates = resolveAll(sequence.live, times, CTX);
        let differed: boolean;
        try {
          const replayed = reloadAndReplay(mutatedBase, mutatedJournal);
          differed = firstDifference(liveStates, resolveAll(replayed, times, CTX)) !== null;
        } catch {
          // A corruption severe enough to be refused on the way back in — an invalid
          // document, a spring channel with no parameters — is caught, not missed.
          differed = true;
        }
        if (differed) caught++;
      }

      expect(
        applied,
        `no generated sequence contained anything for "${corruption.name}" to corrupt`,
      ).toBeGreaterThan(0);
      expect(
        caught,
        `"${corruption.name}" changed the saved bytes in ${String(applied)} sequences and the ` +
          'comparator noticed in none of them, so the gate above is not actually ' +
          'comparing what it claims to compare',
      ).toBeGreaterThan(0);
    });
  }

  it('and the unmutated pipeline it is compared against is genuinely clean', () => {
    // The controls are only meaningful because the same harness, run without a
    // corruption, reports no difference at all. That is asserted in the gate above;
    // asserting it here as well is what makes each control a two-sided claim.
    for (let seed = 1; seed <= 8; seed++) {
      const { run } = runSequence(seed);
      expect(firstDifference(run.liveStates, run.replayedStates)).toBeNull();
    }
  });
});
