/**
 * The bundle write lock — the `.lock` file in architecture report §2.1.
 *
 * "Main is the only writer" is enforced inside one app by the process boundary:
 * renderers run sandboxed with no filesystem access at all. This file closes the
 * remaining hole, which is *two copies of the app* pointed at the same recordings
 * root — a second launch from a different build, or a stale process that survived
 * a crash. The `.lock` makes that a refusal with a readable message instead of two
 * writers racing on `edit.json`.
 */

import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { BUNDLE } from '../bundle/layout.ts';
import { isoTimestamp } from '../defaults.ts';

export interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
}

export class BundleLockedError extends Error {
  readonly holder: LockInfo;
  constructor(bundleDir: string, holder: LockInfo) {
    super(
      `${bundleDir} is already open for writing by pid ${String(holder.pid)} ` +
        `on ${holder.host} (since ${holder.startedAt})`,
    );
    this.name = 'BundleLockedError';
    this.holder = holder;
  }
}

/**
 * Is a process still running?
 *
 * `kill(pid, 0)` is the portable liveness probe: `EPERM` means it exists and is
 * someone else's, `ESRCH` means it is gone. Pid reuse can in principle make a dead
 * holder look alive; the consequence is a refusal to open, which the user can
 * clear by deleting `.lock`, and which is the safe direction to be wrong in.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o['pid'] !== 'number') return null;
    return {
      pid: o['pid'],
      startedAt: typeof o['startedAt'] === 'string' ? o['startedAt'] : 'unknown',
      host: typeof o['host'] === 'string' ? o['host'] : 'unknown',
    };
  } catch {
    // A `.lock` we cannot parse is a `.lock` from a crash mid-creation. Treat it
    // as stale rather than wedging the bundle forever.
    return null;
  }
}

/** A held bundle lock. Release it in a `finally`; `ProjectStore` does. */
export class BundleLock {
  readonly path: string;
  private released = false;

  private constructor(path: string) {
    this.path = path;
  }

  /**
   * Take the lock, or throw {@link BundleLockedError}.
   *
   * `wx` is the atomic part: it creates the file or fails, with no window between
   * the check and the create.
   */
  static async acquire(bundleDir: string): Promise<BundleLock> {
    const path = join(bundleDir, BUNDLE.lock);
    const info: LockInfo = { pid: process.pid, startedAt: isoTimestamp(), host: hostname() };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, 'wx', 0o644);
        try {
          await handle.write(Buffer.from(`${JSON.stringify(info)}\n`, 'utf8'));
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new BundleLock(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = await readLock(path);
        if (holder !== null && isProcessAlive(holder.pid)) {
          throw new BundleLockedError(bundleDir, holder);
        }
        // Stale: the holder is gone, or the file is unparseable. Clear it and retry
        // once. A second EEXIST means someone else won the race, and their lock is
        // live by definition.
        await rm(path, { force: true });
      }
    }

    const holder = (await readLock(path)) ?? { pid: -1, startedAt: 'unknown', host: 'unknown' };
    throw new BundleLockedError(bundleDir, holder);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await rm(this.path, { force: true });
  }
}
