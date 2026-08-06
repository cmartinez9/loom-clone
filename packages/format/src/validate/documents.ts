/**
 * Document validators.
 *
 * These run on every read, after migration, and before every write. They are
 * deliberately strict about the invariants the rest of the app relies on and
 * deliberately permissive about unknown extra keys: a document written by a newer
 * build carries a newer `schema` version and is refused by the migration layer,
 * so an unknown key here means a forward-compatible addition, not corruption.
 *
 * The invariants worth naming, because other phases depend on them:
 *  - a channel never mixes spring and curve easings (architecture report §3.4 —
 *    the report calls this "a validation error" in as many words);
 *  - channel keys are sorted by `t` with unique `t`;
 *  - `activeRanges` are ordered `[start, end]` pairs;
 *  - clips have positive duration and positive speed.
 */

import { parseSchemaId, type SchemaFamily } from '../schema.ts';
import { isUlid } from '../ids.ts';
import { PROJECT_STATES, type ProjectDoc } from '../types/project.ts';
import type { RecordingDoc } from '../types/recording.ts';
import { GENERATOR_TYPES, type EditDocument } from '../types/edit.ts';
import type { FrameIndexDoc, CursorIndexDoc } from '../types/sidecar.ts';
import type { SettingsDoc } from '../types/settings.ts';
import {
  IssueSink,
  requireArray,
  requireBoolean,
  requireEnum,
  requireIsoTimestamp,
  requireNumber,
  requireObject,
  requirePair,
  requireString,
  ValidationError,
  type ValidationIssue,
} from './issues.ts';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(sink: IssueSink): ValidationResult<T> {
  return { ok: false, issues: sink.issues };
}

/** Every document begins with a well-formed `schema` of the expected family. */
function checkSchema(sink: IssueSink, doc: Record<string, unknown>, family: SchemaFamily): void {
  const parsed = parseSchemaId(doc['schema']);
  if (parsed === null) {
    sink.add('schema', `expected "${family}/<n>", got ${JSON.stringify(doc['schema'])}`);
    return;
  }
  if (parsed.family !== family) {
    sink.add('schema', `expected family "${family}", got "${parsed.family}"`);
  }
}

// ---------------------------------------------------------------- project.json

export function validateProjectDoc(input: unknown): ValidationResult<ProjectDoc> {
  const sink = new IssueSink();
  const doc = requireObject(sink, input, '');
  if (doc === null) return fail(sink);

  checkSchema(sink, doc, 'loom.project');
  requireString(sink, doc['appVersion'], 'appVersion');
  const id = requireString(sink, doc['id'], 'id');
  if (id !== null && !isUlid(id)) sink.add('id', `expected a ULID, got ${JSON.stringify(id)}`);
  requireString(sink, doc['name'], 'name');
  requireIsoTimestamp(sink, doc['createdAt'], 'createdAt');
  requireIsoTimestamp(sink, doc['modifiedAt'], 'modifiedAt');
  requireEnum(sink, doc['state'], 'state', PROJECT_STATES);

  const rev = requireNumber(sink, doc['editRevision'], 'editRevision');
  if (rev !== null && (!Number.isInteger(rev) || rev < 0)) {
    sink.add('editRevision', 'expected a non-negative integer');
  }
  const size = requireNumber(sink, doc['sizeBytes'], 'sizeBytes');
  if (size !== null && size < 0) sink.add('sizeBytes', 'expected a non-negative number');

  const exports = requireArray(sink, doc['exports'], 'exports');
  if (exports !== null) {
    exports.forEach((entry, i) => {
      validateExportRecord(sink, entry, `exports[${String(i)}]`);
    });
  }

  if (doc['retention'] !== undefined) {
    const r = requireObject(sink, doc['retention'], 'retention');
    if (r !== null) {
      requireIsoTimestamp(sink, r['sourcesDeletedAt'], 'retention.sourcesDeletedAt');
      requireEnum(sink, r['reason'], 'retention.reason', ['export-verified'] as const);
    }
  }
  if (doc['error'] !== undefined) requireString(sink, doc['error'], 'error');

  // The retention decision made this an invariant, not a nicety: an `exported`
  // recording is one whose sources are gone (captain decision 5, §7.5).
  if (doc['state'] === 'exported' && doc['retention'] === undefined) {
    sink.add('retention', 'state "exported" requires a retention record');
  }

  return sink.ok ? ok(input as ProjectDoc) : fail(sink);
}

