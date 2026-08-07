/**
 * Running §6's generators from the editor, and §3.5's *regenerate* and *bake*.
 *
 * Phase 10 built both generators and proved them on ten real recordings; nothing has
 * ever run one from a window. What was missing is not arithmetic — `@loom/edl` owns
 * all of it and none of it is re-derived here — but three things a renderer has to
 * do and a pure package cannot:
 *
 *  1. **Read the logs.** `events/cursor.ndjson` and `events/clicks.ndjson` come over
 *     `loom://recording/<id>/…`, the same read-only, path-confined protocol the media
 *     and the frame-index sidecar already arrive on. No filesystem in a renderer, and
 *     no new capability: `recordingUrl` composes a URL main already serves.
 *  2. **Fingerprint them.** §3.5's staleness is a digest comparison, so the caller has
 *     to have the bytes and hash them. `crypto.subtle` is available because
 *     `loom://` is a registered *secure* scheme (`protocol.ts`), which is the same
 *     property that lets these pages use `fetch` at all.
 *  3. **Answer "was the tap alive?"** — which is `recording.json`'s question, not the
 *     log's. `clicks.ndjson` exists only once `CGEventTap` was confirmed live, so an
 *     absent file and an empty one are different states, and `clickSourceFrom` is the
 *     one function allowed to collapse them into what a generator sees.
 *
 * ## Why the parsing is here and pure, and the fetching is injected
 *
 * The reading rules are §2.5's and they are exactly the kind of thing that is wrong
 * invisibly: a `{"e":"display"}` line has no `x` at all and is **not** a cursor at
 * (0, 0). `packages/edl/test/corpus.ts` states that rule for the corpus loader; this
 * states the same rule for the product, and {@link parseCursorLog} is testable without
 * a window so the two can be compared.
 */

import {
  arrayClickStream,
  arrayCursorStream,
  bakeOps,
  clickSourceFrom,
  DEFAULT_AUTO_ZOOM_PARAMS,
  DEFAULT_CURSOR_FOLLOW_PARAMS,
  generateAutoZoom,
  generateCursorFollow,
  generatedTrackStaleness,
  isRegenerable,
  regenerateOps,
  type ClickEventInput,
  type CursorSampleInput,
  type StalenessReport,
} from '@loom/edl';
import { recordingUrl } from '@loom/ipc';
import type { EditDocument, EditOp, RecordingDoc, RecordingId, Track } from '@loom/format';

/** The two generators this editor can run. `duck-under-mic` is nobody's yet. */
export const RUNNABLE_GENERATORS = ['cursor-follow', 'auto-zoom-on-click'] as const;

export type RunnableGenerator = (typeof RUNNABLE_GENERATORS)[number];

/** The track id each generator's output lives on, so a regeneration finds its own. */
export const GENERATOR_TRACK_ID: Record<RunnableGenerator, string> = {
  'cursor-follow': 't-zoom-cursor-follow',
  'auto-zoom-on-click': 't-zoom-auto',
};

export const GENERATOR_LABEL: Record<RunnableGenerator, string> = {
  'cursor-follow': 'Cursor follow',
  'auto-zoom-on-click': 'Zoom on click',
};

/**
 * Where §3.5 puts each generator in the stack, as a **rank** rather than a literal
 * index at the call site.
 *
 * §3.5 puts a generated cursor-follow track at the bottom and auto-zoom above it, and
 * that order is load-bearing rather than tidy: cursor-follow emits a `center`-only
 * channel with a single always-on `activeRange`, so a cursor-follow track sitting
 * *above* auto-zoom outranks §6.5 step 3's edge-snapped cluster framing inside every
 * click segment while auto-zoom's `amount` still applies — the shot zooms in on a
 * click and frames somewhere else. `packages/edl/test/generator-stacking.test.ts`
 * pins the arrangement and kept passing while this window inserted both at index 0,
 * because what it exercises is what the *model* can express and not the order the
 * editor inserts in. {@link runGenerator}'s own coverage is in
 * `apps/renderer/test/editor-generators.test.ts`, over both invocation orders.
 */
export const GENERATOR_RANK: Record<RunnableGenerator, number> = {
  'cursor-follow': 0,
  'auto-zoom-on-click': 1,
};

/** The two §2.5 logs a recording can declare, by the names `recording.json` uses. */
export const EVENT_LOG_NAMES = ['cursor', 'clicks'] as const;

