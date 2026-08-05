/**
 * The migration registry. Architecture report §2.7.
 *
 * > Every file carries `"schema": "<name>/<n>"` from line one. `packages/format`
 * > owns a migration registry keyed on that string; loading runs the chain, writes
 * > the result atomically, and leaves `edit.json.v1.bak` behind. **Never** silently
 * > accept an unknown schema — refuse to open and say so.
 *
 * Every family is at version 1 today, so {@link defaultRegistry} registers no steps.
 * The machinery is here from the first commit anyway, and it is the code path every
 * read already goes through — which means the first real migration is a data change,
 * not an architecture change, and it arrives with tests that already exist.
 *
 * ## Adding a migration
 *
 * ```ts
 * defineMigration('loom.edit', 1, (doc) => {
 *   doc['output'] = { ...(doc['output'] as object), colorSpace: 'srgb' };
 *   return doc;
 * });
 * ```
 *
 * and bump `CURRENT_VERSION['loom.edit']` to 2. A step takes a document at version
 * `n` and returns one at `n + 1`. It receives a deep clone, so it may mutate freely.
 */

import { CURRENT_VERSION, parseSchemaId, schemaId, type SchemaFamily } from '../schema.ts';

export type JsonObject = Record<string, unknown>;

/** Migrates a document from version `n` to version `n + 1`. */
export type MigrationStep = (doc: JsonObject) => JsonObject;

export type MigrationErrorCode =
  'unreadable' | 'unknown-schema' | 'family-mismatch' | 'from-the-future' | 'no-path';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly file: string | undefined;

  constructor(code: MigrationErrorCode, message: string, file?: string) {
    super(file === undefined ? message : `${message}\n  file: ${file}`);
    this.name = 'MigrationError';
    this.code = code;
    this.file = file;
  }
}

export interface MigrationOutcome {
  doc: JsonObject;
  /** True when at least one step ran, i.e. the file on disk is now stale. */
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
}

/**
 * An immutable set of migration steps. Immutable and explicitly passed rather than
 * a module-global mutable map, so tests can exercise the real chain runner with
 * their own steps without leaking state between test files.
 */
export class MigrationRegistry {
  /** `family -> (fromVersion -> step)`. */
  private readonly steps: ReadonlyMap<SchemaFamily, ReadonlyMap<number, MigrationStep>>;
  private readonly latest: Readonly<Record<SchemaFamily, number>>;

  constructor(
    steps: ReadonlyMap<SchemaFamily, ReadonlyMap<number, MigrationStep>> = new Map(),
    latest: Readonly<Record<SchemaFamily, number>> = CURRENT_VERSION,
  ) {
    this.steps = steps;
    this.latest = latest;
  }

  latestVersion(family: SchemaFamily): number {
    return this.latest[family];
  }

  stepFrom(family: SchemaFamily, fromVersion: number): MigrationStep | undefined {
    return this.steps.get(family)?.get(fromVersion);
  }

  /**
   * A copy of this registry with extra steps for one family, and its latest version
   * raised to cover them. Used by the migration tests, and by any future build that
   * wants to run a migration chain without touching module state.
   */
  with(
    family: SchemaFamily,
    added: ReadonlyMap<number, MigrationStep>,
    latestVersion: number,
  ): MigrationRegistry {
    const steps = new Map(this.steps);
    const merged = new Map(steps.get(family) ?? []);
    for (const [from, step] of added) merged.set(from, step);
    steps.set(family, merged);
    return new MigrationRegistry(steps, { ...this.latest, [family]: latestVersion });
  }
}

/**
 * The registry this build reads and writes with.
 *
 * Empty because every family is at version 1. When that changes, add the steps here.
 */
export function defaultRegistry(): MigrationRegistry {
  return new MigrationRegistry();
}

/** Structured-clone the document so a step can mutate without surprising the caller. */
function clone(doc: JsonObject): JsonObject {
  return structuredClone(doc);
}

/**
 * Bring a parsed document up to the current version for its family.
 *
 * Refuses, rather than guesses, in all four failure modes: no schema, unknown
 * family, a version from the future, and a gap in the chain.
 */
export function migrateDocument(
  registry: MigrationRegistry,
  family: SchemaFamily,
  input: unknown,
  file?: string,
): MigrationOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MigrationError('unreadable', `expected a JSON object for ${family}`, file);
  }

  const raw = input as JsonObject;
  const parsed = parseSchemaId(raw['schema']);
  if (parsed === null) {
    throw new MigrationError(
      'unknown-schema',
      `refusing to open: unrecognised schema ${JSON.stringify(raw['schema'])}. ` +
        `Expected "${family}/<n>".`,
      file,
    );
  }
  if (parsed.family !== family) {
    throw new MigrationError(
      'family-mismatch',
      `refusing to open: expected a "${family}" document, found "${parsed.family}"`,
      file,
    );
  }

  const target = registry.latestVersion(family);
  if (parsed.version > target) {
    throw new MigrationError(
      'from-the-future',
      `refusing to open: ${family} version ${String(parsed.version)} was written by a newer ` +
        `version of Loom Clone (this build reads up to ${String(target)}). Update the app.`,
      file,
    );
  }

  if (parsed.version === target) {
    return { doc: raw, migrated: false, fromVersion: parsed.version, toVersion: target };
  }

  let doc = clone(raw);
  for (let version = parsed.version; version < target; version++) {
    const step = registry.stepFrom(family, version);
    if (step === undefined) {
      throw new MigrationError(
        'no-path',
        `refusing to open: no migration from ${schemaId(family, version)} to ` +
          schemaId(family, version + 1),
        file,
      );
    }
    doc = step(doc);
    doc['schema'] = schemaId(family, version + 1);
  }

  return { doc, migrated: true, fromVersion: parsed.version, toVersion: target };
}
