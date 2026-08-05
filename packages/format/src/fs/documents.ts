/**
 * Reading and upgrading the documents in a bundle.
 *
 * Every read goes through the same three steps, in this order and never another:
 * **parse → migrate → validate**. Migrating before validating is what lets an old
 * document be brought forward instead of rejected; validating after migrating is
 * what stops a broken migration from writing garbage back to disk.
 */

import { readFile, rename } from 'node:fs/promises';
import {
  MigrationError,
  type MigrationRegistry,
  defaultRegistry,
  migrateDocument,
} from '../migrate/registry.ts';
import type { SchemaFamily } from '../schema.ts';
import { backupPath } from '../bundle/layout.ts';
import { assertValid, type Validator } from '../validate/documents.ts';
import { writeJsonAtomic } from './write-atomic.ts';

export class DocumentReadError extends Error {
  readonly file: string;
  override readonly cause: unknown;
  constructor(file: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`could not read ${file}: ${detail}`);
    this.name = 'DocumentReadError';
    this.file = file;
    this.cause = cause;
  }
}

export interface LoadedDocument<T> {
  doc: T;
  /** True when a migration ran and the copy on disk is now stale. */
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
}

/** Read and parse JSON, with an error that names the file. */
export async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new DocumentReadError(path, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DocumentReadError(path, error);
  }
}

/**
 * Read a document, migrate it in memory, validate it. Does **not** write.
 *
 * Use this anywhere that must not mutate the bundle — the library scan, a
 * read-only inspection, a test.
 */
export async function loadDocument<T>(
  path: string,
  family: SchemaFamily,
  validator: Validator<T>,
  registry: MigrationRegistry = defaultRegistry(),
): Promise<LoadedDocument<T>> {
  const raw = await readJsonFile(path);
  const outcome = migrateDocument(registry, family, raw, path);
  const doc = assertValid(family, validator, outcome.doc, path);
  return {
    doc,
    migrated: outcome.migrated,
    fromVersion: outcome.fromVersion,
    toVersion: outcome.toVersion,
  };
}

/**
 * Read a document and, if it needed migrating, persist the upgraded copy.
 *
 * Architecture report §2.7: *"loading runs the chain, writes the result
 * atomically, and leaves `edit.json.v1.bak` behind."* The backup is made by
 * renaming the original aside **before** the new document is written, so the
 * moment of replacement is a single `rename(2)` and there is no window in which
 * neither file exists.
 *
 * Only `ProjectStore` may call this — it writes, and main is the only writer.
 */
export async function loadAndUpgradeDocument<T>(
  path: string,
  family: SchemaFamily,
  validator: Validator<T>,
  registry: MigrationRegistry = defaultRegistry(),
): Promise<LoadedDocument<T>> {
  const loaded = await loadDocument(path, family, validator, registry);
  if (!loaded.migrated) return loaded;

  await rename(path, backupPath(path, loaded.fromVersion));
  await writeJsonAtomic(path, loaded.doc);
  return loaded;
}

export { MigrationError };