export type EventLogName = (typeof EVENT_LOG_NAMES)[number];

/**
 * The logs, parsed, with the digests §3.5's fingerprint is made of.
 *
 * `clicks` is `null` when the recording has no click log — which is **not** an empty
 * one. Phase 5 exists to keep those apart (`recording.json` marks clicks
 * `available: false` rather than writing an empty file), and phase 10's `ClickSource`
 * restates it at the seam that consumes it.
 */
export interface EventLogs {
  cursor: CursorSampleInput[] | null;
  clicks: ClickEventInput[] | null;
  /** `{ cursor: 'sha256:…', clicks: 'sha256:…' }` — only for the logs that exist. */
  digests: Record<string, string>;
  /**
   * The logs the recording **declares** and this build could not read, by name.
   *
   * Named rather than only summed into {@link EventLogs.trouble}, because the panel
   * answers per generator: a cursor log that would not load and a click log that was
   * never captured are two different sentences on two different rows, and a single
   * prose line cannot be split back into them.
   */
  unreadable: readonly EventLogName[];
  /**
   * The same fact as one sentence for a person — and `null` for a recording that
   * simply has no logs.
   *
   * The distinction is phase 5's, applied one layer out. *"No cursor log"* and *"an
   * empty cursor log"* are required to mean different things (§7.3, research trap 2),
   * and so are *"this recording has no logs"* and *"its logs are unreadable"*: the
   * first is the ordinary state of every recording made before the sampler was wired
   * in and of any recording on a machine that declined Accessibility, and reporting
   * it as trouble puts a warning on an editor where nothing is wrong. Which
   * generators can run is said by {@link GeneratorState.reason}, in the panel that
   * offers them, where the person is looking.
   */
  trouble: string | null;
}

/** The sentence a log that would not load earns, in one place so both callers agree. */
export function describeUnreadable(names: readonly EventLogName[]): string {
  return `This recording says it has ${names.join(' and ')} events, and they could not be read.`;
}

/**
 * What the panel reads when the read itself threw, rather than when a log is absent.
 *
 * Every log **unreadable**, never absent. A failure to read is not evidence that
 * nothing was captured, and the one sentence this window must never show is one
 * blaming a permission the user granted for a log this build simply could not open.
 */
export function unreadEventLogs(): EventLogs {
  return {
    cursor: null,
    clicks: null,
    digests: {},
    unreadable: EVENT_LOG_NAMES,
    trouble: describeUnreadable(EVENT_LOG_NAMES),
  };
}

/** What a renderer needs from the outside world to read a bundle's logs. */
export interface LogReader {
  /** `fetch`, injected so this module is testable without a protocol handler. */
  fetchText: (url: string) => Promise<string | null>;
  /** `crypto.subtle.digest('SHA-256', …)`, injected for the same reason. */
  digest: (text: string) => Promise<string>;
}

/**
 * Read both logs a recording declares.
 *
 * The **paths come from `recording.json`** (§2.5's `events.cursor.file` and
 * `events.clicks.file`) rather than being composed here, for the reason the editor
 * already reads a part's frame index that way: the document is what says where a
 * bundle's files actually are, and a recovered or older bundle is not obliged to
 * agree with a constant in a renderer.
 */
export async function readEventLogs(
  id: RecordingId,
  recording: RecordingDoc | null,
  io: LogReader,
): Promise<EventLogs> {
  const events = recording?.events;
  // A recording with no logs at all is not trouble; it is a recording nobody sampled.
  // Every generator's own `reason` says what that costs it.
  if (events === undefined) {
    return { cursor: null, clicks: null, digests: {}, unreadable: [], trouble: null };
  }
  const digests: Record<string, string> = {};
  const unreadable: EventLogName[] = [];

  let cursor: CursorSampleInput[] | null = null;
  const cursorFile = events.cursor?.file;
  if (cursorFile !== undefined) {
    const text = await io.fetchText(recordingUrl(id, cursorFile));
    if (text === null) unreadable.push('cursor');
    else {
      cursor = parseCursorLog(text);
      digests['cursor'] = await io.digest(text);
    }
  }

  let clicks: ClickEventInput[] | null = null;
  // `available` is read from the sampler rather than inferred from the file, so this
  // asks the document rather than probing for a 404 and guessing what one means.
  const clicksFile = events.clicks?.available === true ? events.clicks.file : undefined;
  if (clicksFile !== undefined) {
    const text = await io.fetchText(recordingUrl(id, clicksFile));
    if (text === null) unreadable.push('clicks');
    else {
      clicks = parseClickLog(text);
      digests['clicks'] = await io.digest(text);
    }
  }

  return {
    cursor,
    clicks,
    digests,
    unreadable,
    // Only a log the document **promised**. A missing file where `recording.json`
    // says there is one is a damaged bundle and worth saying so; a document that
    // never claimed one is not.
    trouble: unreadable.length === 0 ? null : describeUnreadable(unreadable),
  };
}

