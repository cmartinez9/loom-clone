/**
 * Reading the phase-10 corpus: ten real recordings, off the disk, as streams.
 *
 * §8's phase-10 gate is *"seasickness budget assertions pass on **10 real
 * recordings**"*. `packages/edl/test/corpus/` holds them — real `.loomrec` bundles
 * made by `scripts/record-cursor-corpus.mjs`, whose `manifest.json` records what moved
 * the mouse (a script by default, a person under `--manual`) and everything the
 * sampler reported about each run. Everything below `CGWarpMouseCursorPosition` is the
 * shipping path: the real `loom-input-sampler` polling at 120 Hz, the real
 * `InputSampler` writing §2.5's shapes.
 *
 * This file is the only thing in `packages/edl` that touches a filesystem, and it is
 * test code: `eslint.config.mjs` keeps `node:` out of `packages/edl/src`, which is
 * where the purity rule lives.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecordingDoc } from '@loom/format';
import {
  arrayClickStream,
  arrayCursorStream,
  type ClickEventInput,
  type ClickEventStream,
  type CursorEventStream,
  type CursorSampleInput,
} from '../src/streams.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = join(here, 'corpus');

export interface CorpusManifestEntry {
  name: string;
  bundle: string;
  hand: 'scripted' | 'human';
  profile: { name: string; pace: number; clickRate: number } | null;
  seconds: number;
  durationSec: number;
  cursorSamples: number;
  samplesPerSec: number;
  droppedLines: number;
  clickCapture: {
    measured: boolean;
    reason: string;
    axTrusted: boolean;
    tapEnabled: boolean;
    postedDowns: number;
    observedDowns: number | null;
    deliveredFraction: number | null;
    latencyMs: { samples: number; min: number; median: number; p95: number; max: number } | null;
  };
}

/**
 * The corpus-wide answer to the captain's open question about click capture.
 *
 * `measured: false` means post-grant rate and latency are still unmeasured — never
 * that they were measured as zero. The phase-10 gate reads it to decide whether §6.5
 * is being exercised against real `CGEventTap` output or only against its refusal path.
 */
export type CorpusClickCapture =
  | { measured: false; reason: string; recordings: number; note: string }
  | {
      measured: true;
      recordings: number;
      postedDowns: number;
      observedDowns: number;
      deliveredFraction: number;
      observedRateHz: number;
      latencyMs: {
        samples: number;
        min: number;
        meanOfMedians: number;
        meanOfP95: number;
        max: number;
      };
    };

export interface CorpusManifest {
  generatedAt: string;
  tool: string;
  clickCapture: CorpusClickCapture;
  hand: 'scripted' | 'human';
  note: string;
  os: string;
  recordings: CorpusManifestEntry[];
}

export interface CorpusRecording {
  entry: CorpusManifestEntry;
  recording: RecordingDoc;
  cursor: CursorEventStream;
  /**
   * `null` when the recording has no click log — which is **not** an empty stream.
   * `clickSourceFrom` is what turns this and `recording.json` into the one answer a
   * generator is allowed to see.
   */
  clicks: ClickEventStream | null;
  /** Extent of the cursor log itself, in source seconds. */
  durationSec: number;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readNdjson(path: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    out.push(JSON.parse(line) as Record<string, unknown>);
  }
  return out;
}

export function loadCorpusManifest(): CorpusManifest {
  return readJson(join(CORPUS_DIR, 'manifest.json')) as CorpusManifest;
}

/**
 * Load one recording's logs.
 *
 * §2.5's cursor log carries non-position events (`e: 'display'`, `e: 'clicks'`) on the
 * same lines as positions; only the positions are cursor samples, and the rest are
 * dropped here rather than sanity-filtered downstream — a `{e:'display'}` line has no
 * `x` at all and is not a cursor at (0,0).
 */
export function loadCorpusRecording(entry: CorpusManifestEntry): CorpusRecording {
  const dir = join(CORPUS_DIR, entry.bundle);
  const recording = readJson(join(dir, 'recording.json')) as RecordingDoc;

  const samples: CursorSampleInput[] = [];
  for (const line of readNdjson(join(dir, 'events', 'cursor.ndjson'))) {
    if (line['e'] !== undefined) continue;
    samples.push({
      t: line['t'] as number,
      x: line['x'] as number,
      y: line['y'] as number,
      c: (line['c'] as string | undefined) ?? '',
    });
  }

  const clickLines = readNdjson(join(dir, 'events', 'clicks.ndjson'));
  const clicks: ClickEventInput[] = clickLines.map((line) => ({
    t: line['t'] as number,
    e: line['e'] as 'down' | 'up',
    b: (line['b'] as number | undefined) ?? 0,
    x: line['x'] as number,
    y: line['y'] as number,
  }));

  const first = samples[0]?.t ?? 0;
  const last = samples[samples.length - 1]?.t ?? 0;
  return {
    entry,
    recording,
    cursor: arrayCursorStream(samples),
    // Absent, not empty: the log only exists once the tap was confirmed live.
    clicks: clickLines.length > 0 ? arrayClickStream(clicks) : null,
    durationSec: last - first,
  };
}

export function loadCorpus(): CorpusRecording[] {
  return loadCorpusManifest().recordings.map(loadCorpusRecording);
}
