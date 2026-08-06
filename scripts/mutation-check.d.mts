/**
 * Types for the mutation registry in `mutation-check.mjs`.
 *
 * The script is plain ESM and stays that way — it is a tool, not part of the build —
 * but its `MUTATIONS` array is imported by `test/mutation-registry.test.ts`, which
 * checks every entry against the tree on each `npm test`. This is the shape both
 * sides agree on, so a field added to an entry is a compile error in the test rather
 * than a silently unchecked property.
 */

/** One registered mutation: a single edit that breaks one property, and its gates. */
export interface Mutation {
  /** Selected by `--only <name>`; unique across the registry. */
  name: string;
  /** What property this breaks, in the terms the gate would report it. */
  breaks: string;
  /** Repo-relative path to the production source it edits. */
  file: string;
  /** The original text. Must appear in `file` exactly once. */
  find: string;
  /** What it becomes. Never equal to `find`. */
  replace: string;
  /** Test files that must fail once the edit is applied. */
  mustFail: string[];
}

export declare const MUTATIONS: Mutation[];
