/**
 * `loom-cursor-driver` — moves and clicks the real mouse, and says exactly when it did.
 *
 * **Test tooling. Nothing in the app spawns this and nothing ships it.** It exists so
 * `scripts/record-cursor-corpus.mjs` can produce recordings whose cursor logs are real
 * observations by the shipping sampler — real `NSEvent`/window-server positions, real
 * 120 Hz timing jitter, real `CGEventTap` delivery — on a machine where nobody is
 * available to move the mouse. The scout did the same thing to measure §5.4's polling
 * accuracy (`mover.swift`, research report §5.4: *"I drove the cursor along a known
 * circle … with a Swift helper"*), and this is that, with a human-pointing model
 * instead of a circle.
 *
 * ## What it is honest about
 *
 * The hand is a script. Every recording it produces says so in its manifest. What is
 * *not* synthetic is everything downstream of `CGEventPost`: the window server moves
 * the real cursor, the sampler polls it through the real API at 120 Hz, the tap sees
 * the real click events, and the log is written by the real `InputSampler`. The
 * recorder's `--manual` mode records exactly the same artifacts with no driver at all.
 *
 * ## Warp for moves, post for clicks — and why that split is not a style choice
 *
 * Measured on this machine, `AXIsProcessTrusted() = false`:
 *
 * ```
 * CGWarpMouseCursorPosition -> err=0, pointer moved (518.4,335.1) -> (518.0,335.0)
 * CGEventPost(kCGEventMouseMoved) -> pointer did not move
 * ```
 *
 * Synthesizing an *event* is gated by Accessibility on current macOS; moving the
 * *pointer* is not. Both halves matter here. Moves go through the warp, so a corpus
 * can be recorded on a machine with no grant at all — which is the machine phase 10
 * had. Clicks have no warp equivalent, so they stay `CGEventPost`, and on an ungranted
 * machine they neither land nor would be observed if they did: the sampler's tap is
 * dead for the same reason (research report §5.4 — *"`CGEvent.tapCreate` **does not
 * fail** when you lack Accessibility. It returns a valid, non-null tap that is
 * silently dead"*). So the click log is absent, `count` is `null` rather than `0`, and
 * the recorder's manifest says the reading could not be taken. That is the honest
 * outcome, and it is the one phase 5 built the format to be able to express.
 *
 * A warp does not deliver a `mouseMoved` event to anything, which is exactly why the
 * sampler *polls* (§6.1): it reads the pointer's position rather than subscribing to
 * its motion, so what it records is the same whether a hand or a warp moved it.
 *
 * ## It reports its own trust, and the recorder refuses to measure without it
 *
 * `AXIsProcessTrusted()` is read **here**, in the process that posts, and printed on
 * the `hello` line. Reading it anywhere else would be an inference: TCC keys a grant on
 * the exact code identity of the responsible process, so "the sampler is trusted"
 * does not establish that this binary is, and a grant landing on the wrong binary looks
 * exactly like no grant at all (`AGENTS.md` § Sharp edges — permissions: two System
 * Settings rows with the same identifier already cost a full grant cycle here).
 * `record-cursor-corpus.mjs` requires *both* sides to say yes before it reports a click
 * latency, and records `measured: false` with the reason otherwise. Never a zero.
 *
 * `AXIsProcessTrusted()` and not `AXIsProcessTrustedWithOptions(prompt: true)`: the
 * second turns a status check into a dialog, which is the thing `apps/main/src/
 * permissions.ts` passes `false` to avoid.
 *
 * ## Timestamps
 *
 * `tUs` is `clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000`, the same clock
 * `loom-input-sampler.m` stamps every line with. That is what makes "post at tUs,
 * observed at tUs" a latency rather than two numbers from different clocks.
 *
 * ## Safety on a shared machine
 *
 * This takes over the pointer. Three things bound that, and none of them relies on the
 * parent process still being alive — `AGENTS.md`'s note about 42 orphaned spinners is
 * about exactly that failure mode:
 *
 * - `--seconds` is capped at {@link kMaxSeconds}, checked inside the run loop.
 * - The pointer is restored to where it started, on the normal exit path and from a
 *   `SIGINT`/`SIGTERM` handler.
 * - It refuses to start if there is no window server to post to.
 *
 * Build: see `scripts/record-cursor-corpus.mjs`, which compiles it with one `clang`
 * call into `dist/tools/` the way `packages/sampler/native/build.mjs` does.
 */

