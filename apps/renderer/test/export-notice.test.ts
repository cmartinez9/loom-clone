/**
 * The three things the library may say about a finished export's sources.
 *
 * `ExportResult.sourcesDeleted` has three outcomes and the row used to have two
 * sentences, so a user whose `media/` was half-removed was told *"the original
 * recording was kept"*. That is worse than saying nothing: it is a false assurance
 * about data that is partly gone, discovered only when they try to edit it.
 *
 * The branch is pure and lives in its own module for exactly this — the row renderer
 * needs a DOM and this does not, so what the user is told can be pinned in `npm test`
 * rather than eyeballed.
 */

import { describe, expect, it } from 'vitest';
import { RETENTION_COPY } from '@loom/format';
import type { ExportResult } from '@loom/ipc';
import { exportNotice } from '../src/library/export-notice.ts';

function result(overrides: Partial<ExportResult> = {}): ExportResult {
  return {
    path: '/Users/chris/Movies/Loom Clone/Exports/Demo.mp4',
    bytes: 184_221_004,
    durationSec: 312.433,
    verified: {
      exists: true,
      bytes: 184_221_004,
      durationSec: 312.433,
      lastFrameDecodable: true,
      sha256: '9f'.repeat(32),
    },
    copiedToClipboard: true,
    revealed: true,
    sourcesKept: false,
    sourcesDeleted: true,
    retentionReasons: [],
    mode: 'recompose',
    ...overrides,
  };
}

describe('what the library says when an export finishes', () => {
  it('says the recording is final when the sources really went', () => {
    const notice = exportNotice(result());
    expect(notice).toContain('/Users/chris/Movies/Loom Clone/Exports/Demo.mp4');
    expect(notice).toContain(RETENTION_COPY.exported);
  });

  it('says the recording was kept when the escape hatch left it alone', () => {
    const notice = exportNotice(
      result({
        sourcesKept: true,
        sourcesDeleted: false,
        retentionReasons: ['the export asked to keep the sources this time'],
      }),
    );
    expect(notice).toContain(RETENTION_COPY.kept);
    expect(notice).not.toContain(RETENTION_COPY.deletionFailed);
  });

  it('does not call a half-finished deletion a recording that was kept', () => {
    // The third state, and the whole reason this function exists: `applyRetention`'s
    // catch returns `deleted: false` with an `error` after a partial unlink, which is
    // the *same* `sourcesDeleted: false` the escape hatch produces. Only
    // `retentionError` tells them apart.
    const notice = exportNotice(
      result({
        sourcesDeleted: false,
        retentionReasons: ['the sources could not be deleted'],
        retentionError: 'EACCES: permission denied, scandir …/media',
      }),
    );
    expect(notice).toContain(RETENTION_COPY.deletionFailed);
    // Never the reassurance, and never the claim of finality either.
    expect(notice).not.toContain(RETENTION_COPY.kept);
    expect(notice).not.toContain(RETENTION_COPY.exported);
    // The reason is named rather than logged where nobody will look for it.
    expect(notice).toContain('EACCES: permission denied, scandir …/media');
    // And the file the user came for is still reported, because it exists.
    expect(notice).toContain('/Users/chris/Movies/Loom Clone/Exports/Demo.mp4');
  });

  it('CONTROL: an export that reported no result at all still says something', () => {
    // `progress.result` is optional on the wire. A branch that read `result.path`
    // without it would throw inside the progress handler and leave the sheet on
    // "Rendering… 100%" for ever.
    expect(exportNotice(undefined)).toBe('Exported.');
  });
});