/**
 * §2.5's cursor log, as position samples.
 *
 * Lines carrying an `e` are **events** — a display reconfiguration, the click tap
 * going down — and are dropped rather than read as positions: `{"e":"display"}` has
 * no `x` and is not a cursor at the origin. A malformed line is dropped too and the
 * rest of the log is kept, because a log is a stream rather than a document (§2.5,
 * and it is why these files carry no schema line): one bad append at a crash boundary
 * must not cost the four minutes before it.
 */
export function parseCursorLog(text: string): CursorSampleInput[] {
  const out: CursorSampleInput[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['e'] !== undefined) continue;
    const t = parsed['t'];
    const x = parsed['x'];
    const y = parsed['y'];
    if (typeof t !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
    out.push({ t, x, y, c: typeof parsed['c'] === 'string' ? parsed['c'] : '' });
  }
  return out;
}

/** §2.5's click log. `e` is `'down'` or `'up'`; anything else is not a click event. */
export function parseClickLog(text: string): ClickEventInput[] {
  const out: ClickEventInput[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = parsed['t'];
    const e = parsed['e'];
    const x = parsed['x'];
    const y = parsed['y'];
    if (typeof t !== 'number' || (e !== 'down' && e !== 'up')) continue;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    out.push({ t, e, b: typeof parsed['b'] === 'number' ? parsed['b'] : 0, x, y });
  }
  return out;
}

/**
 * Whether a generator can be run — including the answer *"nobody knows yet"*.
 *
 * `reading` is a state and not a placeholder, and it is the one this type exists for.
 * Reading two NDJSON files over `loom://` and hashing them takes a few hundred
 * milliseconds on a long recording, and for that window the honest answer to *"is
 * there a click log?"* is that the question has not been asked yet. Collapsing it into
 * `unavailable` makes the panel open by saying *"No clicks were captured — the
 * Accessibility grant is what a click log needs"* over a recording with a real click
 * log, which reads as the most invasive of the four permissions having failed. Phase
 * 5 keeps *absent* and *empty* apart at the log; this keeps *absent* and *not yet
 * known* apart at the panel, and it is the same discipline for the same reason.
 */
export type GeneratorAvailability = 'reading' | 'runnable' | 'unavailable';

/**
 * What the editor offers for one generator, and why.
 *
 * `reason` is a sentence rather than a code because it is shown to a person, and
 * because the numbers that made the answer belong in it — `describeClickUnavailable`
 * sets that precedent for the one case where "no clicks" has four different meanings.
 */
export interface GeneratorState {
  type: RunnableGenerator;
  label: string;
  /** The document's track for this generator, if it has one. */
  track: Track | null;
  /** Can it be run at all — are its inputs there, and is that known yet? */
  status: GeneratorAvailability;
  /**
   * Is the existing track still a faithful function of its inputs (§3.5)?
   *
   * `null` while the logs are being read, because staleness is a digest comparison
   * and the digests are what is outstanding: asked against an empty set it answers
   * `input-missing`, and *"the cursor log this was generated from is no longer
   * there"* is the same lie one channel over.
   */
  staleness: StalenessReport | null;
  /** A baked track is detached from regeneration and must never be offered one. */
  baked: boolean;
  reason: string;
}

/**
 * Read the document and the logs into the state every generator control renders from.
 *
 * `logs` is `EventLogs | null`, and the `null` is load-bearing: it is what the caller
 * holds before {@link readEventLogs} resolves, and substituting an empty `EventLogs`
 * for it there is exactly the erasure {@link GeneratorAvailability} exists to prevent.
 */
