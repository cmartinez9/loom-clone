/**
 * Validation.
 *
 * The invariants asserted here are the ones other phases will rely on without
 * re-checking, so each test names the part of the architecture report that makes
 * it load-bearing rather than merely tidy.
 */

import { describe, expect, it } from 'vitest';
import { fixtureEdit, fixtureProject, fixtureRecording } from './helpers/fixtures.ts';
import {
  validateEditDocument,
  validateFrameIndexDoc,
  validateProjectDoc,
  validateRecordingDoc,
} from '../src/validate/documents.ts';
import { currentSchemaId } from '../src/schema.ts';
import type { EditDocument } from '../src/types/edit.ts';

function issuesOf(result: ReturnType<typeof validateEditDocument>): string[] {
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe('the fixtures are valid', () => {
  it('accepts the §2.2, §2.3 and §2.6 documents', () => {
    expect(validateProjectDoc(fixtureProject()).ok).toBe(true);
    expect(validateRecordingDoc(fixtureRecording()).ok).toBe(true);
    expect(validateEditDocument(fixtureEdit()).ok).toBe(true);
  });
});

describe('edit document invariants', () => {
  /**
   * Architecture report §3.4 calls this "a validation error" in as many words. The
   * two evaluators — pointwise curve and fixed-8ms-grid spring — diverge by a
   * measured 82.6 px at 3456 wide, so a channel that is half one and half the other
   * has no defined meaning.
   */
  it('rejects a channel that mixes spring and curve easings', () => {
    const doc = fixtureEdit();
    const channel = doc.tracks[0]?.channels['amount'];
    channel?.keys.push({ t: 30, v: 2, ease: { kind: 'linear' } });

    const issues = issuesOf(validateEditDocument(doc));
    expect(issues.join('\n')).toContain('mixes spring and curve easings');
  });

  it('rejects a spring channel with no spring parameters', () => {
    const doc: EditDocument = {
      ...fixtureEdit(),
      tracks: [
        {
          id: 't',
          kind: 'transform',
          target: 'zoom',
          domain: 'source',
          origin: 'manual',
          blend: 'replace',
          blendMs: 0,
          activeRanges: [[0, 1]],
          enabled: true,
          channels: { amount: { keys: [{ t: 0, v: 1, ease: { kind: 'spring' } }] } },
        },
      ],
    };
    expect(issuesOf(validateEditDocument(doc)).join('\n')).toContain('spring parameters');
  });

  it('rejects unsorted or duplicated keyframe times', () => {
    const doc = fixtureEdit();
    doc.tracks[1]!.channels['amount']!.keys = [
      { t: 5, v: 1, ease: { kind: 'hold' } },
      { t: 2, v: 2, ease: { kind: 'hold' } },
    ];
    expect(issuesOf(validateEditDocument(doc)).join('\n')).toContain('sorted by t');
  });

  it('rejects duplicate track ids', () => {
    const doc = fixtureEdit();
    doc.tracks.push({ ...doc.tracks[0]! });
    expect(issuesOf(validateEditDocument(doc)).join('\n')).toContain('duplicate track id');
  });

  it('rejects a clip with no duration or a non-positive speed', () => {
    const backwards = fixtureEdit();
    backwards.clips[0] = { id: 'c1', sourceStart: 10, sourceEnd: 10, speed: 1 };
    expect(issuesOf(validateEditDocument(backwards)).join('\n')).toContain('sourceEnd');

    const frozen = fixtureEdit();
    frozen.clips[0] = { id: 'c1', sourceStart: 0, sourceEnd: 10, speed: 0 };
    expect(issuesOf(validateEditDocument(frozen)).join('\n')).toContain('positive number');
  });

  it('rejects a backwards active range', () => {
    const doc = fixtureEdit();
    doc.tracks[0]!.activeRanges = [[10, 2]];
    expect(issuesOf(validateEditDocument(doc)).join('\n')).toContain('range end precedes');
  });

  it('reports every problem at once, with a path', () => {
    const result = validateEditDocument({ schema: 'loom.edit/1', revision: -1, clips: 'no' });
    expect(result.ok).toBe(false);
    const paths = result.ok ? [] : result.issues.map((i) => i.path);
    expect(paths).toContain('revision');
    expect(paths).toContain('clips');
    expect(paths).toContain('output');
  });
});

describe('project document invariants', () => {
  /** Captain decision 5 and §7.5: `exported` means the sources are gone. */
  it('rejects state "exported" without a retention record', () => {
    const result = validateProjectDoc(fixtureProject({ state: 'exported' }));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toContain('retention');
  });

  it('accepts "exported" once retention is recorded', () => {
    const result = validateProjectDoc(
      fixtureProject({
        state: 'exported',
        retention: { sourcesDeletedAt: '2026-08-04T14:47:54.010Z', reason: 'export-verified' },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an id that is not a ULID', () => {
    const result = validateProjectDoc(fixtureProject({ id: 'recording-1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a timestamp that is not ISO-8601 UTC with milliseconds', () => {
    expect(validateProjectDoc(fixtureProject({ createdAt: '2026-08-04 14:32:11' })).ok).toBe(false);
  });
});

describe('recording document invariants', () => {
  /**
   * Per-track `startTimeSec` is the whole A/V sync mechanism (§5.4, research trap
   * 11). A recording without it is not recoverable into sync later.
   */
  it('rejects a part with no startTimeSec', () => {
    const doc = fixtureRecording();
    delete (doc.tracks.screen!.parts[0] as unknown as Record<string, unknown>)['startTimeSec'];
    const result = validateRecordingDoc(doc);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toContain(
      'tracks.screen.parts[0].startTimeSec',
    );
  });

  it('rejects an audio part with no measuredSampleRate', () => {
    const doc = fixtureRecording();
    delete (doc.tracks.mic!.parts[0] as unknown as Record<string, unknown>)['measuredSampleRate'];
    expect(validateRecordingDoc(doc).ok).toBe(false);
  });

  it('rejects a track with no parts', () => {
    const doc = fixtureRecording();
    doc.tracks.screen!.parts = [];
    expect(validateRecordingDoc(doc).ok).toBe(false);
  });

  it('keeps the two-part webcam of a device loss', () => {
    const doc = fixtureRecording();
    expect(doc.tracks.webcam?.parts).toHaveLength(2);
    expect(doc.tracks.webcam?.parts[0]?.endReason).toBe('device-lost');
    expect(validateRecordingDoc(doc).ok).toBe(true);
  });
});

describe('frame index invariants', () => {
  it('requires pts, sizes and offsets to be parallel', () => {
    const result = validateFrameIndexDoc({
      schema: currentSchemaId('loom.index'),
      timescale: 1_000_000,
      keyframes: [0, 60],
      pts: [0, 33367, 66701],
      sizes: [184221, 9044],
      offsets: [1184, 185405, 194449],
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.issues[0]?.message).toContain('parallel arrays');
  });

  it('accepts a well-formed index', () => {
    expect(
      validateFrameIndexDoc({
        schema: currentSchemaId('loom.index'),
        timescale: 1_000_000,
        keyframes: [0],
        pts: [0, 33367],
        sizes: [184221, 9044],
        offsets: [1184, 185405],
      }).ok,
    ).toBe(true);
  });
});
