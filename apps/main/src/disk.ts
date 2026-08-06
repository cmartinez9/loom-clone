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
import type { ProjectStore } from './project-store.ts';

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
    measureRate(store),
  ]);
  return classifyDisk(space, rate);
}

/**
 * What a second of recording has cost this user, from their own finished bundles.
 *
 * `list()` measures every bundle on disk, which is the same walk the library window
 * does on every refresh — so this is a cost the app already pays whenever a surface
 * that would show this estimate is open.
 */
async function measureRate(store: ProjectStore): Promise<CaptureRate> {
  try {
    return measureCaptureRate(await store.list());
  } catch (error) {
    console.error('[disk] the capture rate could not be measured:', error);
    // Not a fabricated number: `measureCaptureRate` of nothing is the reference
    // figure, labelled `reference`, which is exactly what an unreadable library
    // leaves us knowing.
    return measureCaptureRate([]);
  }
}