export function generatorStates(doc: EditDocument, logs: EventLogs | null): GeneratorState[] {
  return RUNNABLE_GENERATORS.map((type) => {
    const id = GENERATOR_TRACK_ID[type];
    const track = doc.tracks.find((t) => t.id === id) ?? null;
    const baked = track !== null && track.origin === 'manual' && track.generatedFrom !== undefined;
    const needs = logs === null ? null : type === 'cursor-follow' ? logs.cursor : logs.clicks;
    const status: GeneratorAvailability =
      logs === null ? 'reading' : needs !== null && needs.length > 0 ? 'runnable' : 'unavailable';
    return {
      type,
      label: GENERATOR_LABEL[type],
      track,
      status,
      staleness:
        logs !== null && track !== null && isRegenerable(track)
          ? generatedTrackStaleness(track, logs.digests)
          : null,
      baked,
      reason: reasonFor(type, status, logs),
    };
  });
}

/** The sentence one generator's row shows under its title, or `''` when it can run. */
function reasonFor(
  type: RunnableGenerator,
  status: GeneratorAvailability,
  logs: EventLogs | null,
): string {
  if (status === 'runnable') return '';
  if (status === 'reading' || logs === null) return 'Reading this recording’s event logs…';
  // A log the document promised and this build could not open is neither absent nor
  // empty, and saying "no clicks were captured" about one blames a permission for a
  // failure that has nothing to do with it.
  const log: EventLogName = type === 'cursor-follow' ? 'cursor' : 'clicks';
  if (logs.unreadable.includes(log)) return describeUnreadable([log]);
  if (type === 'cursor-follow') return 'This recording has no cursor samples to follow.';
  return logs.clicks === null
    ? 'No clicks were captured — the Accessibility grant is what a click log needs.'
    : 'Nobody clicked during this recording.';
}

/** What running a generator produced: the ops to send, and what to tell the user. */
export interface GeneratorRun {
  ops: EditOp[];
  /** §6.6's *"return the best attempt with a warning"*, or a refusal, already phrased. */
  warning: string | null;
  /** How many keys the new track carries — a measured number, for the inspector. */
  keyCount: number;
}

/**
 * Run one generator and produce §3.5's replacement ops.
 *
 * Everything about *what* is generated is `@loom/edl`'s: the §6.1 conditioning, the
 * §6.2 dead zone, the §6.3 spring, §6.5's five steps and the §6.6 comfort ladder. All
 * this does is hand them the parsed logs and the digests, and turn the result into
 * `regenerateOps` — which is `track.remove` + `track.add` **at the same index**,
 * because track order is stacking order and a regeneration that appended would put the
 * cursor-follow track on top of the manual zoom above it. Where a *first* run lands is
 * {@link GENERATOR_RANK}, applied by {@link placementFor}.
 *
 * `generatedAt` is left to the generator (it stamps `new Date().toISOString()`), which
 * is right here and is why both take an override: a test needs a fixed one, and a
 * product needs the real one.
 */
export function runGenerator(
  type: RunnableGenerator,
  doc: EditDocument,
  logs: EventLogs,
  init: { durationSec: number; recording: RecordingDoc | null; generatedAt?: string },
): GeneratorRun | { error: string } {
  const trackId = GENERATOR_TRACK_ID[type];
  const generatedAt = init.generatedAt;

  if (type === 'cursor-follow') {
    if (logs.cursor === null || logs.cursor.length === 0) {
      return { error: 'This recording has no cursor samples to follow.' };
    }
    const result = generateCursorFollow({
      cursor: arrayCursorStream(logs.cursor),
      trackId,
      inputs: pick(logs.digests, ['cursor']),
      durationSec: init.durationSec,
      ...(generatedAt === undefined ? {} : { generatedAt }),
    });
    return {
      ops: regenerateOps(doc, result.track, placementFor(doc, type)),
      warning: result.warning,
      keyCount: countKeys(result.track),
    };
  }

  // `recording.json`, not the log: it is what says whether the tap was ever live, and
  // `clickSourceFrom` is the one function allowed to turn "no file" and "an empty
  // file" into the single answer a generator sees.
  const source = clickSourceFrom(
    init.recording,
    logs.clicks === null ? null : arrayClickStream(logs.clicks),
  );
  const result = generateAutoZoom({
    clicks: source,
    ...(logs.cursor === null ? {} : { cursor: arrayCursorStream(logs.cursor) }),
    trackId,
    inputs: pick(logs.digests, ['clicks', 'cursor']),
    durationSec: init.durationSec,
    ...(generatedAt === undefined ? {} : { generatedAt }),
  });
  if (!result.ok) return { error: result.message };
  return {
    ops: regenerateOps(doc, result.track, placementFor(doc, type)),
    // `empty` is a real answer and not a failure: the tap was live and nobody clicked,
    // so the track is legitimately a track with no segments in it. Saying so beats a
    // silent no-op, which is indistinguishable from a button that does not work.
    warning: result.empty
      ? 'No clicks in this recording, so there is nothing to zoom to. The track was placed empty.'
      : null,
    keyCount: countKeys(result.track),
  };
}

