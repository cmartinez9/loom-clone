/**
 * The mutation registry, checked against the tree it mutates — on every `npm test`.
 *
 * `npm run verify:mutation` is the proof that this repo's gates measure something:
 * it breaks the production source one property at a time and requires a test to
 * notice. That proof rests on a precondition nothing was checking cheaply, and this
 * file is that check.
 *
 * ## The failure it exists to catch
 *
 * A mutation edits production source on disk and restores it in a `finally`. If a
 * mutated file is ever *committed* — an interrupted run, or an agent-applied fix
 * that picked one up — the defect ships, and **every mechanical check still passes**:
 * no assertion was deleted, the tree typechecks, and the suite is green because the
 * mutation is by construction the kind of change only its own gate notices. It
 * happened on another branch in this project, and it was caught by hand.
 *
 * The tell is exact and cheap: a mutation's `find` is the *original* text, so if the
 * mutation is applied to the tree, `find` occurs **zero** times. Asserting it occurs
 * exactly once therefore catches both halves of the rot — a mutation that has been
 * written into the source, and a mutation whose target has moved out from under it,
 * which is the silent way an entry stops proving anything.
 *
 * `mutation-check.mjs` makes the same occurrence check, but only for the mutation it
 * is about to apply and only during a run that takes minutes. This one covers every
 * entry, in milliseconds, on the run everybody does.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS, type Mutation } from '../scripts/mutation-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read once each: the registry names far fewer files than it has entries. */
const cache = new Map<string, Promise<string>>();
function source(file: string): Promise<string> {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const read = readFile(join(root, file), 'utf8');
  cache.set(file, read);
  return read;
}

const mutations: Mutation[] = MUTATIONS;

describe('every registered mutation still describes the tree', () => {
  it('has entries at all, so the checks below cannot pass vacuously', () => {
    expect(mutations.length).toBeGreaterThan(50);
  });

  it.each(mutations.map((m) => [m.name, m] as const))(
    '%s: its original source is present exactly once',
    async (_name, mutation) => {
      const text = await source(mutation.file);
      const found = text.split(mutation.find).length - 1;

      // Zero is the loud case and the reason this file exists: the mutation is
      // applied to the tree, so the defect it models is committed. One is correct.
      // More than one means the mutation would edit an arbitrary occurrence, which
      // `mutation-check.mjs` also refuses — an entry that cannot say which line it
      // breaks proves nothing about the line it meant.
      expect(
        found,
        found === 0
          ? `${mutation.file} does not contain this mutation's ORIGINAL text. Either the ` +
              `mutation is applied to the committed source — in which case the defect it ` +
              `models is shipping — or the code moved and the entry is stale. It breaks: ` +
              mutation.breaks
          : `${mutation.file} contains this mutation's target ${String(found)} times, so ` +
              `applying it would edit an arbitrary one of them.`,
      ).toBe(1);
    },
  );

  it.each(mutations.map((m) => [m.name, m] as const))(
    '%s: actually changes something',
    (_name, mutation) => {
      // A mutation whose replacement equals its target is a no-op, and a no-op is
      // "caught" only by whatever else happens to be failing.
      expect(mutation.replace, 'the replacement is identical to the target').not.toBe(
        mutation.find,
      );
    },
  );

  it.each(mutations.map((m) => [m.name, m] as const))(
    '%s: names test files that exist',
    async (_name, mutation) => {
      expect(
        mutation.mustFail.length,
        'a mutation nothing must fail on proves nothing',
      ).toBeGreaterThan(0);
      for (const file of mutation.mustFail) {
        await expect(
          source(file),
          `${mutation.name} expects ${file} to catch it, and that file is not there`,
        ).resolves.toBeTypeOf('string');
      }
    },
  );

  it('names each mutation once', () => {
    // `--only <name>` selects by name, so a duplicate silently runs one and reports
    // the other as covered.
    const names = mutations.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
