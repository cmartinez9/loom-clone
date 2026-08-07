/**
 * The development loop's decisions, with no I/O in them.
 *
 * `scripts/dev.mjs` is the wiring — a build watcher, an `fs.watch` on `dist/` and a
 * spawned Electron. This file is the two questions that wiring has to get right, and
 * they are here rather than inline because **both of them were wrong and neither was
 * visible**: `npm run dev` opened no window, printed nothing at all and exited `0`.
 *
 * ## 1. When may the app be launched?
 *
 * The old loop launched as soon as the `dist/` **directory existed**. On a cold tree
 * — `npm ci` on a fresh clone, which is exactly how a person meets this app — the
 * directory is created by whichever build step runs first and the rest of the build
 * (the vite renderer, the `clang` sampler) is still minutes from finishing. So the
 * app was launched against a half-written `dist/`, and every remaining write landed
 * under a watcher that had just been armed.
 *
 * {@link LAUNCH_REQUIREMENTS} is the answer: the files the app cannot start without.
 * The *settle* window is `dev.mjs`'s, because "nothing has been written for a moment"
 * is a fact about a clock rather than a decision.
 *
 * ## 2. What does an app process exiting mean?
 *
 * Two things, and telling them apart is the whole of it. **We killed it** to pick up
 * a rebuild — so start the replacement. **It quit by itself** — so the dev session is
 * over, and say so.
 *
 * The old loop inferred the difference from its own debounce timer, which it cleared
 * *before* sending the `SIGTERM`. By the time the exit arrived the timer read `null`,
 * which is also what it reads when nobody asked for anything, so a restart we
 * ourselves had just requested was classified as "the app quit" — the build watcher
 * was killed and the whole dev session called `process.exit(0)`. Silent, successful,
 * and about one second after launch.
 *
 * A phase is therefore *stated* rather than inferred from a timer that means two
 * things. `test/dev-loop.test.ts` is what holds it.
 */

/**
 * What `dist/` must contain before `electron .` can do anything at all.
 *
 * `package.json`'s `main` is `dist/main/index.cjs`; that file resolves its own
 * preload and renderer roots from `__dirname` (`apps/main/src/index.ts`), and the
 * launch path's first window is the library or the setup page — both of which are
 * loaded out of `dist/renderer/`. Anything missing here is a window that cannot
 * open, so waiting is strictly better than launching and finding out.
 *
 * It is deliberately **not** the whole build. `dist/native/loom-input-sampler` is not
 * on the list: a missing sampler costs the click-tap probe and nothing else
 * (`PermissionManager` catches it), and a dev loop that refuses to start over an
 * accessory would be a worse instrument than one that starts without it.
 */
export const LAUNCH_REQUIREMENTS = [
  'main/index.cjs',
  'preload/index.cjs',
  'renderer/library.html',
  'renderer/setup.html',
];

/**
 * Which of {@link LAUNCH_REQUIREMENTS} are not there yet, in declaration order.
 *
 * Returned as a list rather than a boolean so the loop can *say* what it is waiting
 * for. A dev loop that waits in silence is the same defect one layer up.
 *
 * @param {(relativePath: string) => boolean} exists
 * @returns {string[]}
 */
export function missingLaunchRequirements(exists) {
  return LAUNCH_REQUIREMENTS.filter((path) => !exists(path));
}

/**
 * The dev session's phase, and the transitions that are allowed to change it.
 *
 * `waiting` — no app process: either the first build has not produced one yet, or a
 * restart's replacement has not been spawned.
 * `running` — an app process is up and nothing has asked for a restart.
 * `restart-pending` — `dist/` changed; the debounce is running.
 * `restarting` — we have sent the `SIGTERM` and are waiting for the exit that
 * belongs to it. **This is the phase whose absence caused the silent exit.**
 * `stopped` — the session is over; nothing further starts anything.
 */
export class DevLoop {
  /** @type {'waiting' | 'running' | 'restart-pending' | 'restarting' | 'stopped'} */
  #phase = 'waiting';

  /** @returns {'waiting' | 'running' | 'restart-pending' | 'restarting' | 'stopped'} */
  get phase() {
    return this.#phase;
  }

  /** An app process has just been spawned. */
  launched() {
    if (this.#phase === 'stopped') return;
    this.#phase = 'running';
  }

  /**
   * Something under `dist/` changed.
   *
   * `schedule` means "(re)arm the debounce"; a change arriving while one is already
   * armed extends it rather than starting a second one. A change with no app up —
   * the tail of the first build, before anything is launched — is nothing to do:
   * whatever it wrote will be in the build the first launch reads.
   *
   * @returns {'schedule' | 'ignore'}
   */
  changed() {
    if (this.#phase !== 'running' && this.#phase !== 'restart-pending') return 'ignore';
    this.#phase = 'restart-pending';
    return 'schedule';
  }

  /**
   * The debounce elapsed.
   *
   * @returns {'kill' | 'ignore'}
   */
  restartDue() {
    if (this.#phase !== 'restart-pending') return 'ignore';
    this.#phase = 'restarting';
    return 'kill';
  }

  /**
   * The app process exited — the decision the silent exit lived in.
   *
   * `relaunch` only for an exit we asked for. Everything else ends the session,
   * because an app that quit on its own is the user quitting it, and a dev loop that
   * relaunched *that* would be a window the user cannot close.
   *
   * @returns {'relaunch' | 'end' | 'ignore'}
   */
  exited() {
    if (this.#phase === 'stopped') return 'ignore';
    if (this.#phase === 'restarting') {
      this.#phase = 'waiting';
      return 'relaunch';
    }
    this.#phase = 'stopped';
    return 'end';
  }

  /** The dev session is shutting down: a signal, or the build watcher dying. */
  stopping() {
    this.#phase = 'stopped';
  }
}
