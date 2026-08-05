/**
 * Busy-loop load for the phase-6 gate's under-load measurements, with the one
 * property that matters: **a spinner cannot outlive the run that spawned it.**
 *
 *   node scripts/gate-load.mjs [spinners] [seconds]
 *
 * The gate's deferred branch — its tracking ceiling, its over-budget share, and the
 * middle band between them — can only be characterised on a deliberately saturated
 * host, so those readings are taken beside a fleet of busy loops. Taken with *ad-hoc*
 * busy loops, they are also how this shared machine ended up pinned at load 132 for
 * nine hours by 42 orphans, 22 of them left by a worktree whose parent died before it
 * reached its `kill $pids` — and then how a 1-in-9 gate flake got measured on the
 * result and written down as a property of the gate.
 *
 * A `trap` does not fix that, because the failure case *is* the parent dying without
 * running its cleanup. The deadline therefore lives **inside each spinner**: every
 * child computes it from its own clock at its own start and exits on it with nothing
 * watching. Reparented to `launchd`, parent SIGKILLed, terminal closed — it still goes
 * away. {@link MAX_SECONDS} is well under the gate's 120 s per-launch timeout, so an
 * orphan expires inside the run it was spawned for rather than into the next one.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/**
 * The hard cap on one spinner's life. A gate launch is 120 s (`ATTEMPT_TIMEOUT_MS`)
 * and a whole run 300 s, so a spinner that somehow survives its parent is gone before
 * the launch it was meant for is.
 */
const MAX_SECONDS = 60;
const DEFAULT_SECONDS = 30;
const DEFAULT_SPINNERS = 4;
/** A typo in the first argument must not fork the box, which is this file's whole point. */
const MAX_SPINNERS = 64;

/** The same shape as the gate's own control: arithmetic between clock reads. */
function spin(seconds) {
  const deadline = performance.now() + seconds * 1000;
  let sink = 0;
  while (performance.now() < deadline) {
    for (let i = 1; i <= 4096; i++) sink = (sink + Math.sqrt(i)) % 1_000_003;
  }
  return sink;
}

function clamp(value, fallback, max) {
  const parsed = Number.parseFloat(value ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

const [first, second] = process.argv.slice(2);

if (first === '--spin') {
  // The child, and the whole of the guarantee: the deadline is computed here, from
  // this process's own clock, and clamped here as well — so no caller, and no parent
  // that stops existing a second from now, can extend it.
  spin(clamp(second, DEFAULT_SECONDS, MAX_SECONDS));
} else {
  const spinners = Math.max(1, Math.round(clamp(first, DEFAULT_SPINNERS, MAX_SPINNERS)));
  const seconds = clamp(second, DEFAULT_SECONDS, MAX_SECONDS);
  console.log(`${spinners} spinners, ${seconds}s each — the deadline is inside every child`);
  const children = Array.from({ length: spinners }, () =>
    spawn(process.execPath, [SELF, '--spin', String(seconds)], { stdio: 'ignore' }),
  );
  await Promise.all(children.map((child) => once(child, 'exit')));
  console.log('spinners expired');
}
