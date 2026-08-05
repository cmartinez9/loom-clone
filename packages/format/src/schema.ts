/**
 * Schema identifiers and the versioning contract.
 *
 * Architecture report §2.7: *"Every file carries `"schema": "<name>/<n>"` from line
 * one. `packages/format` owns a migration registry keyed on that string; loading runs
 * the chain, writes the result atomically, and leaves `edit.json.v1.bak` behind.
 * **Never** silently accept an unknown schema — refuse to open and say so."*
 *
 * Adding a version is a three-step change and all three are mechanical:
 *   1. bump the `CURRENT` entry below,
 *   2. register a migration step in `migrate/registry.ts`,
 *   3. add a fixture at the old version under `packages/format/test/fixtures/`.
 */

/** A schema family name — the part before the slash. */
export type SchemaFamily =
  | 'loom.project'
  | 'loom.recording'
  | 'loom.edit'
  | 'loom.journal'
  | 'loom.index'
  | 'loom.cursors'
  | 'loom.settings';

export const SCHEMA_FAMILIES: readonly SchemaFamily[] = [
  'loom.project',
  'loom.recording',
  'loom.edit',
  'loom.journal',
  'loom.index',
  'loom.cursors',
  'loom.settings',
];

/**
 * The schema version this build writes, per family.
 *
 * `loom.project`, `loom.recording`, `loom.edit` and `loom.index` are specified in
 * architecture report §2.2–§2.7. `loom.journal`, `loom.cursors` and `loom.settings`
 * are named by §2 but not given a schema string there; phase 0 assigns them one so
 * that the "every file carries a schema" rule holds without exception.
 */
export const CURRENT_VERSION = {
  'loom.project': 1,
  'loom.recording': 1,
  'loom.edit': 1,
  'loom.journal': 1,
  'loom.index': 1,
  'loom.cursors': 1,
  // 2 adds `setup` — the first-run state phase 2 needs (`types/settings.ts`).
  'loom.settings': 2,
} as const satisfies Record<SchemaFamily, number>;

/** `"loom.edit/1"` — the literal string stored in the file. */
export type SchemaId = `${SchemaFamily}/${number}`;

export interface ParsedSchemaId {
  family: SchemaFamily;
  version: number;
}

export function schemaId(family: SchemaFamily, version: number): SchemaId {
  return `${family}/${version}`;
}

/** The schema id this build writes for a family. */
export function currentSchemaId(family: SchemaFamily): SchemaId {
  return schemaId(family, CURRENT_VERSION[family]);
}

function isSchemaFamily(value: string): value is SchemaFamily {
  return (SCHEMA_FAMILIES as readonly string[]).includes(value);
}

/**
 * Parse a `"<family>/<n>"` string.
 *
 * Returns `null` rather than throwing so callers can produce a domain-specific
 * error naming the file that was bad.
 */
export function parseSchemaId(value: unknown): ParsedSchemaId | null {
  if (typeof value !== 'string') return null;
  const slash = value.lastIndexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  const family = value.slice(0, slash);
  const versionText = value.slice(slash + 1);
  if (!isSchemaFamily(family)) return null;
  if (!/^[0-9]+$/.test(versionText)) return null;
  const version = Number.parseInt(versionText, 10);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { family, version };
}

/** Every document in the format begins with this. */
export interface SchemaTagged {
  schema: SchemaId;
}
