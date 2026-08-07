/**
 * Types for the dev loop's decisions in `dev-loop.mjs`.
 *
 * The scripts stay plain ESM — they are tools, not part of the build — but this one
 * is imported by `test/dev-loop.test.ts`, so the shape both sides agree on is stated
 * here rather than inferred. Same bargain as `mutation-check.d.mts`.
 */

/** What `dist/` must contain before `electron .` can open a window. */
export declare const LAUNCH_REQUIREMENTS: string[];

/** Which requirements are absent, in declaration order. */
export declare function missingLaunchRequirements(
  exists: (relativePath: string) => boolean,
): string[];

export type DevPhase = 'waiting' | 'running' | 'restart-pending' | 'restarting' | 'stopped';

export declare class DevLoop {
  get phase(): DevPhase;
  launched(): void;
  changed(): 'schedule' | 'ignore';
  restartDue(): 'kill' | 'ignore';
  exited(): 'relaunch' | 'end' | 'ignore';
  stopping(): void;
}