#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <math.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/** Nobody's pointer is borrowed for longer than this, whatever the arguments say. */
static const double kMaxSeconds = 180.0;

/** Posting cadence. Above the sampler's 120 Hz so the sampler is what quantises. */
static const double kPostHz = 240.0;

static uint64_t nowUptimeUs(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000ull; }

static CGPoint gStartPoint;
static volatile sig_atomic_t gStop = 0;

static void restorePointer(void) {
  CGWarpMouseCursorPosition(gStartPoint);
  CGAssociateMouseAndMouseCursorPosition(true);
}

static void onSignal(int signum) {
  (void)signum;
  gStop = 1;
}

/** xorshift64*, so a seed reproduces a run exactly and no libc differences leak in. */
static uint64_t gState = 88172645463325252ull;
static double nextUnit(void) {
  gState ^= gState >> 12;
  gState ^= gState << 25;
  gState ^= gState >> 27;
  return (double)((gState * 2685821657736338717ull) >> 11) / 9007199254740992.0;
}
static double between(double lo, double hi) { return lo + (hi - lo) * nextUnit(); }

static void emit(const char *json) {
  fputs(json, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void postMove(CGPoint point, double nx, double ny) {
  uint64_t t = nowUptimeUs();
  CGWarpMouseCursorPosition(point);
  char line[256];
  snprintf(line, sizeof line, "{\"k\":\"post\",\"e\":\"move\",\"tUs\":%llu,\"x\":%.5f,\"y\":%.5f}",
           (unsigned long long)t, nx, ny);
  emit(line);
}

static void postButton(CGPoint point, double nx, double ny, bool down) {
  CGEventType type = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
  CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, kCGMouseButtonLeft);
  if (event == NULL) return;
  uint64_t t = nowUptimeUs();
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  char line[256];
  snprintf(line, sizeof line, "{\"k\":\"post\",\"e\":\"%s\",\"tUs\":%llu,\"x\":%.5f,\"y\":%.5f}",
           down ? "down" : "up", (unsigned long long)t, nx, ny);
  emit(line);
}

static double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Smoothstep — a bell-shaped velocity profile, which is what a pointing move has. */
static double smoothstep(double u) { return u * u * (3.0 - 2.0 * u); }

static void sleepUntil(uint64_t targetUs) {
  for (;;) {
    uint64_t now = nowUptimeUs();
    if (now >= targetUs) return;
    uint64_t remaining = targetUs - now;
    struct timespec ts = {(time_t)(remaining / 1000000ull),
                          (long)((remaining % 1000000ull) * 1000ull)};
    nanosleep(&ts, NULL);
  }
}

static double argDouble(int argc, const char **argv, const char *name, double fallback) {
  for (int i = 1; i + 1 < argc; i++) {
    if (strcmp(argv[i], name) == 0) return atof(argv[i + 1]);
  }
  return fallback;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    double seconds = clampd(argDouble(argc, argv, "--seconds", 20.0), 1.0, kMaxSeconds);
    double seed = argDouble(argc, argv, "--seed", 1.0);
    // "Calm" and "brisk" are the same model with different pointing amplitudes and
    // durations; the corpus records a spread so the comfort budget is asked about
    // more than one kind of session.
    double pace = clampd(argDouble(argc, argv, "--pace", 1.0), 0.2, 2.5);
    double clickRate = clampd(argDouble(argc, argv, "--click-rate", 0.5), 0.0, 1.0);
    if (seed > 0) gState = (uint64_t)seed * 6364136223846793005ull + 1442695040888963407ull;

    CGDirectDisplayID display = CGMainDisplayID();
    CGRect bounds = CGDisplayBounds(display);
    if (bounds.size.width <= 0 || bounds.size.height <= 0) {
      fprintf(stderr, "no display to drive\n");
      return 2;
    }

    CGEventRef probe = CGEventCreate(NULL);
    if (probe == NULL) {
      fprintf(stderr, "no window server: refusing to post events\n");
      return 2;
    }
    gStartPoint = CGEventGetLocation(probe);
    CFRelease(probe);

    signal(SIGINT, onSignal);
    signal(SIGTERM, onSignal);
    atexit(restorePointer);

    // The posting process's own answer, from the posting process. See the header.
    const bool axTrusted = AXIsProcessTrusted();

    char hello[384];
    snprintf(hello, sizeof hello,
             "{\"k\":\"hello\",\"tUs\":%llu,\"display\":%u,\"bounds\":[%.1f,%.1f,%.1f,%.1f],"
             "\"seconds\":%.3f,\"seed\":%.0f,\"pace\":%.3f,\"clickRate\":%.3f,"
             "\"axTrusted\":%s,\"pid\":%d}",
             (unsigned long long)nowUptimeUs(), (unsigned)display, bounds.origin.x,
             bounds.origin.y, bounds.size.width, bounds.size.height, seconds, seed, pace,
             clickRate, axTrusted ? "true" : "false", (int)getpid());
    emit(hello);

    // Stay off the very edges: the menu bar and the Dock are where a stray synthetic
    // click would do something to somebody else's machine.
    const double marginX = 0.06;
    const double marginY = 0.10;

    // Start where the pointer already is, *not* snapped into the safe area: the first
    // warp would otherwise teleport it, and a teleport in the first 40 ms of every
    // recording is an artefact of this tool rather than anything about a cursor. Every
    // *target* is inside the margins, so the first pointing move walks it in.
    double nx = clampd((gStartPoint.x - bounds.origin.x) / bounds.size.width, 0.0, 1.0);
    double ny = clampd((gStartPoint.y - bounds.origin.y) / bounds.size.height, 0.0, 1.0);

    const uint64_t startUs = nowUptimeUs();
    const uint64_t endUs = startUs + (uint64_t)(seconds * 1e6);
    const uint64_t stepUs = (uint64_t)(1e6 / kPostHz);
    uint64_t nextUs = startUs;

    // Phase state: a pause, then a pointing move, then sometimes a click or a burst.
    double x0 = nx, y0 = ny, x1 = nx, y1 = ny;
    uint64_t phaseStart = startUs;
    uint64_t phaseEnd = startUs + (uint64_t)(between(0.3, 1.2) * 1e6);
    int phase = 0; /* 0 = pause, 1 = move */
    int pendingClicks = 0;
    uint64_t nextClickUs = 0;

    while (!gStop) {
      uint64_t now = nowUptimeUs();
      if (now >= endUs) break;
      sleepUntil(nextUs);
      nextUs += stepUs;
      now = nowUptimeUs();
      if (now >= endUs) break;

      if (now >= phaseEnd) {
        if (phase == 1) {
          x0 = x1;
          y0 = y1;
          phase = 0;
          phaseStart = now;
          phaseEnd = now + (uint64_t)(between(0.25, 1.8) * 1e6);
          // A click, a double-click, or a small burst — §6.5's clustering only has
          // something to do when clicks arrive in groups as well as singly.
          if (nextUnit() < clickRate) {
            double roll = nextUnit();
            pendingClicks = roll < 0.55 ? 1 : (roll < 0.85 ? 2 : 3 + (int)(nextUnit() * 3));
            nextClickUs = now + (uint64_t)(between(0.05, 0.25) * 1e6);
          }
        } else {
          // A pointing move. Amplitude and duration in the shape Fitts's law gives
          // them: further is slower, but sublinearly.
          double amplitude = between(0.03, 0.42) * pace;
          double angle = between(0.0, 6.2831853);
          x1 = clampd(x0 + cos(angle) * amplitude, marginX, 1.0 - marginX);
          y1 = clampd(y0 + sin(angle) * amplitude, marginY, 1.0 - marginY);
          double reach = fabs(x1 - x0) + fabs(y1 - y0);
          double duration = (0.18 + 0.95 * reach + between(0.0, 0.22)) / pace;
          phase = 1;
          phaseStart = now;
          phaseEnd = now + (uint64_t)(duration * 1e6);
        }
      }

      if (phase == 1) {
        double span = (double)(phaseEnd - phaseStart);
        double u = span > 0 ? clampd((double)(now - phaseStart) / span, 0.0, 1.0) : 1.0;
        double e = smoothstep(u);
        nx = x0 + (x1 - x0) * e;
        ny = y0 + (y1 - y0) * e;
      } else {
        // A hand resting on a mouse is not perfectly still. One pixel of tremor is
        // what §6.1's shake filter and one-pixel decimation exist for.
        nx = clampd(nx + (nextUnit() - 0.5) * (2.0 / bounds.size.width), marginX,
                    1.0 - marginX);
        ny = clampd(ny + (nextUnit() - 0.5) * (2.0 / bounds.size.height), marginY,
                    1.0 - marginY);
      }

      CGPoint point = CGPointMake(bounds.origin.x + nx * bounds.size.width,
                                  bounds.origin.y + ny * bounds.size.height);
      postMove(point, nx, ny);

      if (pendingClicks > 0 && now >= nextClickUs && phase == 0) {
        postButton(point, nx, ny, true);
        sleepUntil(now + (uint64_t)(between(0.045, 0.09) * 1e6));
        CGPoint up = CGPointMake(bounds.origin.x + nx * bounds.size.width,
                                 bounds.origin.y + ny * bounds.size.height);
        postButton(up, nx, ny, false);
        pendingClicks--;
        nextClickUs = nowUptimeUs() + (uint64_t)(between(0.08, 0.22) * 1e6);
        nextUs = nowUptimeUs() + stepUs;
      }
    }

    // The driven session ends here. Everything after this line is housekeeping and
    // must not land in the log: the recorder stops the sampler on this line, so the
    // walk home below is outside the recording rather than a fast pan in its last
    // half-second.
    {
      char line[64];
      snprintf(line, sizeof line, "{\"k\":\"session-end\",\"tUs\":%llu}",
               (unsigned long long)nowUptimeUs());
      emit(line);
    }

    // Walk the pointer home rather than warping it there. `atexit(restorePointer)` is
    // still the safety net for every abnormal exit, but on the normal path its warp
    // would land a full-screen teleport in the last frame of every recording — an
    // artefact of this tool, in the samples the comfort budget is measured over.
    {
      const double homeSec = 0.5;
      double hx = clampd((gStartPoint.x - bounds.origin.x) / bounds.size.width, 0.0, 1.0);
      double hy = clampd((gStartPoint.y - bounds.origin.y) / bounds.size.height, 0.0, 1.0);
      double fromX = nx, fromY = ny;
      uint64_t homeStart = nowUptimeUs();
      uint64_t homeEnd = homeStart + (uint64_t)(homeSec * 1e6);
      uint64_t at = homeStart;
      while (at < homeEnd) {
        sleepUntil(at);
        at += stepUs;
        double u = clampd((double)(nowUptimeUs() - homeStart) / (homeSec * 1e6), 0.0, 1.0);
        double e = smoothstep(u);
        double px = fromX + (hx - fromX) * e;
        double py = fromY + (hy - fromY) * e;
        postMove(CGPointMake(bounds.origin.x + px * bounds.size.width,
                             bounds.origin.y + py * bounds.size.height),
                 px, py);
      }
    }

    emit("{\"k\":\"bye\"}");
    return 0;
  }
}
