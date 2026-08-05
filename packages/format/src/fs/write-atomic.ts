/**
 * Atomic writes. Architecture report §2.7, quoted in full because this function is
 * the reason a crash costs at most one second of work:
 *
 * ```ts
 * async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
 *   const tmp = `${path}.tmp-${process.pid}`;
 *   const fd = await fs.open(tmp, 'w');
 *   try { await fd.write(bytes); await fd.sync(); } finally { await fd.close(); }
 *   await fs.rename(tmp, path);
 *   const dir = await fs.open(dirname(path), 'r');
 *   try { await dir.sync(); } finally { await dir.close(); }   // rename is not durable without this
 * }
 * ```
 *
 * > The `dir.sync()` is the part people leave out, and it is the part that loses
 * > your file.
 *
 * Two deviations from the quoted code, both making it *more* correct rather than
 * different:
 *
 * - the temp name carries a per-process counter as well as the pid, because two
 *   concurrent writes to the same path from one process would otherwise share a
 *   temp file and produce exactly the torn write this exists to prevent;
 * - the write loops until every byte is on the handle, because `write(2)` is
 *   permitted to write fewer bytes than it was given.
 *
 * **What this does and does not promise.** `fsync` on macOS flushes to the drive's
 * cache, not through it; a true power-loss barrier needs `fcntl(F_FULLFSYNC)`,
 * which Node does not expose. That distinction does not affect the property the
 * architecture relies on: a *process* that dies at any instant — `SIGKILL`
 * included — leaves the destination file either untouched or completely replaced,
 * because it is only ever replaced by `rename(2)`, which is atomic within a
 * filesystem. `packages/format/test/kill-mid-write.test.ts` proves exactly that, by
 * `SIGKILL`ing a child that calls *this* function — see {@link WriteAtomicPacing} —
 * against a naive truncate-then-write as a control.
 */

import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

let sequence = 0;

/** The temp file a write in flight is using. Exposed for the sweeper below. */
export const TEMP_PREFIX = '.tmp-';

function tempPathFor(path: string): string {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${path}${TEMP_PREFIX}${String(process.pid)}-${String(sequence)}`;
}

/**
 * Widens the write window so a `SIGKILL` can be aimed inside it.
 *
 * Set only by `packages/format/test/kill-mid-write.test.ts`, and it exists so that
 * test can kill *this* function rather than a copy of it — a re-implementation in
 * the test harness would keep passing after a regression here, which is the one
 * thing the phase 0 gate must not do. Production callers pass nothing and the loop
 * behaves exactly as it did.
 */
export interface WriteAtomicPacing {
  /** Largest number of bytes handed to a single `write(2)`. */
  chunkBytes?: number;
  /** Awaited after each `write(2)` returns. */
  betweenChunks?: () => Promise<void>;
}

/**
 * Replace `path` with `bytes`, atomically.
 *
 * The destination is never opened for writing. It is created by `rename(2)` from a
 * fully written, fsync'd temp file in the same directory, so a reader at any
 * moment sees either the previous contents or the new ones, never a mixture.
 */
export async function writeAtomic(
  path: string,
  bytes: Uint8Array,
  pacing: WriteAtomicPacing = {},
): Promise<void> {
  const chunkBytes = pacing.chunkBytes ?? Number.POSITIVE_INFINITY;
  const tmp = tempPathFor(path);
  let renamed = false;
  try {
    const fd = await open(tmp, 'w', 0o644);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const remaining = bytes.byteLength - offset;
        const { bytesWritten } = await fd.write(bytes, offset, Math.min(chunkBytes, remaining));
        if (bytesWritten <= 0) throw new Error(`write to ${tmp} made no progress`);
        offset += bytesWritten;
        if (pacing.betweenChunks !== undefined) await pacing.betweenChunks();
      }
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      // A failed write must not leave litter that a later sweep has to guess about.
      await unlink(tmp).catch(() => undefined);
    }
  }

  // rename(2) is atomic but not durable: without this, the directory entry can be
  // lost even though the file's data was synced.
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** `writeAtomic` for a JSON document. Two-space indent, trailing newline. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeAtomic(path, Buffer.from(text, 'utf8'));
}

/** True for a leftover temp file from a crashed writer. */
export function isTempArtifact(fileName: string): boolean {
  return /\.tmp-\d+-\d+$/.test(fileName);
}