function validateExportRecord(sink: IssueSink, input: unknown, path: string): void {
  const e = requireObject(sink, input, path);
  if (e === null) return;
  requireString(sink, e['id'], `${path}.id`);
  requireString(sink, e['path'], `${path}.path`);
  requireIsoTimestamp(sink, e['completedAt'], `${path}.completedAt`);
  requireBoolean(sink, e['sourcesKept'], `${path}.sourcesKept`);

  const s = requireObject(sink, e['settings'], `${path}.settings`);
  if (s !== null) {
    for (const key of ['width', 'height', 'fps', 'bitrate'] as const) {
      const n = requireNumber(sink, s[key], `${path}.settings.${key}`);
      if (n !== null && n <= 0) sink.add(`${path}.settings.${key}`, 'expected a positive number');
    }
  }

  if (e['verified'] !== undefined) {
    const v = requireObject(sink, e['verified'], `${path}.verified`);
    if (v !== null) {
      requireBoolean(sink, v['exists'], `${path}.verified.exists`);
      requireNumber(sink, v['bytes'], `${path}.verified.bytes`);
      requireNumber(sink, v['durationSec'], `${path}.verified.durationSec`);
      requireBoolean(sink, v['lastFrameDecodable'], `${path}.verified.lastFrameDecodable`);
      requireString(sink, v['sha256'], `${path}.verified.sha256`);
    }
  }
  if (e['error'] !== undefined) requireString(sink, e['error'], `${path}.error`);
}

// -------------------------------------------------------------- recording.json

export function validateRecordingDoc(input: unknown): ValidationResult<RecordingDoc> {
  const sink = new IssueSink();
  const doc = requireObject(sink, input, '');
  if (doc === null) return fail(sink);

  checkSchema(sink, doc, 'loom.recording');

  const clock = requireObject(sink, doc['clock'], 'clock');
  if (clock !== null) {
    requireEnum(sink, clock['kind'], 'clock.kind', ['videoframe-timestamp-us'] as const);
    requireNumber(sink, clock['t0Us'], 'clock.t0Us');
  }

  const display = requireObject(sink, doc['display'], 'display');
  if (display !== null) {
    requireNumber(sink, display['id'], 'display.id');
    requireString(sink, display['name'], 'display.name');
    requirePair(sink, display['logicalSize'], 'display.logicalSize');
    requirePair(sink, display['pixelSize'], 'display.pixelSize');
    requireNumber(sink, display['scaleFactor'], 'display.scaleFactor');
    requireString(sink, display['colorSpace'], 'display.colorSpace');
  }

  const tracks = requireObject(sink, doc['tracks'], 'tracks');
  if (tracks !== null) {
    for (const [key, value] of Object.entries(tracks)) {
      validateRecordingTrack(sink, value, `tracks.${key}`);
    }
  }

  requireObject(sink, doc['events'], 'events');

  const capture = requireObject(sink, doc['capture'], 'capture');
  if (capture !== null) {
    requireString(sink, capture['app'], 'capture.app');
    requireString(sink, capture['os'], 'capture.os');
    requireObject(sink, capture['permissions'], 'capture.permissions');
    requireNumber(sink, capture['requestedFps'], 'capture.requestedFps');
  }

  const integrity = requireObject(sink, doc['integrity'], 'integrity');
  if (integrity !== null) {
    if (integrity['finalizedAt'] !== null) {
      requireIsoTimestamp(sink, integrity['finalizedAt'], 'integrity.finalizedAt');
    }
    requireBoolean(sink, integrity['recoveredFromCrash'], 'integrity.recoveredFromCrash');
    if (integrity['truncatedToSec'] !== null) {
      requireNumber(sink, integrity['truncatedToSec'], 'integrity.truncatedToSec');
    }
  }

  return sink.ok ? ok(input as RecordingDoc) : fail(sink);
}

