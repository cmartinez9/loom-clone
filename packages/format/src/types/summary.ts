/**
 * `RecordingSummary` — what the library window shows for one bundle.
 *
 * Named by architecture report §1.4 (`library.list(): Promise<RecordingSummary[]>`).
 * It lives in `@loom/format` because every field is derived from documents this
 * package owns, and because the renderer needs the type without needing the reader.
 */

import type { IsoTimestamp, RecordingId, Seconds } from './common.ts';
import type { ProjectState } from './project.ts';

export interface RecordingSummary {
  id: RecordingId;
  /** Absolute path to the `.loomrec` directory. */
  path: string;
  name: string;
  createdAt: IsoTimestamp;
  modifiedAt: IsoTimestamp;
  state: ProjectState;
  sizeBytes: number;
  /** Longest track end on the recording clock, or `null` before finalize. */
  durationSec: Seconds | null;
  /** Present once the recording has been exported at least once. */
  exportPath: string | null;
  /** True when the sources have been deleted and the recording is final. */
  sourcesDeleted: boolean;
  /**
   * Set when the bundle is on disk but could not be read. The library still lists
   * it — silently hiding a recording the user can see in Finder is worse than
   * showing it as damaged.
   */
  unreadable?: string;
}
