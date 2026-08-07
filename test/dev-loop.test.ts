/**
 * `npm run dev`'s two decisions, and the launch failure they caused.
 *
 * On a cold tree — `npm ci` then `npm run dev`, which is how the first person to run
 * this app met it — Electron opened no window, printed nothing at all, and the whole
 * dev session exited with status **0**, about a second in. Every phase gate was
 * green. The product itself was fine: `dist/main/index.cjs` launched by hand opens a
 * window and works.
 *
 * The mechanism was two defects in `scripts/dev.mjs`, one initiating and one masking,
 * and separating them is what makes this file worth reading:
 *
 * 1. **The trigger.** The loop launched the app as soon as the `dist/` *directory*
 *    existed. On a cold tree that directory is created by whichever build step runs
 *    first and the rest of the build is still going, so the app was launched against
 *    a half-written `dist/` and the remaining writes landed under a watcher that had
 *    just been armed. Measured: the last `dist/renderer/**` write arrived 50 ms after
 *    the watcher was installed, on every run.
 * 2. **The mask.** The watcher scheduled a restart, and the restart cleared its own
 *    debounce timer *before* sending the `SIGTERM`. The app's exit handler read that
 *    timer to tell "we killed it" from "it quit", found `null` — which is also what
 *    it reads when nobody asked for anything — and ended the dev session. `SIGTERM`
 *    made the exit code `0`, and nothing on either path printed a word.
 *
 * So the assertions below are about a state machine rather than a script, because
 * that is where both defects were: `dev-loop.mjs` states the phase instead of
 * inferring it from a timer that means two things, and `dev.mjs` is the wiring.
 *
 * The launch half is the other side of the same failure and is covered by
 * `test/launch-gate.test.ts`, which runs the real `dist/main/index.cjs` and requires
 * a window a person could see.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevLoop, LAUNCH_REQUIREMENTS, missingLaunchRequirements } from '../scripts/dev-loop.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A loop that has an app up, which is the state every decision below starts from. */
function running(): DevLoop {
  const loop = new DevLoop();
  loop.launched();
  return loop;
}

describe('an exit the dev loop asked for is a restart, not the end of the session', () => {
  it('relaunches after a restart it requested', () => {
    const loop = running();
    expect(loop.changed()).toBe('schedule');
    expect(loop.restartDue()).toBe('kill');

    // The defect, stated: this exit is the SIGTERM we just sent. Reading it as the
    // app quitting is what killed the build watcher and exited `npm run dev`.
    expect(loop.exited()).toBe('relaunch');

    loop.launched();
    expect(loop.phase).toBe('running');
  });

  it('ends the session when the app quits on its own', () => {
    const loop = running();
    // Nobody asked for anything, so this is the user quitting the app — and a dev
    // loop that relaunched *that* would be a window they cannot close.
    expect(loop.exited()).toBe('end');
    expect(loop.phase).toBe('stopped');
  });

  it('survives a rebuild storm rather than exiting on the first write', () => {
    // The cold-tree case in full: the tail of the first build writes repeatedly
    // while the app is up. Every one of these used to be able to end the session.
    const loop = running();
    for (let round = 0; round < 5; round += 1) {
      expect(loop.changed()).toBe('schedule');
      expect(loop.changed()).toBe('schedule');
      expect(loop.restartDue()).toBe('kill');
      expect(loop.exited()).toBe('relaunch');
      loop.launched();
    }
    expect(loop.phase).toBe('running');
  });

  it('does not fire a second kill while a restart is already in flight', () => {
    const loop = running();
    loop.changed();
    expect(loop.restartDue()).toBe('kill');
    // A write arriving between the SIGTERM and the exit has nothing to kill: the
    // replacement is coming and will read whatever is on disk when it starts.
    expect(loop.changed()).toBe('ignore');
    expect(loop.restartDue()).toBe('ignore');
    expect(loop.exited()).toBe('relaunch');
  });

  it('starts nothing once the session is stopping', () => {
    const loop = running();
    loop.stopping();
    // Ctrl-C: the app is killed on the way out, and that exit must not relaunch it.
    expect(loop.exited()).toBe('ignore');
    expect(loop.changed()).toBe('ignore');
    loop.launched();
    expect(loop.phase).toBe('stopped');
  });

  it('ignores a change before anything has been launched', () => {
    // Every write of the first build lands here. There is no app to restart and the
    // launch that is coming will read what these writes produced.
    const loop = new DevLoop();
    expect(loop.changed()).toBe('ignore');
    expect(loop.restartDue()).toBe('ignore');
    expect(loop.phase).toBe('waiting');
  });
});

describe('the dev loop waits for a build the app can be launched against', () => {
  it('names what is missing rather than launching against half a build', () => {
    // `dist/` exists and holds nothing: the state a cold `npm ci` tree is in for the
    // first seconds of its first build, and the state the old loop launched in.
    expect(missingLaunchRequirements(() => false)).toEqual(LAUNCH_REQUIREMENTS);
    // esbuild has finished and vite has not, which is the window the launch landed
    // in: a main process that starts and a renderer root with no pages in it.
    const built = new Set(['main/index.cjs', 'preload/index.cjs']);
    expect(missingLaunchRequirements((path) => built.has(path))).toEqual([
      'renderer/library.html',
      'renderer/setup.html',
    ]);
    expect(missingLaunchRequirements(() => true)).toEqual([]);
  });

  it('requires exactly what the launch path opens, and no accessory', async () => {
    // Pinned against the two sources of truth rather than restated: `package.json`
    // names the main entry, and `apps/main/src/index.ts`'s launch path shows the
    // first window at `store.setup.completedAt === null ? 'setup' : 'library'` — so
    // both pages are on the critical path and both have to be on disk.
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      main: string;
    };
    expect(pkg.main).toBe(`dist/${LAUNCH_REQUIREMENTS[0] ?? ''}`);
    expect(LAUNCH_REQUIREMENTS).toContain('renderer/library.html');
    expect(LAUNCH_REQUIREMENTS).toContain('renderer/setup.html');

    // And the sampler is deliberately not on it. A missing helper costs the
    // click-tap probe and nothing else — `PermissionManager` catches it — so a dev
    // loop that refused to start over one would be worse than one that starts.
    expect(LAUNCH_REQUIREMENTS).not.toContain('native/loom-input-sampler');
  });
});
