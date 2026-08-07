/**
 * §7.2's arithmetic and §7.1's and §7.2's sentences, pinned.
 *
 * The decisions here are the ones that stop a recording and refuse to start one, and
 * the copy is what a user is told about their own disk and their own recovered
 * footage. Both are the `RETENTION_COPY` bargain: what somebody is told is a test
 * failure to change rather than an edit nobody notices.
 *
 * The *behaviour* — a real recording stopping cleanly with a playable file — is
 * `apps/main/test/phase13-disk.test.ts`. This is the half that can be checked without
 * a volume.
 */

import { describe, expect, it } from 'vitest';
import {
  DISK_COPY,
  DISK_THRESHOLDS,
  REFERENCE_CAPTURE_RATE_BYTES_PER_SEC,
  RECOVERY_COPY,
  classifyDisk,
  diskRefusesStart,
  diskRequiresStop,
  measureCaptureRate,
  type CaptureRate,
  type RecoveryReport,
} from '../src/index.ts';
import type { RecordingSummary } from '@loom/format';

const GB = 1_000_000_000;

/** The reference rate, as a `CaptureRate`, for tests about bytes rather than rates. */
const REFERENCE: CaptureRate = {
  bytesPerSec: REFERENCE_CAPTURE_RATE_BYTES_PER_SEC,
  source: 'reference',
  sampleCount: 0,
};

function summary(patch: Partial<RecordingSummary>): RecordingSummary {
  return {
    id: 'rec-1',
    path: '/tmp/rec-1.loomrec',
    name: 'Untitled',
    createdAt: '2026-08-06T00:00:00.000Z',
    modifiedAt: '2026-08-06T00:00:00.000Z',
    state: 'editable',
    sizeBytes: 0,
    durationSec: null,
    exportPath: null,
    sourcesDeleted: false,
    ...patch,
  };
}

describe("§7.2's thresholds", () => {
  it("is the report's own three numbers", () => {
    // The point of asserting a constant against a literal is that the literal is
    // §7.2's, so a change to the constant has to argue with the report rather than
    // slide past as a tuning.
    expect(DISK_THRESHOLDS.refuseStartBytes).toBe(3 * GB);
    expect(DISK_THRESHOLDS.bannerBytes).toBe(5 * GB);
    expect(DISK_THRESHOLDS.stopBytes).toBe(1 * GB);
    expect(DISK_THRESHOLDS.bannerHeadroomSec).toBe(120);
    expect(DISK_THRESHOLDS.pollIntervalMs).toBe(2_000);
  });

  it('leaves the preflight floor strictly between the stop and the banner', () => {
    // Not decoration: a floor at or above the banner would make the banner
    // unreachable at the start of a recording, and one at or below the stop would
    // let a recording start that the monitor stops on its first poll.
    expect(DISK_THRESHOLDS.stopBytes).toBeLessThan(DISK_THRESHOLDS.refuseStartBytes);
    expect(DISK_THRESHOLDS.refuseStartBytes).toBeLessThan(DISK_THRESHOLDS.bannerBytes);
  });
});