function validateRecordingTrack(sink: IssueSink, input: unknown, path: string): void {
  const track = requireObject(sink, input, path);
  if (track === null) return;
  const kind = requireEnum(sink, track['kind'], `${path}.kind`, ['video', 'audio'] as const);
  const parts = requireArray(sink, track['parts'], `${path}.parts`);
  if (parts === null) return;
  if (parts.length === 0) {
    sink.add(`${path}.parts`, 'a track must have at least one part');
  }
  parts.forEach((part, i) => {
    const p = `${path}.parts[${String(i)}]`;
    const obj = requireObject(sink, part, p);
    if (obj === null) return;
    requireString(sink, obj['file'], `${p}.file`);
    requireString(sink, obj['codec'], `${p}.codec`);
    // Per-track startTimeSec is not optional. Screen, camera and mic start at
    // genuinely different instants; this is the A/V sync mechanism (§5.4).
    requireNumber(sink, obj['startTimeSec'], `${p}.startTimeSec`);
    const dur = requireNumber(sink, obj['durationSec'], `${p}.durationSec`);
    if (dur !== null && dur < 0) sink.add(`${p}.durationSec`, 'expected a non-negative number');
    requireBoolean(sink, obj['endedEarly'], `${p}.endedEarly`);

    if (kind === 'video') {
      requireString(sink, obj['index'], `${p}.index`);
      requirePair(sink, obj['size'], `${p}.size`);
      requireNumber(sink, obj['frameCount'], `${p}.frameCount`);
      const rate = requireObject(sink, obj['rate'], `${p}.rate`);
      if (rate !== null) {
        requireEnum(sink, rate['mode'], `${p}.rate.mode`, ['variable', 'constant'] as const);
        requireNumber(sink, rate['nominalFps'], `${p}.rate.nominalFps`);
        requireNumber(sink, rate['observedFps'], `${p}.rate.observedFps`);
      }
    } else if (kind === 'audio') {
      requireNumber(sink, obj['sampleRate'], `${p}.sampleRate`);
      requireNumber(sink, obj['channels'], `${p}.channels`);
      requireNumber(sink, obj['measuredSampleRate'], `${p}.measuredSampleRate`);
      const gaps = requireArray(sink, obj['gaps'], `${p}.gaps`);
      gaps?.forEach((gap, gi) => {
        const gp = `${p}.gaps[${String(gi)}]`;
        const g = requireObject(sink, gap, gp);
        if (g === null) return;
        requireNumber(sink, g['atSec'], `${gp}.atSec`);
        requireNumber(sink, g['durationSec'], `${gp}.durationSec`);
        requireString(sink, g['cause'], `${gp}.cause`);
      });
    }
  });
}

// ------------------------------------------------------------------- edit.json

const EASE_KINDS = ['hold', 'linear', 'cubic', 'spring'] as const;

