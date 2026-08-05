/**
 * `@loom/mux/fs` — the half of the muxer that owns a file descriptor.
 *
 * Split from `@loom/mux` for the same reason `@loom/format/fs` is split from
 * `@loom/format`: importing it pulls in `node:fs`, so importing it is a visible
 * act. `eslint.config.mjs` allows it in `apps/main/src/project-store.ts` and
 * nowhere else, which is how "main is the only writer" (architecture report §0,
 * rule 2) survives the arrival of a 30 Hz write path.
 */

export {
  MediaPartWriter,
  indexBytes,
  type FinalizedPart,
  type MediaPartWriterOptions,
} from './media-part-writer.ts';

export { UnrecoverablePartError, recoverMediaPart, type RecoveredPart } from './recover.ts';