describe('classifyDisk', () => {
  it('bands free space the way §7.2 does', () => {
    expect(classifyDisk({ freeBytes: 40 * GB, totalBytes: 500 * GB }, REFERENCE).level).toBe('ok');
    expect(classifyDisk({ freeBytes: 4 * GB, totalBytes: 500 * GB }, REFERENCE).level).toBe('low');
    expect(classifyDisk({ freeBytes: 0.5 * GB, totalBytes: 500 * GB }, REFERENCE).level).toBe(
      'critical',
    );
  });

  it("implements §7.2's headroom clause, which fires only above 2.5 GB/min", () => {
    // 6 GB is above §7.2's 5 GB floor, so the byte clause says nothing here and the
    // banding is the headroom clause's alone. It takes 3 GB/min to put two minutes
    // of headroom above 5 GB, which is what this rate is.
    const absurd: CaptureRate = {
      bytesPerSec: (3600 * 1_000_000) / 60,
      source: 'measured',
      sampleCount: 3,
    };
    const reading = classifyDisk({ freeBytes: 6 * GB, totalBytes: 500 * GB }, absurd);
    expect(reading.capacitySec).toBeLessThan(DISK_THRESHOLDS.bannerHeadroomSec);
    expect(reading.level).toBe('low');

    // The control: the same 6 GB at the reference rate is `ok`, so the assertion
    // above is about the rate and not about 6 GB.
    expect(classifyDisk({ freeBytes: 6 * GB, totalBytes: 500 * GB }, REFERENCE).level).toBe('ok');
  });

  it("is dominated by §7.2's byte floors at every rate §5.6 measured", () => {
    // The finding, pinned rather than papered over: §5.6's *worst* content is
    // 146.2 MB/min (full-screen animation at 25 Mbps, which the report itself calls
    // a synthetic case). Two minutes of that is 292 MB — far below the 1 GB stop —
    // so the headroom clause can never be what raises the banner or calls the stop
    // on a capture this app produces. See `classifyDisk`'s docblock.
    const worst: CaptureRate = {
      bytesPerSec: (146.2 * 1_000_000) / 60,
      source: 'measured',
      sampleCount: 10,
    };
    expect(DISK_THRESHOLDS.bannerHeadroomSec * worst.bytesPerSec).toBeLessThan(
      DISK_THRESHOLDS.stopBytes,
    );
    // ...so at the banner floor exactly, the worst measured content still has far
    // more than two minutes and the band comes from the bytes.
    const atFloor = classifyDisk(
      { freeBytes: DISK_THRESHOLDS.bannerBytes, totalBytes: 500 * GB },
      worst,
    );
    expect(atFloor.level).toBe('ok');
    expect(atFloor.capacitySec).toBeGreaterThan(DISK_THRESHOLDS.bannerHeadroomSec);
  });

  it('stops on bytes alone, whatever the rate estimate says', () => {
    // The rule §7.2 exists for is that a write must never fail, and the rate is the
    // one input that could be wrong in the direction that lets it. So a stupendously
    // slow rate — which would report hours of headroom — must not rescue 0.5 GB.
    const slow: CaptureRate = { bytesPerSec: 1000, source: 'measured', sampleCount: 9 };
    const reading = classifyDisk({ freeBytes: 0.5 * GB, totalBytes: 500 * GB }, slow);
    expect(reading.capacitySec).toBeGreaterThan(100_000);
    expect(reading.level).toBe('critical');
    expect(diskRequiresStop(reading)).toBe(true);
  });

  it('reports a reading it could not take as unknown, never as full', () => {
    const reading = classifyDisk(null, REFERENCE);
    expect(reading.level).toBe('unknown');
    expect(reading.space).toBeNull();
    expect(reading.capacitySec).toBeNull();
    // The whole reason `unknown` exists: an instrument that failed must not refuse a
    // recording and must not stop one.
    expect(diskRefusesStart(reading)).toBe(false);
    expect(diskRequiresStop(reading)).toBe(false);
  });

  it('substitutes the reference figure for a non-positive rate rather than dividing by it', () => {
    const broken: CaptureRate = { bytesPerSec: 0, source: 'reference', sampleCount: 0 };
    const reading = classifyDisk({ freeBytes: 40 * GB, totalBytes: 500 * GB }, broken);
    expect(Number.isFinite(reading.capacitySec)).toBe(true);
    expect(reading.capacitySec).toBeCloseTo((40 * GB) / REFERENCE_CAPTURE_RATE_BYTES_PER_SEC, 3);
  });
});

describe('diskRefusesStart', () => {
  it("refuses below §7.2's 3 GB and allows at it", () => {
    const at = classifyDisk(
      { freeBytes: DISK_THRESHOLDS.refuseStartBytes, totalBytes: 500 * GB },
      REFERENCE,
    );
    const below = classifyDisk(
      { freeBytes: DISK_THRESHOLDS.refuseStartBytes - 1, totalBytes: 500 * GB },
      REFERENCE,
    );
    expect(diskRefusesStart(at)).toBe(false);
    expect(diskRefusesStart(below)).toBe(true);
  });

  it('allows a start inside the banner band, which then banners', () => {
    // §7.2 read literally: 4 GB starts and warns. A refusal here would turn the
    // warning into a wall the report does not ask for.
    const reading = classifyDisk({ freeBytes: 4 * GB, totalBytes: 500 * GB }, REFERENCE);
    expect(diskRefusesStart(reading)).toBe(false);
    expect(reading.level).toBe('low');
  });
});

