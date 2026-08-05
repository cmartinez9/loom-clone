/**
 * Types for `build.mjs`.
 *
 * The build script is plain JavaScript because `scripts/build.mjs` imports it and
 * that layer of this repo is JavaScript throughout; this declaration is what lets the
 * phase-5 acceptance test import it under `strict` TypeScript.
 */

export declare const NATIVE_SOURCE: string;
export declare const NATIVE_BINARY: string;

/** Compile `loom-input-sampler` if it is stale, and return its path. */
export declare function buildNativeSampler(options?: { force?: boolean }): Promise<string>;
