/**
 * The save → reload → replay pipeline, and an exact comparator for resolved states.
 *
 * This is the machinery phase 7's first gate needs and nothing else: it drives the
 * *shipping* code — `applyOps`, `JSON.stringify`, `parseJournal`, `replayJournal`,
 * `validateEditDocument`, `compile`, `resolve` — rather than a copy of it, so a
 * regression in any of them fails the gate. Only the two things a filesystem would
 * provide are stood in for here: the bytes of `edit.json` and the bytes of
 * `edit.journal.ndjson`. Both are produced exactly as `JournalWriter` produces them
 * (one JSON object per line, newline-terminated, header first).
 */

import {
  applyOps,
  currentSchemaId,
  isoTimestamp,
  parseJournal,
  replayJournal,
  validateEditDocument,
  type EditDocument,
  type JournalEntry,
} from '@loom/format';
import {
  arrayCursorStream,
  compile,
  resolve,
  type CompileContext,
  type ResolvedState,
} from '../../src/index.ts';
import {
  CORPUS_DURATION_SEC,
  emptyCoverage,
  observe,
  randomOp,
  Rng,
  type Coverage,
} from './random-ops.ts';

/**
 * The context a compile gets in the app: a recording with a screen track, and a
 * cursor log.
 *
 * Both matter to the gate. The recording is what an **empty** clip list means "the
 * whole source" against (§3.1 and `newEditDocument`'s note), so without one a
 * document that has not been trimmed yet would resolve over a zero-length timeline
 * and every comparison in the gate would be a comparison of one instant. The cursor
 * stream is what makes `ResolvedState.cursor` a real field rather than a permanent
 * `null`.
 */
export function corpusContext(): CompileContext {
  const samples = [];
  for (let i = 0; i * 0.05 <= CORPUS_DURATION_SEC; i++) {
    const t = i * 0.05;
    samples.push({
      t,
      x: (Math.sin(t * 0.7) + 1) / 2,
      y: (Math.cos(t * 0.31) + 1) / 2,
      c: i % 40 === 0 ? 'ibeam' : 'arrow',
    });
  }
  return {
    cursor: arrayCursorStream(samples),
    clicks: null,
    recording: {
      schema: currentSchemaId('loom.recording'),
      clock: { kind: 'videoframe-timestamp-us', t0Us: 0 },
      display: {
        id: 1,
        name: 'Built-in',
        logicalSize: [1728, 1117],
        pixelSize: [3456, 2234],
        scaleFactor: 2,
        colorSpace: 'srgb',
      },
      tracks: {
        screen: {
          kind: 'video',
          parts: [
            {
              file: 'media/screen.000.mp4',
              codec: 'avc1.640028',
              index: 'media/screen.000.index.json',
              startTimeSec: 0,
              durationSec: CORPUS_DURATION_SEC,
              endedEarly: false,
              size: [3456, 2234],
              frameCount: CORPUS_DURATION_SEC * 30,
              rate: { mode: 'variable', nominalFps: 30, observedFps: 29.4 },
            },
          ],
        },
      },
      events: {},
      capture: {
        app: '0.1.0',
        os: '14.0',
        permissions: {
          screen: 'granted',
          camera: 'denied',
          microphone: 'granted',
          accessibility: true,
        },
        requestedFps: 30,
        resolutionClamp: 'none',
        droppedFrames: {},
      },
      integrity: { finalizedAt: null, recoveredFromCrash: false, truncatedToSec: null },
    },
  };
}

export interface Sequence {
  seed: number;
  /** The snapshot on disk — what `edit.json` holds. */
  base: EditDocument;
  entries: JournalEntry[];
  /** What the editor holds in memory after every op. */
  live: EditDocument;
}

/**
 * Generate and apply a random op sequence.
 *
 * Every op is applied through the shipping `applyOps` and the result validated, so
 * a generator that wandered into an invalid document fails here rather than
 * silently narrowing what the gate covers.
 */
export function generateSequence(
  seed: number,
  opCount: number,
  coverage: Coverage = emptyCoverage(),
): { sequence: Sequence; coverage: Coverage } {
  const rng = new Rng(seed);
  const base: EditDocument = {
    schema: currentSchemaId('loom.edit'),
    revision: 0,
    output: { size: [1920, 1240], fps: 30, background: { kind: 'none' } },
    clips: [],
    tracks: [],
  };

  let live = base;
  const entries: JournalEntry[] = [];
  let attempts = 0;
  while (entries.length < opCount && attempts < opCount * 8) {
    attempts++;
    const op = randomOp(rng, live);
    if (op === null) continue;
    let next: EditDocument;
    try {
      next = applyOps(live, [op]);
    } catch {
      // A generated op that cannot apply is not interesting — main would reject it
      // too — so it is skipped rather than counted.
      continue;
    }
    const validation = validateEditDocument(next);
    if (!validation.ok) {
      throw new Error(
        `seed ${seed} generated an invalid document after ${op.op}: ` +
          validation.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
      );
    }
    live = next;
    entries.push({ revision: next.revision, at: isoTimestamp(new Date(0)), op });
    observe(coverage, live, op);
  }

  return { sequence: { seed, base, entries, live }, coverage };
}