describe('measureCaptureRate', () => {
  it("answers from the user's own recordings, weighted by seconds", () => {
    const rate = measureCaptureRate([
      summary({ id: 'a', sizeBytes: 100_000_000, durationSec: 100 }),
      summary({ id: 'b', sizeBytes: 900_000_000, durationSec: 900 }),
    ]);
    expect(rate.source).toBe('measured');
    expect(rate.sampleCount).toBe(2);
    expect(rate.bytesPerSec).toBeCloseTo(1_000_000, 6);
  });

  it('weights by seconds rather than averaging rates', () => {
    // A five-second test recording at a wild rate must not outvote twenty minutes of
    // real work. An unweighted mean of the two rates would be ~10.5 MB/s; the
    // weighted answer is ~1.1 MB/s.
    const rate = measureCaptureRate([
      summary({ id: 'tiny', sizeBytes: 100_000_000, durationSec: 5 }),
      summary({ id: 'real', sizeBytes: 1_200_000_000, durationSec: 1200 }),
    ]);
    expect(rate.bytesPerSec).toBeLessThan(2_000_000);
  });

  it('falls back to the research figure, and says it did', () => {
    const rate = measureCaptureRate([]);
    expect(rate.source).toBe('reference');
    expect(rate.sampleCount).toBe(0);
    expect(rate.bytesPerSec).toBeCloseTo((76.0 * 1_000_000) / 60, 6);
  });

  it('excludes what cannot answer the question honestly', () => {
    // A recording being captured has no final duration; one whose sources were
    // deleted after export has a size that no longer describes what capture wrote;
    // an unreadable bundle has no numbers at all. Each on its own must leave the
    // measurement with nothing, which is the reference figure.
    for (const patch of [
      { state: 'recording' as const, sizeBytes: 500_000_000, durationSec: 10 },
      { state: 'finalizing' as const, sizeBytes: 500_000_000, durationSec: 10 },
      { sourcesDeleted: true, sizeBytes: 500_000_000, durationSec: 10 },
      { unreadable: 'no', sizeBytes: 500_000_000, durationSec: 10 },
      { sizeBytes: 500_000_000, durationSec: 0 },
      { sizeBytes: 0, durationSec: 10 },
    ]) {
      expect(measureCaptureRate([summary(patch)]).source).toBe('reference');
    }
    // The control: the same numbers with none of those disqualifiers is measured, so
    // the loop above is about each disqualifier and not about the fixture.
    expect(measureCaptureRate([summary({ sizeBytes: 500_000_000, durationSec: 10 })]).source).toBe(
      'measured',
    );
  });
});

describe('DISK_COPY', () => {
  it('names the measurement and the floor when it refuses', () => {
    const reading = classifyDisk({ freeBytes: 2_100_000_000, totalBytes: 500 * GB }, REFERENCE);
    expect(DISK_COPY.refusal(reading)).toBe(
      'Not enough disk space to record — 2.1 GB free, and a recording needs 3.0 GB. ' +
        'Free some space and try again.',
    );
  });

  it("says §7.2's capacity in §7.2's words, and where the number came from", () => {
    const measured = classifyDisk(
      { freeBytes: 40 * GB, totalBytes: 500 * GB },
      {
        bytesPerSec: 1_000_000,
        source: 'measured',
        sampleCount: 4,
      },
    );
    expect(DISK_COPY.capacity(measured)).toBe(
      '≈ 666 min available, at what your recordings have averaged.',
    );

    const estimated = classifyDisk({ freeBytes: 3.2 * GB, totalBytes: 500 * GB }, REFERENCE);
    expect(DISK_COPY.capacity(estimated)).toBe(
      "≈ 42 min available, at a typical recording's size.",
    );

    // §7.2's own example, arrived at rather than quoted: 3.2 GB at 76 MB/min is the
    // "≈ 42 min available" the report writes down.
    expect(DISK_COPY.capacity(classifyDisk(null, REFERENCE))).toBe(
      'Free space could not be measured.',
    );
  });

  it('tells the user what will happen next in the banner', () => {
    const reading = classifyDisk({ freeBytes: 4_400_000_000, totalBytes: 500 * GB }, REFERENCE);
    expect(DISK_COPY.banner(reading)).toBe(
      'Low disk space — 4.4 GB free, about 57 min of recording left. ' +
        'Recording will stop by itself before the disk fills.',
    );
  });

  it('says the recording stopped without saying it failed', () => {
    // The whole distinction §7.3's revocation notice draws, and §7.2's stop needs it
    // for the same reason: a recording that ends by itself reads as one that was
    // lost, and this one finalized with everything in it.
    expect(DISK_COPY.stopped).toBe('Recording stopped — the disk is almost full.');
    expect(DISK_COPY.stopped).not.toMatch(/fail|error|lost/i);
  });
});