export function validateEditDocument(input: unknown): ValidationResult<EditDocument> {
  const sink = new IssueSink();
  const doc = requireObject(sink, input, '');
  if (doc === null) return fail(sink);

  checkSchema(sink, doc, 'loom.edit');

  const rev = requireNumber(sink, doc['revision'], 'revision');
  if (rev !== null && (!Number.isInteger(rev) || rev < 0)) {
    sink.add('revision', 'expected a non-negative integer');
  }

  const output = requireObject(sink, doc['output'], 'output');
  if (output !== null) {
    const size = requirePair(sink, output['size'], 'output.size');
    if (size !== null && (size[0] <= 0 || size[1] <= 0)) {
      sink.add('output.size', 'expected positive dimensions');
    }
    const fps = requireNumber(sink, output['fps'], 'output.fps');
    if (fps !== null && fps <= 0) sink.add('output.fps', 'expected a positive number');
    const bg = requireObject(sink, output['background'], 'output.background');
    if (bg !== null) requireEnum(sink, bg['kind'], 'output.background.kind', ['none', 'color']);
  }

  const clips = requireArray(sink, doc['clips'], 'clips');
  clips?.forEach((clip, i) => {
    const p = `clips[${String(i)}]`;
    const c = requireObject(sink, clip, p);
    if (c === null) return;
    requireString(sink, c['id'], `${p}.id`);
    const start = requireNumber(sink, c['sourceStart'], `${p}.sourceStart`);
    const end = requireNumber(sink, c['sourceEnd'], `${p}.sourceEnd`);
    if (start !== null && end !== null && end <= start) {
      sink.add(p, `sourceEnd (${String(end)}) must be greater than sourceStart (${String(start)})`);
    }
    const speed = requireNumber(sink, c['speed'], `${p}.speed`);
    if (speed !== null && speed <= 0) sink.add(`${p}.speed`, 'expected a positive number');
  });

  const tracks = requireArray(sink, doc['tracks'], 'tracks');
  const seenIds = new Set<string>();
  tracks?.forEach((track, i) => {
    validateTrack(sink, track, `tracks[${String(i)}]`, seenIds);
  });

  return sink.ok ? ok(input as EditDocument) : fail(sink);
}

function validateTrack(sink: IssueSink, input: unknown, path: string, seenIds: Set<string>): void {
  const t = requireObject(sink, input, path);
  if (t === null) return;

  const id = requireString(sink, t['id'], `${path}.id`);
  if (id !== null) {
    if (seenIds.has(id)) sink.add(`${path}.id`, `duplicate track id ${JSON.stringify(id)}`);
    seenIds.add(id);
  }
  requireEnum(sink, t['kind'], `${path}.kind`, ['clips', 'transform', 'object', 'audio'] as const);
  requireString(sink, t['target'], `${path}.target`);
  requireEnum(sink, t['domain'], `${path}.domain`, ['source', 'timeline'] as const);
  requireEnum(sink, t['origin'], `${path}.origin`, ['manual', 'generated'] as const);
  requireEnum(sink, t['blend'], `${path}.blend`, ['replace', 'add', 'multiply'] as const);
  const blendMs = requireNumber(sink, t['blendMs'], `${path}.blendMs`);
  if (blendMs !== null && blendMs < 0)
    sink.add(`${path}.blendMs`, 'expected a non-negative number');
  requireBoolean(sink, t['enabled'], `${path}.enabled`);

  const ranges = requireArray(sink, t['activeRanges'], `${path}.activeRanges`);
  ranges?.forEach((range, i) => {
    const rp = `${path}.activeRanges[${String(i)}]`;
    const pair = requirePair(sink, range, rp);
    if (pair !== null && pair[1] < pair[0]) sink.add(rp, 'range end precedes range start');
  });

  const channels = requireObject(sink, t['channels'], `${path}.channels`);
  if (channels !== null) {
    for (const [name, channel] of Object.entries(channels)) {
      validateChannel(sink, channel, `${path}.channels.${name}`);
    }
  }

  if (t['spans'] !== undefined) {
    const spans = requireArray(sink, t['spans'], `${path}.spans`);
    spans?.forEach((span, i) => {
      const sp = `${path}.spans[${String(i)}]`;
      const s = requireObject(sink, span, sp);
      if (s === null) return;
      requireString(sink, s['id'], `${sp}.id`);
      requireString(sink, s['type'], `${sp}.type`);
      const start = requireNumber(sink, s['start'], `${sp}.start`);
      const end = requireNumber(sink, s['end'], `${sp}.end`);
      if (start !== null && end !== null && end < start) {
        sink.add(sp, 'span end precedes span start');
      }
      if (s['channels'] !== undefined) {
        const sc = requireObject(sink, s['channels'], `${sp}.channels`);
        if (sc !== null) {
          for (const [name, channel] of Object.entries(sc)) {
            validateChannel(sink, channel, `${sp}.channels.${name}`);
          }
        }
      }
    });
  }

  if (t['generator'] !== undefined) validateGenerator(sink, t['generator'], `${path}.generator`);
  if (t['generatedFrom'] !== undefined) {
    validateGenerator(sink, t['generatedFrom'], `${path}.generatedFrom`);
  }
}