/** `edit.journal.ndjson`'s bytes, exactly as `JournalWriter` writes them. */
export function journalText(entries: readonly JournalEntry[]): string {
  const header = `${JSON.stringify({ schema: currentSchemaId('loom.journal') })}\n`;
  return header + entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

/** `edit.json`'s bytes. */
export function snapshotText(doc: EditDocument): string {
  return JSON.stringify(doc, null, 2);
}

export class ReloadError extends Error {}

/**
 * Read a snapshot and a journal back the way `readBundle` does, and replay.
 *
 * `validateEditDocument` runs on the parsed snapshot because §2.7 makes every read
 * a parse → migrate → validate, and a gate that skipped the validate would be
 * comparing against a document the app would have refused.
 */
export function reloadAndReplay(baseJson: string, journal: string): EditDocument {
  const parsed: unknown = JSON.parse(baseJson);
  const validation = validateEditDocument(parsed);
  if (!validation.ok) {
    throw new ReloadError(
      `reloaded edit.json is invalid: ${validation.issues
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const journalParse = parseJournal(journal);
  if (journalParse.headerRejected) throw new ReloadError('journal header rejected');
  if (journalParse.problems.length > 0) {
    throw new ReloadError(`journal had bad lines: ${JSON.stringify(journalParse.problems)}`);
  }
  const replay = replayJournal(validation.value, journalParse.entries);
  if (replay.stoppedAt !== null) {
    throw new ReloadError(
      `replay stopped at revision ${replay.stoppedAt.revision}: ${replay.stoppedAt.reason}`,
    );
  }
  return replay.doc;
}

/**
 * The times a comparison is taken at.
 *
 * A uniform sweep alone would step straight over a 250 ms crossfade and over the
 * instant a `hold` key takes effect, so the grid is the union of a sweep with every
 * boundary the document names — keyframe times, `activeRanges` edges, the crossfade
 * shoulders inside those edges, span edges and clip starts — plus a nudge either
 * side of each, because the interesting disagreements are one ulp wide.
 */
export function sampleTimes(doc: EditDocument, durationSec: number, sweep = 400): number[] {
  const times = new Set<number>();
  for (let i = 0; i <= sweep; i++) times.add((durationSec * i) / sweep);

  const add = (t: number): void => {
    for (const nudge of [-1e-3, 0, 1e-3]) {
      const at = t + nudge;
      if (at >= 0 && at <= durationSec) times.add(at);
    }
  };

  for (const clip of doc.clips) add(clip.sourceStart);
  for (const track of doc.tracks) {
    const blendSec = track.blendMs / 1000;
    for (const [start, end] of track.activeRanges) {
      add(start);
      add(end);
      if (blendSec > 0) {
        add(start + blendSec);
        add(end - blendSec);
      }
    }
    for (const channel of Object.values(track.channels)) for (const key of channel.keys) add(key.t);
    for (const span of track.spans ?? []) {
      add(span.start);
      add(span.end);
      for (const channel of Object.values(span.channels ?? {})) {
        for (const key of channel.keys) add(key.t);
      }
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** A resolved state flattened into something comparable exactly. */
export type StateSnapshot = readonly (number | string | boolean)[];

export function snapshotState(state: ResolvedState): StateSnapshot {
  const out: (number | string | boolean)[] = [
    state.timelineTime,
    state.sourceTime,
    state.clipIndex,
    state.zoom.amount,
    state.zoom.center[0],
    state.zoom.center[1],
    state.bubble.visible,
    state.bubble.center[0],
    state.bubble.center[1],
    state.bubble.sizeY,
    state.bubble.aspect,
    state.bubble.corner01,
    state.bubble.opacity,
    state.bubble.mirror,
    state.audio.micGain,
    state.audio.systemGain,
    state.cursor === null ? 'no-cursor' : 'cursor',
  ];
  if (state.cursor !== null) {
    out.push(state.cursor.pos[0], state.cursor.pos[1], state.cursor.imageId, state.cursor.scale);
    out.push(state.cursor.opacity);
  }
  out.push(state.annotations.length);
  for (const annotation of state.annotations) {
    out.push(annotation.id, annotation.type, annotation.weight, JSON.stringify(annotation.style));
    for (const name of [...annotation.values.keys()].sort()) {
      out.push(name);
      for (const value of annotation.values.get(name) ?? []) out.push(value);
    }
  }
  return out;
}

/** Resolve a whole document at a whole set of times. */
export function resolveAll(
  doc: EditDocument,
  times: readonly number[],
  ctx?: CompileContext,
): StateSnapshot[] {
  const compiled = ctx === undefined ? compile(doc) : compile(doc, ctx);
  return times.map((t) => snapshotState(resolve(compiled, t)));
}

/** The first index where two runs differ, or `null` when they are identical. */
export function firstDifference(
  a: readonly StateSnapshot[],
  b: readonly StateSnapshot[],
): { index: number; field: number; a: unknown; b: unknown } | null {
  if (a.length !== b.length) return { index: -1, field: -1, a: a.length, b: b.length };
  for (let i = 0; i < a.length; i++) {
    const left = a[i] ?? [];
    const right = b[i] ?? [];
    if (left.length !== right.length)
      return { index: i, field: -1, a: left.length, b: right.length };
    for (let f = 0; f < left.length; f++) {
      // `Object.is`, not `===`: `0` and `-0` are different answers from a fold, and
      // a gate that says "identical" must mean it.
      if (!Object.is(left[f], right[f])) {
        return { index: i, field: f, a: left[f], b: right[f] };
      }
    }
  }
  return null;
}