describe('RECOVERY_COPY', () => {
  const repaired: RecoveryReport = {
    recordingId: 'rec-crash',
    name: 'Untitled 3',
    recovered: true,
    recoveredSec: 292.4,
    frameCount: 8760,
    truncatedBytes: 12_344,
    error: null,
  };

  it("says §7.1 step 5's sentence, out of the repair's own numbers", () => {
    expect(RECOVERY_COPY.heading([repaired])).toBe(
      'A recording was recovered after an unexpected quit',
    );
    expect(RECOVERY_COPY.recovered(repaired)).toBe(
      '“Untitled 3” was repaired: 4:52 and 8,760 frames were kept, and 12,344 bytes of an ' +
        'unfinished fragment were discarded. It is editable in your library.',
    );
  });

  it('states a clean recovery rather than omitting the clause', () => {
    // "Nothing was discarded" is the outcome a user most wants to read, and an
    // omitted clause hides it behind a sentence that looks like the lossy one.
    expect(RECOVERY_COPY.recovered({ ...repaired, truncatedBytes: 0 })).toContain(
      'nothing was discarded',
    );
  });

  it('claims no fixed loss window, because the guarantee is frame-level', () => {
    // The regression this exists to catch: a sentence like "up to one second was
    // lost" describes the design the report sketched, not the one that shipped —
    // the fragment writer holds one sample, so what a crash costs is measured per
    // recording and is in the numbers above.
    const sentence = RECOVERY_COPY.recovered(repaired);
    expect(sentence).not.toMatch(/up to|at most|one second|1 second/i);
    expect(sentence).toContain('8,760');
    expect(sentence).toContain('12,344');
  });

  const failed: RecoveryReport = {
    ...repaired,
    recovered: false,
    recoveredSec: 0,
    frameCount: 0,
    truncatedBytes: 0,
    error: 'no complete frame survived the crash',
  };

  it('pluralises the heading and keeps a failed recording in the library', () => {
    expect(RECOVERY_COPY.heading([repaired, repaired])).toBe(
      '2 recordings were recovered after an unexpected quit',
    );
    expect(RECOVERY_COPY.failed(failed)).toBe(
      '“Untitled 3” could not be repaired: no complete frame survived the crash. ' +
        'It is still in your library, marked damaged.',
    );
  });

  it('never announces a recovery over a pass that recovered nothing', () => {
    // §7.1 step 5's *"never silently pretend it was clean"*, and the exact shape it
    // fails in: `recoverOnLaunch` reports every crashed bundle it touched, repaired
    // or not, so a headline counting the *reports* puts "A recording was recovered"
    // directly above "“Untitled 3” could not be repaired". The heading counts what
    // was repaired.
    expect(RECOVERY_COPY.heading([failed])).toBe(
      'A recording could not be recovered after an unexpected quit',
    );
    expect(RECOVERY_COPY.heading([failed])).not.toMatch(/was recovered/);
    expect(RECOVERY_COPY.heading([failed, failed])).toBe(
      '2 recordings could not be recovered after an unexpected quit',
    );
  });

  it('says both counts when a pass repaired some and not others', () => {
    // The mixed shape, where either count alone is a half-truth: a headline about
    // the repaired ones hides a damaged recording, and one about the damaged ones
    // buries the good news the user came for.
    expect(RECOVERY_COPY.heading([repaired, failed])).toBe(
      'A recording was recovered after an unexpected quit, and 1 could not be',
    );
    expect(RECOVERY_COPY.heading([repaired, repaired, failed])).toBe(
      '2 recordings were recovered after an unexpected quit, and 1 could not be',
    );
  });
});