function validateGenerator(sink: IssueSink, input: unknown, path: string): void {
  const g = requireObject(sink, input, path);
  if (g === null) return;
  requireEnum(sink, g['type'], `${path}.type`, GENERATOR_TYPES);
  requireObject(sink, g['params'], `${path}.params`);
  requireObject(sink, g['inputs'], `${path}.inputs`);
  requireIsoTimestamp(sink, g['generatedAt'], `${path}.generatedAt`);
}

function validateChannel(sink: IssueSink, input: unknown, path: string): void {
  const c = requireObject(sink, input, path);
  if (c === null) return;

  const keys = requireArray(sink, c['keys'], `${path}.keys`);
  if (keys === null) return;

  let previousT: number | null = null;
  let springKeys = 0;
  let curveKeys = 0;

  keys.forEach((key, i) => {
    const kp = `${path}.keys[${String(i)}]`;
    const k = requireObject(sink, key, kp);
    if (k === null) return;

    const t = requireNumber(sink, k['t'], `${kp}.t`);
    if (t !== null) {
      if (previousT !== null && t <= previousT) {
        sink.add(
          kp,
          `keys must be sorted by t with unique t (${String(t)} follows ${String(previousT)})`,
        );
      }
      previousT = t;
    }

    const v = k['v'];
    if (typeof v !== 'number' && !Array.isArray(v)) {
      sink.add(`${kp}.v`, 'expected a number or an array of numbers');
    } else if (Array.isArray(v) && !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      sink.add(`${kp}.v`, 'expected an array of finite numbers');
    } else if (typeof v === 'number' && !Number.isFinite(v)) {
      sink.add(`${kp}.v`, 'expected a finite number');
    }

    const ease = requireObject(sink, k['ease'], `${kp}.ease`);
    if (ease === null) return;
    const kind = requireEnum(sink, ease['kind'], `${kp}.ease.kind`, EASE_KINDS);
    if (kind === 'spring') springKeys++;
    else if (kind !== null) curveKeys++;
    if (kind === 'cubic') {
      requirePair(sink, ease['p1'], `${kp}.ease.p1`);
      requirePair(sink, ease['p2'], `${kp}.ease.p2`);
    }
  });

  // Architecture report §3.4: a channel is evaluated either pointwise as a curve
  // or as a spring integrated on a fixed 8 ms grid, and mixing the two within one
  // channel is a validation error. It is stated here rather than discovered in the
  // compositor, because the two evaluators disagree by a measured 82.6 px.
  if (springKeys > 0 && curveKeys > 0) {
    sink.add(
      path,
      `channel mixes spring and curve easings (${String(springKeys)} spring, ${String(curveKeys)} curve); ` +
        'a channel must be entirely one or the other',
    );
  }
  if (springKeys > 0 && c['spring'] === undefined) {
    sink.add(`${path}.spring`, 'a spring channel must carry spring parameters');
  }
  if (c['spring'] !== undefined) {
    const s = requireObject(sink, c['spring'], `${path}.spring`);
    if (s !== null) {
      for (const key of ['tension', 'mass', 'friction'] as const) {
        const n = requireNumber(sink, s[key], `${path}.spring.${key}`);
        if (n !== null && n <= 0) sink.add(`${path}.spring.${key}`, 'expected a positive number');
      }
    }
  }
  if (c['clamp'] !== undefined) {
    const clamp = requirePair(sink, c['clamp'], `${path}.clamp`);
    if (clamp !== null && clamp[1] < clamp[0]) {
      sink.add(`${path}.clamp`, 'clamp maximum precedes clamp minimum');
    }
  }
}

// --------------------------------------------------------- sidecars & settings