/**
 * §3.5's bake, as ops — one `track.patch` whose `remove` survives `JSON.stringify`.
 *
 * `@loom/edl`'s `bakeOps` is the whole of it and is not wrapped for the sake of
 * wrapping: it is re-exported so the editor has one import for the generator
 * lifecycle, and so that the reason bake removes the block *by name* stays one hop
 * from the caller. (`patch.remove`, because a key set to `undefined` is dropped by
 * `JSON.stringify` and reaches the journal as `"patch":{}` — an undo that replays as a
 * no-op and brings the generator block back.)
 */
export { bakeOps, isRegenerable };

/**
 * Whether a generated track's inputs have changed under it — the sentence, not the flag.
 *
 * §3.5: *"If the cursor log's hash no longer matches, the UI shows 'regenerate' rather
 * than silently serving stale motion."* This is what that shows.
 */
export function describeStaleness(state: GeneratorState): string {
  const report = state.staleness;
  if (report?.stale !== true) return '';
  if (report.reasons.includes('input-missing')) {
    return `The ${report.changedInputs.join(' and ')} log this was generated from is no longer there.`;
  }
  if (report.reasons.includes('input-changed')) {
    return `The ${report.changedInputs.join(' and ')} log has changed since this was generated.`;
  }
  return 'This was generated with different settings.';
}

/**
 * §3.5's placement for one generator's track, as the options `regenerateOps` takes.
 *
 * `at` is named **only when there is no track to replace**. On the replacement path
 * `regenerateOps` reads `options.at ?? existing`, and its docblock exists precisely to
 * keep a regenerated track at the index it already had — so naming one there would let
 * a *Regenerate* silently re-order the two generated tracks against each other, which
 * is the same wrong picture with a valid document that §3.5's own rule is about.
 */
function placementFor(
  doc: EditDocument,
  type: RunnableGenerator,
): { type: RunnableGenerator; at?: number } {
  const trackId = GENERATOR_TRACK_ID[type];
  const replaces = doc.tracks.some(
    (track) =>
      track.id === trackId || (track.origin === 'generated' && track.generator?.type === type),
  );
  return replaces ? { type } : { type, at: insertionIndexFor(doc, type) };
}

/**
 * Where a **new** generated track of this rank goes: above every generated track of a
 * lower rank, and below everything else — which is every manual track, because
 * `rewriteTrackOps` puts one at the end of the array.
 */
function insertionIndexFor(doc: EditDocument, type: RunnableGenerator): number {
  const rank = GENERATOR_RANK[type];
  let at = 0;
  doc.tracks.forEach((track, index) => {
    const other = rankOfTrack(track);
    if (other !== null && other < rank) at = index + 1;
  });
  return at;
}

/** The stacking rank of a track this editor generated, or `null` for anything else. */
function rankOfTrack(track: Track): number | null {
  for (const type of RUNNABLE_GENERATORS) {
    if (track.id === GENERATOR_TRACK_ID[type]) return GENERATOR_RANK[type];
  }
  return null;
}

function pick(from: Record<string, string>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = from[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function countKeys(track: Track): number {
  return Object.values(track.channels).reduce((sum, channel) => sum + channel.keys.length, 0);
}

/** `crypto.subtle` over UTF-8, as `sha256:…` — the shape §3.5's `inputs` is written in. */
export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/** `fetch` for a `loom://` text file, answering `null` for one that is not there. */
export async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Re-exported so the inspector can show what a generator would run with. */
export { DEFAULT_AUTO_ZOOM_PARAMS, DEFAULT_CURSOR_FOLLOW_PARAMS };
