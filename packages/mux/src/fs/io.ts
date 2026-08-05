/**
 * The one write primitive both capture writers share.
 *
 * `write(2)` may write fewer bytes than it was given — on a full disk, on a slow
 * device, on a signal — and a short write that nobody noticed is a fragment with a
 * hole in it, which is the one kind of damage crash recovery cannot repair
 * (recovery trusts whole boxes; it cannot know a whole box is missing its middle).
 * So the loop lives in one place rather than in each writer.
 */

import type { FileHandle } from 'node:fs/promises';

export async function writeAllBytes(
  handle: FileHandle,
  bytes: Uint8Array,
  path: string,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error(`write to ${path} made no progress`);
    offset += bytesWritten;
  }
}