export function validateFrameIndexDoc(input: unknown): ValidationResult<FrameIndexDoc> {
  const sink = new IssueSink();
  const doc = requireObject(sink, input, '');
  if (doc === null) return fail(sink);

  checkSchema(sink, doc, 'loom.index');
  const timescale = requireNumber(sink, doc['timescale'], 'timescale');
  if (timescale !== null && timescale <= 0) sink.add('timescale', 'expected a positive number');

  const arrays = ['keyframes', 'pts', 'sizes', 'offsets'] as const;
  const lengths: Record<string, number> = {};
  for (const name of arrays) {
    const arr = requireArray(sink, doc[name], name);
    if (arr === null) continue;
    lengths[name] = arr.length;
    if (!arr.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      sink.add(name, 'expected an array of finite numbers');
    }
  }
  // pts, sizes and offsets are parallel arrays over frames; keyframes indexes into
  // them and is therefore allowed its own length.
  const parallel = ['pts', 'sizes', 'offsets'] as const;
  const distinct = new Set(parallel.map((n) => lengths[n]).filter((n) => n !== undefined));
  if (distinct.size > 1) {
    sink.add(
      '',
      `pts, sizes and offsets must be parallel arrays of equal length (got ${parallel
        .map((n) => `${n}=${String(lengths[n])}`)
        .join(', ')})`,
    );
  }

  return sink.ok ? ok(input as FrameIndexDoc) : fail(sink);
}

export function validateCursorIndexDoc(input: unknown): ValidationResult<CursorIndexDoc> {
  const sink = new IssueSink();
  const doc = requireObject(sink, input, '');
  if (doc === null) return fail(sink);

  checkSchema(sink, doc, 'loom.cursors');
  const images = requireObject(sink, doc['images'], 'images');
  if (images !== null) {
    for (const [id, image] of Object.entries(images)) {
      const p = `images.${id}`;
      const img = requireObject(sink, image, p);
      if (img === null) continue;
      requireString(sink, img['file'], `${p}.file`);
      requirePair(sink, img['hotspot'], `${p}.hotspot`);
      requireString(sink, img['shape'], `${p}.shape`);
    }
  }
  return sink.ok ? ok(input as CursorIndexDoc) : fail(sink);
}

export function validateSettingsDoc(input: unknown): ValidationResult<SettingsDoc> {
  const sink = new IssueSink();
  const doc = requireObject(sink, input, '');
  if (doc === null) return fail(sink);
  checkSchema(sink, doc, 'loom.settings');
  const root = requireString(sink, doc['recordingsRoot'], 'recordingsRoot');
  if (root !== null && root.length === 0) sink.add('recordingsRoot', 'expected a non-empty path');

  // `setup` arrived in `loom.settings/2`. A v1 file reaching here has already been
  // through the migration chain, so the field is present or the file is malformed —
  // there is no "old file, be lenient" branch, because that branch is how a format
  // stops being a format.
  const setup = requireObject(sink, doc['setup'], 'setup');
  if (setup !== null) {
    // Both are nullable: `null` is "has not happened", which is the state a fresh
    // install is in and a perfectly valid one to persist.
    for (const key of ['completedAt', 'accessibilityOpenedAt'] as const) {
      if (setup[key] !== null) requireIsoTimestamp(sink, setup[key], `setup.${key}`);
    }
  }
  return sink.ok ? ok(input as SettingsDoc) : fail(sink);
}

// ------------------------------------------------------------------- registry

export type Validator<T> = (input: unknown) => ValidationResult<T>;

/** The validator for each schema family, so migration and I/O can look one up. */
export const VALIDATORS = {
  'loom.project': validateProjectDoc,
  'loom.recording': validateRecordingDoc,
  'loom.edit': validateEditDocument,
  'loom.index': validateFrameIndexDoc,
  'loom.cursors': validateCursorIndexDoc,
  'loom.settings': validateSettingsDoc,
} as const;

/** Validate or throw, naming the file so the message is actionable. */
export function assertValid<T>(
  what: string,
  validator: Validator<T>,
  input: unknown,
  file?: string,
): T {
  const result = validator(input);
  if (result.ok) return result.value;
  throw new ValidationError(what, result.issues, file);
}
