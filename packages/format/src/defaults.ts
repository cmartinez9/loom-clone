/**
 * Factories for new documents.
 *
 * Kept here rather than in the store so that fixtures, tests and the app all
 * start from byte-identical defaults.
 */

import { currentSchemaId } from './schema.ts';
import type { IsoTimestamp, RecordingId } from './types/common.ts';
import type { ProjectDoc } from './types/project.ts';
import type { EditDocument } from './types/edit.ts';
import type { CursorIndexDoc } from './types/sidecar.ts';
import type { SettingsDoc } from './types/settings.ts';

/** ISO-8601 UTC with milliseconds — the one timestamp format in the format. */
export function isoTimestamp(date: Date = new Date()): IsoTimestamp {
  return date.toISOString();
}

export interface NewProjectInput {
  id: RecordingId;
  name: string;
  appVersion: string;
  createdAt?: Date;
}

/**
 * A project manifest for a recording that is about to start.
 *
 * `state: 'recording'` is written **before the first frame** (§7.1), which is what
 * makes a crash detectable rather than inferred.
 */
export function newProjectDoc(input: NewProjectInput): ProjectDoc {
  const at = isoTimestamp(input.createdAt ?? new Date());
  return {
    schema: currentSchemaId('loom.project'),
    appVersion: input.appVersion,
    id: input.id,
    name: input.name,
    createdAt: at,
    modifiedAt: at,
    state: 'recording',
    editRevision: 0,
    sizeBytes: 0,
    exports: [],
  };
}

/**
 * An empty edit document.
 *
 * No clips and no tracks means "the recording as captured": the clip list is what
 * maps source time to timeline time (§3.1), and an empty list is read as one clip
 * spanning the whole source. Output size is filled in from `recording.json` once
 * the capture's real dimensions are known, so the default here is only ever seen
 * by a project that has not finished recording.
 */
export function newEditDocument(): EditDocument {
  return {
    schema: currentSchemaId('loom.edit'),
    revision: 0,
    output: { size: [1920, 1080], fps: 30, background: { kind: 'none' } },
    clips: [],
    tracks: [],
  };
}

export function newCursorIndexDoc(): CursorIndexDoc {
  return { schema: currentSchemaId('loom.cursors'), images: {} };
}

export function newSettingsDoc(recordingsRoot: string): SettingsDoc {
  return {
    schema: currentSchemaId('loom.settings'),
    recordingsRoot,
    // A fresh install has never been asked, so first-run setup is owed. This is the
    // only place that decides a new user sees it.
    setup: { completedAt: null, accessibilityOpenedAt: null },
  };
}
