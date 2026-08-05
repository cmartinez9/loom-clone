/*
 * **The control for the phase-5 gate's sampling-rate assertions.**
 *
 * This program contains none of the sampler's code. It sets up the *same* timer the
 * sampler sets up — a serial queue targeting the global `QOS_CLASS_USER_INTERACTIVE`
 * queue, `dispatch_source_set_timer(…, NSEC_PER_SEC / hz, 0)`, zero leeway — and its
 * handler does nothing but increment a counter. So the rate it reports is what this
 * machine, right now, is willing to hand a timer that asks for `--hz`. It is a ceiling
 * for anything running in this process tree, the sampler included.
 *
 * Why the gate needs one: a macOS background task policy applies to every process in
 * an automation agent's tree (priority 20, against 46–55 for a normal GUI app) and
 * `kern.timer_coalesce_bg_ns_max` coalesces its timers by up to 100 ms. Under it a
 * 120 Hz request is delivered at 25–50 Hz — for this program as much as for the
 * sampler, which is the point. The same sampler binary measures 119.9 Hz from an
 * ordinary shell. Without a control, the gate's rate bounds cannot tell "the sampler
 * regressed" from "the scheduler is throttled", and `rate-control.ts` uses this to
 * keep those apart rather than guessing from an environment variable.
 *
 * Prints one JSON line: {"requestedHz":…,"ticks":…,"seconds":…,"hz":…}
 */

#include <dispatch/dispatch.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static atomic_ullong gTicks;

/* CLOCK_UPTIME_RAW, the same epoch the helper timestamps its samples on. */
static double uptimeSeconds(void) {
  struct timespec now;
  clock_gettime(CLOCK_UPTIME_RAW, &now);
  return (double)now.tv_sec + (double)now.tv_nsec / 1e9;
}

static double argument(int argc, const char **argv, const char *name, double fallback) {
  for (int i = 1; i + 1 < argc; i++) {
    if (strcmp(argv[i], name) == 0) return atof(argv[i + 1]);
  }
  return fallback;
}

int main(int argc, const char **argv) {
  double hz = argument(argc, argv, "--hz", 120.0);
  double ms = argument(argc, argv, "--ms", 1200.0);
  if (hz <= 0 || hz > 1000) hz = 120.0;
  if (ms <= 0 || ms > 60000) ms = 1200.0;

  dispatch_queue_t queue =
      dispatch_queue_create_with_target("loom.control", DISPATCH_QUEUE_SERIAL,
                                        dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0));
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
  dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, (uint64_t)(NSEC_PER_SEC / hz), 0);
  dispatch_source_set_event_handler(timer, ^{
    atomic_fetch_add_explicit(&gTicks, 1, memory_order_relaxed);
  });

  double started = uptimeSeconds();
  dispatch_resume(timer);

  /*
   * The wait itself can be coalesced by the same policy, so the window is *measured*
   * rather than assumed: the caller divides by the seconds reported here.
   */
  dispatch_semaphore_t idle = dispatch_semaphore_create(0);
  dispatch_semaphore_wait(idle, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(ms * NSEC_PER_MSEC)));

  double seconds = uptimeSeconds() - started;
  dispatch_source_cancel(timer);
  unsigned long long ticks = atomic_load_explicit(&gTicks, memory_order_relaxed);

  printf("{\"requestedHz\":%.4f,\"ticks\":%llu,\"seconds\":%.6f,\"hz\":%.4f}\n", hz, ticks, seconds,
         seconds > 0 ? (double)ticks / seconds : 0.0);
  return 0;
}
