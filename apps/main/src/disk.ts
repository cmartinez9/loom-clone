/**
 * §7.2's preflight reading, composed from the two things only main can measure.
 *
 * The *decision* is `@loom/ipc`'s (`classifyDisk`, `diskRefusesStart`) and the
 * *syscalls* are `ProjectStore`'s (§0 rule 2). This is the four lines between them,
 * and it exists as its own file for one reason: `apps/main/src/permissions.ts` is
 * the only file in main allowed to read TCC and it is the file §1.4 puts `preflight`
 * on, so it needed a way to learn about a volume that does not involve importing
 * `node:fs` into the one module whose whole discipline is that it reads nothing.
 *
 * **The rate is the user's own.** §7.2's capacity estimate is written against the
 * research report's 76 MB/min, but §5.6's own table spans 4.1 to 146 MB/min across
 * real content — so "≈ 42 min available" derived from that constant is a sentence
 * about a machine and a screen that are not this user's. What answers instead is
 * their library: bytes actually written against seconds actually recorded, and the
 * constant only where there is nothing to measure. `CaptureRate.source` carries
 * which one answered, and the copy says so.
 *
 * **A reading that could not be taken is `unknown`, never zero.** Every predicate
 * over `DiskReading` answers "no" for it, so a volume this process cannot measure
 * refuses nothing and stops nothing — which is the same accessory rule §7.3 gives
 * audio and §7.4 gives the camera, applied to an instrument rather than a device.
 */

import { classifyDisk, measureCaptureRate, type CaptureRate, type DiskReading } from '@loom/ipc';
import { beforeDeadline } from './recorder/disk-monitor.ts';
import type { ProjectStore } from './project-store.ts';

/**
 * How long the library walk is given before it is abandoned.
 *
 * Generous, because it is a recursive walk of every bundle on disk and nothing waits
 * on it — but **finite**, because `readdir` and `stat` against a wedged volume hang
 * exactly as `statfs` does, and a wait with no bound on it is how a surface stops
 * answering with nothing in the log saying why. It is not derived from §7.2's poll
 * interval: this is a different operation with a different cost, and tying it to a
 * 2 s cadence would abandon a walk that was going to answer.
 */
export const LIBRARY_RATE_DEADLINE_MS = 10_000;

/**
 * Free space and this user's own measured cost of a second, banded (§7.2).
 *
 * Both halves are taken concurrently and both degrade rather than throw: a library
 * that could not be listed costs the *provenance* of the estimate, not the estimate,
 * and a volume that could not be read costs the reading.
 */
export async function readDiskForPreflight(store: ProjectStore): Promise<DiskReading> {
  const [space, rate] = await Promise.all([
    store.diskSpace().catch((error: unknown) => {
      console.error('[disk] free space could not be read:', error);
      return null;
    }),
    measureLibraryRate(store),
  ]);
  // A walk that could not answer is the same state as a library with nothing in it:
  // the reference figure, labelled `reference`, which is what we actually know.
  return classifyDisk(space, rate ?? measureCaptureRate([]));
}

/**
 * What a second of recording has cost this user, from their own finished bundles.
 *
 * `list()` measures every bundle on disk, which is the same walk the library window
 * does on every refresh — so this is a cost the app already pays whenever a surface
 * that would show this estimate is open. **It is also why this is never called on a
 * poll**: §7.2's monitor runs every 2 s for the length of a recording, and a
 * recursive walk of the recordings root on that path would be queueing behind — and
 * in front of — the media appends. `RecorderSession` resolves it once per recording
 * and reuses the answer, which is the only shape this is safe in.
 *
 * Exported so that there is one of it. The recorder and the preflight are answering
 * the same question about the same library, and two implementations of "what has a
 * second cost this user" is a number that can disagree with itself between the HUD
 * and the library window.
 *
 * **`null` when it could not be measured, and a *hang* is one of the ways.** A walk
 * that throws was already survivable; a walk that never returns was not, and it is
 * the likelier of the two on the volume this whole feature is about. Both now land
 * on the same answer, which every caller reads as "we do not know" and none reads as
 * a number.
 */
export async function measureLibraryRate(
  store: ProjectStore,
  deadlineMs: number = LIBRARY_RATE_DEADLINE_MS,
): Promise<CaptureRate | null> {
  try {
    const summaries = await beforeDeadline(
      () => store.list(),
      deadlineMs,
      `[disk] the library did not answer within ${String(deadlineMs)} ms; the capacity ` +
        "estimate falls back to a typical recording's size",
    );
    return summaries === null ? null : measureCaptureRate(summaries);
  } catch (error) {
    console.error('[disk] the capture rate could not be measured:', error);
    return null;
  }
}
