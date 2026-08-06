/**
 * `mayDeleteSources`, one refusal at a time.
 *
 * The end-to-end gate is `apps/main/test/phase9-retention.test.ts`: it fails a real
 * export at each of §7.5's ten verification points and requires the sources to
 * survive every one. This file is the other half — the predicate on its own, where
 * every branch can be reached without a bundle, a window or a decoder, and where the
 * *shape* of a record that is not quite right can be stated directly.
 *
 * The bar it enforces is the one in `retention.ts`'s header: this function does not
 * re-verify anything, and it does not accept a record that merely fails to say it
 * went wrong. All five of §7.5's checks have to be *recorded as passed*, and each is
 * read separately so that a record with four of them cannot ride in on the fifth.
 */

import { describe, expect, it } from 'vitest';
import {
  RETENTION_COPY,
  RETENTION_SOURCE_DIRECTORIES,
  mayDeleteSources,
  newRetentionRecord,
  type ExportRecord,
} from '../src/index.ts';

/** An export that passed every one of §7.5's five checks. */
function verified(overrides: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: '01K1Y8',
    path: '/Users/chris/Movies/Loom Clone/Exports/Demo.mp4',
    completedAt: '2026-08-06T12:00:00.000Z',
    settings: { width: 1920, height: 1080, fps: 30, bitrate: 12_000_000 },
    verified: {
      exists: true,
      bytes: 184_221_004,
      durationSec: 312.433,
      lastFrameDecodable: true,
      sha256: '9f'.repeat(32),
    },
    sourcesKept: false,
    ...overrides,
  };
}

describe('mayDeleteSources', () => {
  it('allows a verified-good export with no escape hatch', () => {
    expect(mayDeleteSources(verified())).toEqual({ mayDelete: true, reasons: [] });
  });

  it('refuses an export that recorded a failure', () => {
    const verdict = mayDeleteSources(verified({ error: 'the last frame does not decode' }));
    expect(verdict.mayDelete).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/does not decode/);
  });

  it('refuses an export with no verification record at all', () => {
    // The shape an export that failed before the file existed leaves behind — an
    // encoder this machine cannot configure, a renderer that died. Not five checks
    // that failed: five that never ran.
    const record = verified();
    delete record.verified;
    const verdict = mayDeleteSources(record);
    expect(verdict.mayDelete).toBe(false);
    expect(verdict.reasons).toContain('the export carries no verification record');
  });

  it('honours the escape hatch, and says which reason it is', () => {
    const verdict = mayDeleteSources(verified({ sourcesKept: true }));
    expect(verdict.mayDelete).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/keep the sources/);
  });

  it('refuses each of the five checks on its own', () => {
    // One field at a time, because the failure that matters is a record that is
    // *nearly* good: `error === undefined` alone would let every one of these
    // through, and each of them is a file the user's only copy must not be deleted
    // on the strength of.
    const cases: [Partial<ExportRecord['verified'] & object>, RegExp][] = [
      [{ exists: false }, /did not find the exported file/],
      [{ bytes: 0 }, /is empty/],
      [{ durationSec: 0 }, /no duration/],
      [{ lastFrameDecodable: false }, /last frame .* did not decode/],
      [{ sha256: '' }, /never verified/],
    ];
    for (const [patch, expected] of cases) {
      const record = verified();
      record.verified = { ...verified().verified!, ...patch };
      const verdict = mayDeleteSources(record);
      expect(verdict.mayDelete, JSON.stringify(patch)).toBe(false);
      expect(verdict.reasons.join(' '), JSON.stringify(patch)).toMatch(expected);
    }
  });

  it('reports every reason rather than the first', () => {
    // A caller explaining why a recording is still editable should be able to say
    // all of it — the shape `streamCopyEligibility` already uses.
    const verdict = mayDeleteSources(verified({ sourcesKept: true, error: 'cancelled' }));
    expect(verdict.reasons.length).toBeGreaterThan(1);
  });
});

describe('what a verified export takes with it', () => {
  it('is §7.5’s two directories and nothing else', () => {
    // Architecture report §7.5: "then unlink `media/` and `events/`". `cursors/` and
    // `thumbs/` are not named there and are not ours to add — the poster is what the
    // library card for an exported recording still shows.
    expect(RETENTION_SOURCE_DIRECTORIES).toEqual(['media', 'events']);
  });

  it('records why the sources went, not merely that they did', () => {
    const record = newRetentionRecord('2026-08-06T12:00:02.010Z');
    expect(record).toEqual({
      sourcesDeletedAt: '2026-08-06T12:00:02.010Z',
      reason: 'export-verified',
    });
  });
});

describe('§7.5 obligation 2 — the words the user is shown', () => {
  it('states the consequence in the report’s own terms', () => {
    // Not a paraphrase: §7.5 quotes this sentence, and the point of it is that "can
    // no longer be edited" and "will be deleted" are both said, before the button.
    expect(RETENTION_COPY.warning).toContain('can no longer be edited');
    expect(RETENTION_COPY.warning).toContain('will be deleted');
    expect(RETENTION_COPY.warning).toContain('screen, camera, audio and cursor');
  });

  it('offers the escape hatch and says what each answer buys', () => {
    expect(RETENTION_COPY.keepLabel).toMatch(/keep/i);
    expect(RETENTION_COPY.keepHint).toMatch(/editable/);
    // The other half of the choice: leaving it off is a decision too, and what it
    // buys is that a failed export deletes nothing.
    expect(RETENTION_COPY.deleteHint).toMatch(/failed export deletes nothing/);
  });
});
