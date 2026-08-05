/*
 * loom-input-sampler — the native half of phase 5.
 *
 * A standalone command-line tool that samples the cursor and, when macOS lets it,
 * global mouse clicks; it prints NDJSON on stdout and never touches the disk.
 * Architecture report §2.5 (the cursor and click log) and §6.1 (input conditioning).
 *
 * Three design points are load-bearing:
 *
 * 1. **It is a separate process, not a Node addon.** `CGEventTapCreate` and
 *    `NSCursor.currentSystemCursor` both need a run loop of their own, and phase 5's
 *    constraint is that sampling must not perturb capture. A child process gets its
 *    own scheduler slot; a native addon would run the tap's run loop source on the
 *    Electron main thread, where a slow tap callback becomes a dropped frame — and
 *    where the kernel's own timeout (`kCGEventTapDisabledByTimeout`) silently kills
 *    the tap. Being a plain CLI also makes the phase-5 gate testable without
 *    Electron: the acceptance test spawns this binary directly.
 *
 * 2. **It writes nothing.** "Main is the only writer to disk" (report §0, rule 2) is
 *    a structural property of this codebase, and a native helper is exactly the kind
 *    of thing that would quietly become a second writer. Events go out as NDJSON on
 *    stdout; the parent decides what lands in the bundle.
 *
 * 3. **A dead event tap is reported, never inferred.** `CGEventTapCreate` is
 *    documented to fail without the Accessibility grant, but the failure it produces
 *    is not consistent: on some releases it returns NULL, on others a port that
 *    reports success and then never fires. Both are checked, plus
 *    `CGEventTapIsEnabled`, plus a 1 Hz watchdog, plus the
 *    `kCGEventTapDisabledBy*` callbacks. Every transition is emitted as a `status`
 *    line. "No clicks happened" and "the tap is dead" must never look the same to a
 *    consumer — phase 10's auto-zoom is driven by this log, and a silent zero there
 *    is a feature that does nothing on a fresh machine with nobody able to say why.
 *
 * Subcommands:
 *   probe                  one JSON line describing permission and tap state, exit
 *   run [options]          sample until stdin closes, `stop` arrives, or SIGTERM
 *   spawn-disclaimed ARGV… re-exec with TCC responsibility disclaimed (see below)
 *
 * `spawn-disclaimed` exists for the acceptance test. macOS attributes a TCC request
 * to the *responsible* process, so a helper launched from a terminal that holds
 * Accessibility inherits that grant — research report §7, trap 6, and the reason
 * "test it from a signed bundle" is in CLAUDE.md. Disclaiming responsibility makes
 * the child answer for its own code identity, which has no grant, so the revoked
 * path can be exercised rather than assumed on any machine.
 *
 * Build: `node packages/sampler/native/build.mjs` (invoked by `npm run build`).
 */

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include <CommonCrypto/CommonDigest.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

/*
 * Private SPI, declared here because it is not in the SDK headers. Weak-imported so
 * a release that drops it degrades to "cannot disclaim" instead of failing to launch.
 */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim)
    __attribute__((weak_import));

static const int kProtocolVersion = 1;

/* ------------------------------------------------------------------ the clock */

/*
 * `CLOCK_UPTIME_RAW` is `mach_absolute_time` in nanoseconds: monotonic, and stopped
 * while the machine is asleep. That is the same epoch Chromium's `base::TimeTicks`
 * uses on macOS, which is what `VideoFrame.timestamp` is derived from — and §2.5
 * requires the cursor log to share its origin with `VideoFrame.timestamp`.
 *
 * The parent converts to seconds against the recording clock's `t0Us`; this process
 * never sees the recording. `hello` also carries `CLOCK_MONOTONIC` so a consumer can
 * relate the two epochs if it ever needs to.
 */
static uint64_t nowUptimeUs(void) {
  return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000ull;
}

static uint64_t nowMonotonicUs(void) {
  return clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1000ull;
}

/* ------------------------------------------------------- buffered NDJSON output */

/*
 * Sampling threads must never block on a `write(2)` to a pipe the parent is slow to
 * drain — that is precisely how a sampler starts perturbing the thing it samples. So
 * lines accumulate in a bounded buffer and a 100 ms timer drains it, matching the
 * §2.5 append cadence. An overrun drops lines and *counts* them; the count is
 * reported in every `health` line, because silently losing samples is the same class
 * of bug as silently losing clicks.
 */
static const NSUInteger kOutputCapBytes = 8u * 1024u * 1024u;

static pthread_mutex_t gOutLock = PTHREAD_MUTEX_INITIALIZER;
static NSMutableData *gOut = nil;
static _Atomic uint64_t gDroppedLines = 0;

static void emitBytes(const void *bytes, size_t length) {
  pthread_mutex_lock(&gOutLock);
  if (gOut.length + length > kOutputCapBytes) {
    pthread_mutex_unlock(&gOutLock);
    atomic_fetch_add(&gDroppedLines, 1);
    return;
  }
  [gOut appendBytes:bytes length:length];
  [gOut appendBytes:"\n" length:1];
  pthread_mutex_unlock(&gOutLock);
}

static void emitData(NSData *line) { emitBytes(line.bytes, line.length); }

/*
 * The two hot lines are formatted by hand, not through `NSJSONSerialization`.
 *
 * Two reasons, both about the constraint that sampling must not perturb capture.
 * `NSJSONSerialization` would allocate a dictionary and five boxed numbers 120 times
 * a second; and it renders a double at full precision, so `round(x*1e4)/1e4` comes
 * out as `0.39290000000000003` — binary-float noise that costs more bytes than the
 * value carries. `%.4f` is exactly the precision §2.5's example log uses: ~0.17 px on
 * a 1728-point display.
 */
static double finite4(double value) { return isfinite(value) ? value : 0.0; }

static void emitCursorLine(uint64_t tUs, double x, double y, const char *shape, NSInteger mask) {
  char line[192];
  int length = snprintf(line, sizeof(line),
                        "{\"k\":\"cursor\",\"tUs\":%llu,\"x\":%.4f,\"y\":%.4f,\"c\":\"%s\","
                        "\"m\":%ld}",
                        (unsigned long long)tUs, finite4(x), finite4(y), shape, (long)mask);
  if (length > 0) emitBytes(line, (size_t)length);
}

static void emitClickLine(uint64_t tUs, bool down, int64_t button, double x, double y,
                          NSInteger mask) {
  char line[192];
  int length = snprintf(line, sizeof(line),
                        "{\"k\":\"click\",\"tUs\":%llu,\"e\":\"%s\",\"b\":%lld,\"x\":%.4f,"
                        "\"y\":%.4f,\"m\":%ld}",
                        (unsigned long long)tUs, down ? "down" : "up", (long long)button,
                        finite4(x), finite4(y), (long)mask);
  if (length > 0) emitBytes(line, (size_t)length);
}

static void emitObject(NSDictionary *object) {
  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (json == nil) {
    fprintf(stderr, "loom-input-sampler: could not serialize a line: %s\n",
            error.localizedDescription.UTF8String);
    return;
  }
  emitData(json);
}

static void writeAll(int fd, const void *bytes, size_t length) {
  const char *cursor = (const char *)bytes;
  size_t remaining = length;
  while (remaining > 0) {
    ssize_t written = write(fd, cursor, remaining);
    if (written > 0) {
      cursor += written;
      remaining -= (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    return; /* The parent is gone. Dropping output is the only option left. */
  }
}

static void flushOutput(void) {
  pthread_mutex_lock(&gOutLock);
  NSData *pending = gOut.length == 0 ? nil : [gOut copy];
  [gOut setLength:0];
  pthread_mutex_unlock(&gOutLock);
  if (pending != nil) writeAll(STDOUT_FILENO, pending.bytes, pending.length);
}

/* ------------------------------------------------------------------- modifiers */

/* §2.5: `m` is a bitfield — 1 shift, 2 ctrl, 4 opt, 8 cmd, 16 fn. */
static NSInteger modifierMask(CGEventFlags flags) {
  NSInteger mask = 0;
  if ((flags & kCGEventFlagMaskShift) != 0) mask |= 1;
  if ((flags & kCGEventFlagMaskControl) != 0) mask |= 2;
  if ((flags & kCGEventFlagMaskAlternate) != 0) mask |= 4;
  if ((flags & kCGEventFlagMaskCommand) != 0) mask |= 8;
  if ((flags & kCGEventFlagMaskSecondaryFn) != 0) mask |= 16;
  return mask;
}

/* -------------------------------------------------------------- the display box */

/*
 * Positions are normalized 0–1 against the *logical* display (§2.5), so a resolution
 * change during a recording does not invalidate the log.
 *
 * Values outside 0–1 are emitted unclamped: they mean the cursor left the recorded
 * display, which is a fact about the recording. Clamping would fabricate a position
 * on an edge the cursor never touched, and phase 10 would pan to it.
 */
typedef struct {
  CGDirectDisplayID id;
  CGRect bounds;      /* points, in the global display space */
  double scaleFactor; /* backing pixels per point */
} DisplayBox;

static _Atomic(CGDirectDisplayID) gTargetDisplay = 0;
static pthread_mutex_t gDisplayLock = PTHREAD_MUTEX_INITIALIZER;
static DisplayBox gDisplay = {0, {{0, 0}, {0, 0}}, 1.0};

static double displayScaleFactor(CGDirectDisplayID display) {
  CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
  if (mode == NULL) return 1.0;
  size_t points = CGDisplayModeGetWidth(mode);
  size_t pixels = CGDisplayModeGetPixelWidth(mode);
  CGDisplayModeRelease(mode);
  if (points == 0) return 1.0;
  return (double)pixels / (double)points;
}

static DisplayBox measureDisplay(CGDirectDisplayID requested) {
  CGDirectDisplayID display = requested;
  CGRect bounds = CGDisplayBounds(display);
  /* A disconnected display measures empty; fall back rather than divide by zero. */
  if (bounds.size.width <= 0 || bounds.size.height <= 0) {
    display = CGMainDisplayID();
    bounds = CGDisplayBounds(display);
  }
  DisplayBox box = {display, bounds, displayScaleFactor(display)};
  return box;
}

static DisplayBox currentDisplay(void) {
  pthread_mutex_lock(&gDisplayLock);
  DisplayBox box = gDisplay;
  pthread_mutex_unlock(&gDisplayLock);
  return box;
}

/* Rounded for the rare lines that still go through `NSJSONSerialization`. */
static NSNumber *rounded4(double value) {
  return @(round(value * 10000.0) / 10000.0);
}

static void normalizePoint(CGPoint point, DisplayBox box, double *x, double *y) {
  *x = (point.x - box.bounds.origin.x) / box.bounds.size.width;
  *y = (point.y - box.bounds.origin.y) / box.bounds.size.height;
}

static void emitDisplayLine(DisplayBox box) {
  emitObject(@{
    @"k" : @"display",
    @"tUs" : @(nowUptimeUs()),
    @"display" : @(box.id),
    @"logicalSize" : @[ @(box.bounds.size.width), @(box.bounds.size.height) ],
    @"scaleFactor" : @(box.scaleFactor),
  });
}

static void refreshDisplay(bool emit) {
  DisplayBox box = measureDisplay(atomic_load(&gTargetDisplay));
  pthread_mutex_lock(&gDisplayLock);
  bool changed = gDisplay.id != box.id || !CGRectEqualToRect(gDisplay.bounds, box.bounds) ||
                 gDisplay.scaleFactor != box.scaleFactor;
  gDisplay = box;
  pthread_mutex_unlock(&gDisplayLock);
  if (emit && changed) emitDisplayLine(box);
}

static void displayReconfigured(CGDirectDisplayID display, CGDisplayChangeSummaryFlags flags,
                                void *userInfo) {
  (void)display;
  (void)flags;
  (void)userInfo;
  refreshDisplay(true);
}

/* ------------------------------------------------------------ cursor bitmaps */

/*
 * §6.7: the cursor is composited from `cursors/<sha256>.png` at the smoothed
 * position, not taken from the screen recording — which is the only reason "make the
 * cursor bigger after the fact" works at all. So the bitmap and its hotspot have to
 * be captured while recording; afterwards the shape is gone.
 *
 * The id is the sha256 of the raw bitmap bytes plus its geometry, not of the encoded
 * PNG: PNG-encoding costs a hundred times as much and the shape is sampled
 * repeatedly. The PNG is produced once, the first time an id is seen, and shipped to
 * the parent in the `cursorimg` line.
 *
 * **The identity check is two-level, and the reason is measured.** macOS hands back a
 * multi-representation cursor image — on this machine 28×40 up to 280×400, the
 * largest being 448 KB. Hashing that on every poll costs 0.146 ms and copying it
 * costs more; hashing the *smallest* rep costs 0.0026 ms. So each poll fingerprints
 * the cheap rep, and only a fingerprint it has not seen before pays for the full
 * hash of the real bitmap. Steady state — a cursor that is not changing, which is
 * almost all of a recording — is then just `currentSystemCursor` at 0.22 ms.
 *
 * Measured end to end on this machine: 120 Hz position plus 10 Hz shape polling costs
 * **1.0% of one core**. Before the two-level check it was 5.2%, essentially all of it
 * hashing and copying a 448 KB bitmap ten to twenty times a second.
 */
/**
 * The largest and smallest bitmap representations of a cursor image.
 *
 * The largest is what gets stored: §6.7's "make the cursor bigger after the fact" is
 * a product feature, and a 10× bitmap costs about 30 KB once per distinct shape
 * against gigabytes of video. The smallest is what gets fingerprinted.
 */
static void bitmapReps(NSImage *image, NSBitmapImageRep **largest, NSBitmapImageRep **smallest) {
  *largest = nil;
  *smallest = nil;
  for (NSImageRep *rep in image.representations) {
    if (![rep isKindOfClass:NSBitmapImageRep.class]) continue;
    NSBitmapImageRep *bitmap = (NSBitmapImageRep *)rep;
    if (*largest == nil || bitmap.pixelsWide > (*largest).pixelsWide) *largest = bitmap;
    if (*smallest == nil || bitmap.pixelsWide < (*smallest).pixelsWide) *smallest = bitmap;
  }
  if (*largest != nil) return;
  NSData *tiff = image.TIFFRepresentation;
  if (tiff == nil) return;
  *largest = [[NSBitmapImageRep alloc] initWithData:tiff];
  *smallest = *largest;
}

/** sha256 of a rep's raw pixels plus the geometry that distinguishes it. */
static NSString *digestOfRep(NSBitmapImageRep *rep, NSPoint hotSpot, NSSize logicalSize) {
  const unsigned char *pixels = rep.bitmapData;
  size_t bytes = (size_t)rep.bytesPerRow * (size_t)rep.pixelsHigh;
  if (pixels == NULL || bytes == 0) return nil;

  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, pixels, (CC_LONG)bytes);
  // Geometry is hashed with the pixels so two shapes that differ only in hotspot —
  // the resize cursors do — never collide onto one content-addressed file.
  double geometry[6] = {hotSpot.x,   hotSpot.y,        logicalSize.width,
                        logicalSize.height, (double)rep.pixelsWide, (double)rep.pixelsHigh};
  CC_SHA256_Update(&context, geometry, (CC_LONG)sizeof(geometry));

  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i += 1) snprintf(hex + i * 2, 3, "%02x", digest[i]);
  return @(hex);
}

typedef struct {
  /** sha256 of the stored bitmap. Also the `c` of every sample using this shape. */
  NSString *identifier;
  /** sha256 of the cheap representation — the per-poll "has anything changed" key. */
  NSString *fingerprint;
  NSString *png; /* base64, only when the id is new */
  double hotspotX, hotspotY;
  double pixelWidth, pixelHeight;
  bool transparent;
} CursorShot;

/*
 * macOS reports a **1×1 fully transparent cursor** while the pointer is hidden —
 * auto-hide-while-typing does this constantly. It is a real shape and it belongs in
 * the log (the pointer genuinely is not on screen, and §6.7 composites the sprite
 * from these bitmaps, so an invisible one must render as nothing). What it must not
 * do is arrive nameless: `hidden` is the difference between the editor showing "no
 * cursor here" and showing an unexplained blank.
 */
static bool isFullyTransparent(NSBitmapImageRep *rep) {
  if (!rep.hasAlpha || rep.bitsPerSample != 8 || rep.samplesPerPixel != 4) return false;
  const unsigned char *pixels = rep.bitmapData;
  if (pixels == NULL) return false;
  NSInteger alphaOffset = (rep.bitmapFormat & NSBitmapFormatAlphaFirst) != 0 ? 0 : 3;
  NSInteger stride = rep.bytesPerRow;
  for (NSInteger row = 0; row < rep.pixelsHigh; row += 1) {
    for (NSInteger column = 0; column < rep.pixelsWide; column += 1) {
      if (pixels[row * stride + column * 4 + alphaOffset] != 0) return false;
    }
  }
  return true;
}

/** The cheap per-poll key. `nil` when the cursor has no usable bitmap. */
static NSString *cursorFingerprint(NSCursor *cursor) {
  NSImage *image = cursor.image;
  if (image == nil) return nil;
  NSBitmapImageRep *largest = nil;
  NSBitmapImageRep *smallest = nil;
  bitmapReps(image, &largest, &smallest);
  if (smallest == nil) return nil;
  return digestOfRep(smallest, cursor.hotSpot, image.size);
}

/** The full capture: the stored bitmap, its id, its hotspot in pixels, its PNG. */
static bool captureCursor(NSCursor *cursor, CursorShot *out) {
  NSImage *image = cursor.image;
  if (image == nil) return false;
  NSBitmapImageRep *rep = nil;
  NSBitmapImageRep *smallest = nil;
  bitmapReps(image, &rep, &smallest);
  if (rep == nil || smallest == nil) return false;

  out->identifier = digestOfRep(rep, cursor.hotSpot, image.size);
  out->fingerprint = rep == smallest ? out->identifier
                                     : digestOfRep(smallest, cursor.hotSpot, image.size);
  if (out->identifier == nil || out->fingerprint == nil) return false;

  double scale = image.size.width > 0 ? (double)rep.pixelsWide / image.size.width : 1.0;
  out->hotspotX = cursor.hotSpot.x * scale; /* `CursorImage.hotspot` is in pixels. */
  out->hotspotY = cursor.hotSpot.y * scale;
  out->pixelWidth = (double)rep.pixelsWide;
  out->pixelHeight = (double)rep.pixelsHigh;
  out->transparent = isFullyTransparent(rep);

  NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  out->png = png == nil ? nil : [png base64EncodedStringWithOptions:0];
  return out->png != nil;
}

/*
 * `cursors/index.json` records a `shape` name so the editor can talk about "the
 * I-beam". macOS exposes no name for the system cursor, so the names are recovered
 * by fingerprinting the process's own `NSCursor` factory cursors once at startup and
 * matching by content hash. An unrecognised cursor is called `unknown`, which is
 * honest; guessing `arrow` would put a wrong name on a real bitmap.
 */
/** `IBeamCursorForVerticalLayout` -> `ibeam-cursor-for-vertical-layout`. */
static NSString *kebabCase(NSString *camel) {
  NSMutableString *out = [NSMutableString stringWithCapacity:camel.length + 4];
  for (NSUInteger i = 0; i < camel.length; i += 1) {
    unichar c = [camel characterAtIndex:i];
    bool upper = c >= 'A' && c <= 'Z';
    /* A run of capitals (`IBeam`) is one word, so only break before the *first*. */
    bool previousLower = i > 0 && !([camel characterAtIndex:i - 1] >= 'A' &&
                                    [camel characterAtIndex:i - 1] <= 'Z');
    if (upper && i > 0 && previousLower) [out appendString:@"-"];
    [out appendFormat:@"%C", (unichar)(upper ? c + 32 : c)];
  }
  return out;
}

static NSDictionary<NSString *, NSString *> *buildShapeNames(void) {
  /*
   * Built by selector rather than as a dictionary literal, and nil-checked at every
   * step: several of these cursors are simply absent in a process with no GUI
   * session, and a literal containing one nil raises — which would take the whole
   * sampler down at startup over a *naming* nicety.
   */
  NSArray<NSString *> *names = @[
    @"arrow",        @"IBeam",       @"IBeamCursorForVerticalLayout",
    @"crosshair",    @"closedHand",  @"openHand",
    @"pointingHand", @"resizeLeft",  @"resizeRight",
    @"resizeLeftRight", @"resizeUp", @"resizeDown",
    @"resizeUpDown", @"disappearingItem", @"operationNotAllowed",
    @"dragLink",     @"dragCopy",    @"contextualMenu",
  ];
  NSMutableDictionary<NSString *, NSString *> *byDigest = [NSMutableDictionary dictionary];
  for (NSString *name in names) {
    SEL selector = NSSelectorFromString([name stringByAppendingString:@"Cursor"]);
    if (![NSCursor respondsToSelector:selector]) continue;
    NSCursor *cursor = nil;
    /* `performSelector` on a class method returning an object; ARC cannot infer the
     * ownership, and these are all +0 autoreleased accessors. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    cursor = [NSCursor performSelector:selector];
#pragma clang diagnostic pop
    if (cursor == nil) continue;
    CursorShot shot;
    if (!captureCursor(cursor, &shot)) continue;
    if (byDigest[shot.identifier] == nil) byDigest[shot.identifier] = kebabCase(name);
  }
  return byDigest;
}

/*
 * Sampled on the main thread (AppKit's requirement), read by the 120 Hz sampler.
 *
 * Held as a fixed C buffer rather than an `NSString` so the sampling thread does no
 * retain/release and no allocation at all: a sha256 in hex is 64 bytes and never any
 * other length. `_Atomic` on a `char[]` is not a thing, hence the seqlock-free
 * approach of a short critical section — it is held for a `memcpy` of 65 bytes.
 */
static pthread_mutex_t gShapeLock = PTHREAD_MUTEX_INITIALIZER;
static char gShapeId[65] = {0};
static _Thread_local char tShapeId[65];

static const char *currentShapeId(void) {
  pthread_mutex_lock(&gShapeLock);
  memcpy(tShapeId, gShapeId, sizeof(tShapeId));
  pthread_mutex_unlock(&gShapeLock);
  return tShapeId;
}

static void setShapeId(NSString *identifier) {
  const char *utf8 = identifier.UTF8String;
  if (utf8 == NULL || strlen(utf8) != 64) return;
  pthread_mutex_lock(&gShapeLock);
  memcpy(gShapeId, utf8, 65);
  pthread_mutex_unlock(&gShapeLock);
}

/* ------------------------------------------------------------- click capture */

/*
 * The whole point of phase 5, per the captain's settled decision: cursor position
 * needs no permission and is the launch default; clicks need Accessibility, which
 * cannot be requested programmatically and **fails silently when absent**.
 */
typedef enum {
  /* Not a state, a starting value: it guarantees the first `setClickState` is a
   * transition, so a session always opens with exactly one `status` line. */
  ClicksUnknown = -1,
  ClicksAvailable = 0,
  ClicksNotRequested,
  ClicksAccessibilityDenied,
  ClicksTapCreateFailed,
  ClicksTapDead,
  ClicksTapDisabledByTimeout,
  ClicksTapDisabledByUserInput,
} ClickState;

static NSString *clickReasonName(ClickState state) {
  switch (state) {
    case ClicksUnknown: return @"unknown";
    case ClicksAvailable: return nil;
    case ClicksNotRequested: return @"not-requested";
    case ClicksAccessibilityDenied: return @"accessibility-denied";
    case ClicksTapCreateFailed: return @"tap-create-failed";
    case ClicksTapDead: return @"tap-dead";
    case ClicksTapDisabledByTimeout: return @"tap-disabled-by-timeout";
    case ClicksTapDisabledByUserInput: return @"tap-disabled-by-user-input";
  }
  return @"unknown";
}

static CFMachPortRef gTap = NULL;
static CFRunLoopSourceRef gTapSource = NULL;
static CFRunLoopRef gTapRunLoop = NULL;
static _Atomic bool gClicksRequested = false;
static _Atomic int gClickState = ClicksUnknown;
static _Atomic uint64_t gClickCount = 0;
static _Atomic uint64_t gSampleCount = 0;
static _Atomic bool gAxTrusted = false;
static _Atomic bool gTapCreated = false;
static _Atomic bool gTapEnabled = false;

static void emitStatus(void) {
  ClickState state = (ClickState)atomic_load(&gClickState);
  NSString *reason = clickReasonName(state);
  emitObject(@{
    @"k" : @"status",
    @"tUs" : @(nowUptimeUs()),
    @"clicks" : @{
      @"available" : (state == ClicksAvailable ? @YES : @NO),
      @"reason" : reason == nil ? (id)[NSNull null] : (id)reason,
      @"requested" : @(atomic_load(&gClicksRequested)),
      @"axTrusted" : @(atomic_load(&gAxTrusted)),
      @"tapCreated" : @(atomic_load(&gTapCreated)),
      @"tapEnabled" : @(atomic_load(&gTapEnabled)),
    },
  });
}

/* Report only transitions, so a consumer that sees a status line knows something
 * changed — and so a dead tap cannot hide inside a stream of identical lines. */
static void setClickState(ClickState next) {
  int previous = atomic_exchange(&gClickState, (int)next);
  if (previous != (int)next) emitStatus();
}

static CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event,
                              void *userInfo) {
  (void)proxy;
  (void)userInfo;

  /*
   * The kernel disables a tap that takes too long, and a user-initiated disable is
   * possible too. Both arrive here as an event type, and both are the "went dead
   * mid-recording" case §7.3 is about: re-enable, and say so either way.
   */
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    setClickState(type == kCGEventTapDisabledByTimeout ? ClicksTapDisabledByTimeout
                                                       : ClicksTapDisabledByUserInput);
    atomic_store(&gTapEnabled, false);
    if (gTap != NULL) {
      CGEventTapEnable(gTap, true);
      bool enabled = CGEventTapIsEnabled(gTap);
      atomic_store(&gTapEnabled, enabled);
      if (enabled) setClickState(ClicksAvailable);
    }
    return event;
  }

  bool down = type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown ||
              type == kCGEventOtherMouseDown;
  bool up =
      type == kCGEventLeftMouseUp || type == kCGEventRightMouseUp || type == kCGEventOtherMouseUp;
  if (!down && !up) return event;

  DisplayBox box = currentDisplay();
  double x = 0;
  double y = 0;
  normalizePoint(CGEventGetLocation(event), box, &x, &y);

  atomic_fetch_add(&gClickCount, 1);
  emitClickLine(nowUptimeUs(), down, CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber),
                x, y, modifierMask(CGEventGetFlags(event)));
  return event;
}

/*
 * Build the tap, gated on **both** `AXIsProcessTrusted()` and `CGEventTapIsEnabled`.
 *
 * The first gate is the documented one. The second is the one that matters: without
 * the grant, `CGEventTapCreate` has been observed both to return NULL and to return a
 * port that reports success and then never delivers an event. Checking only the
 * return value is how "auto-zoom does nothing and nobody can tell why" happens.
 */
static bool startTap(void) {
  bool trusted = AXIsProcessTrusted();
  atomic_store(&gAxTrusted, trusted);
  if (!trusted) {
    setClickState(ClicksAccessibilityDenied);
    return false;
  }

  CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
                     CGEventMaskBit(kCGEventRightMouseDown) |
                     CGEventMaskBit(kCGEventRightMouseUp) |
                     CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp);

  /* Listen-only: this app observes input, it never modifies or swallows it. */
  gTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
                          mask, tapCallback, NULL);
  if (gTap == NULL) {
    atomic_store(&gTapCreated, false);
    setClickState(ClicksTapCreateFailed);
    return false;
  }
  atomic_store(&gTapCreated, true);

  CGEventTapEnable(gTap, true);
  if (!CGEventTapIsEnabled(gTap)) {
    atomic_store(&gTapEnabled, false);
    setClickState(ClicksTapDead);
    CFRelease(gTap);
    gTap = NULL;
    atomic_store(&gTapCreated, false);
    return false;
  }
  atomic_store(&gTapEnabled, true);
  setClickState(ClicksAvailable);
  return true;
}

/*
 * The tap gets a thread whose run loop does nothing else.
 *
 * Sharing a run loop with the cursor-shape poll would let a slow AppKit call delay a
 * tap callback past the kernel's timeout, which disables the tap — turning a
 * scheduling hiccup into lost clicks.
 */
static void *tapThread(void *unused) {
  (void)unused;
  @autoreleasepool {
    pthread_setname_np("loom.clicktap");
    gTapRunLoop = CFRunLoopGetCurrent();
    gTapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, gTap, 0);
    if (gTapSource != NULL) CFRunLoopAddSource(gTapRunLoop, gTapSource, kCFRunLoopCommonModes);
  }
  CFRunLoopRun();
  return NULL;
}

/* ------------------------------------------------------------------ shutdown */

static _Atomic bool gStopping = false;

static void requestStop(void) {
  if (atomic_exchange(&gStopping, true)) return;
  if (gTapRunLoop != NULL) CFRunLoopStop(gTapRunLoop);
  CFRunLoopStop(CFRunLoopGetMain());
}

/*
 * Signals are handled through dispatch sources, not `signal(2)` handlers.
 *
 * The shutdown path calls `CFRunLoopStop` and flushes an `NSMutableData` behind a
 * mutex — neither is async-signal-safe, and a `SIGTERM` that lands inside
 * `emitBytes` would deadlock on a lock the interrupted thread already holds. A
 * dispatch source delivers the signal as ordinary work on a queue instead. The
 * default disposition must be ignored first, or the process dies before the source
 * ever runs.
 */
static void watchSignal(int number, dispatch_source_t *out) {
  signal(number, SIG_IGN);
  dispatch_source_t source =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)number, 0,
                             dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  dispatch_source_set_event_handler(source, ^{
    requestStop();
  });
  dispatch_resume(source);
  *out = source;
}

/* ---------------------------------------------------------------- subcommands */

static NSDictionary *probeReport(void) {
  bool trusted = AXIsProcessTrusted();
  bool tapCreated = false;
  bool tapEnabled = false;
  ClickState state = ClicksAccessibilityDenied;

  /*
   * Only build a probe tap when trusted. `AXIsProcessTrusted` never prompts, and
   * neither does `CGEventTapCreate`; but creating a tap we do not intend to read is
   * still work the window server has to do, and phase 2 calls this on every launch.
   */
  if (trusted) {
    CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown);
    CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                                         kCGEventTapOptionListenOnly, mask, tapCallback, NULL);
    tapCreated = tap != NULL;
    if (tap != NULL) {
      CGEventTapEnable(tap, true);
      tapEnabled = CGEventTapIsEnabled(tap);
      CGEventTapEnable(tap, false);
      CFRelease(tap);
    }
    state = tapCreated ? (tapEnabled ? ClicksAvailable : ClicksTapDead) : ClicksTapCreateFailed;
  }

  NSString *reason = clickReasonName(state);
  DisplayBox box = measureDisplay(CGMainDisplayID());
  return @{
    @"k" : @"probe",
    @"version" : @(kProtocolVersion),
    @"tUs" : @(nowUptimeUs()),
    @"pid" : @(getpid()),
    @"os" : NSProcessInfo.processInfo.operatingSystemVersionString,
    @"clicks" : @{
      @"available" : (state == ClicksAvailable ? @YES : @NO),
      @"reason" : reason == nil ? (id)[NSNull null] : (id)reason,
      @"requested" : @YES,
      @"axTrusted" : @(trusted),
      @"tapCreated" : @(tapCreated),
      @"tapEnabled" : @(tapEnabled),
    },
    @"display" : @{
      @"display" : @(box.id),
      @"logicalSize" : @[ @(box.bounds.size.width), @(box.bounds.size.height) ],
      @"scaleFactor" : @(box.scaleFactor),
    },
  };
}

static int runProbe(void) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:probeReport() options:0 error:NULL];
  if (json == nil) return 1;
  writeAll(STDOUT_FILENO, json.bytes, json.length);
  writeAll(STDOUT_FILENO, "\n", 1);
  return 0;
}

/*
 * stdin is both the command channel and the parent's liveness signal: EOF means the
 * app is gone, and a sampler that outlived its parent would keep a tap on the user's
 * input with nobody reading it.
 */
static void startStdinWatch(void) {
  dispatch_queue_t queue = dispatch_queue_create("loom.stdin", DISPATCH_QUEUE_SERIAL);
  dispatch_async(queue, ^{
    @autoreleasepool {
      char buffer[512];
      NSMutableString *line = [NSMutableString string];
      for (;;) {
        ssize_t got = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (got == 0) break; /* parent closed the pipe */
        if (got < 0) {
          if (errno == EINTR) continue;
          break;
        }
        [line appendString:[[NSString alloc] initWithBytes:buffer
                                                    length:(NSUInteger)got
                                                  encoding:NSUTF8StringEncoding]];
        NSRange newline;
        while ((newline = [line rangeOfString:@"\n"]).location != NSNotFound) {
          NSString *one = [line substringToIndex:newline.location];
          [line deleteCharactersInRange:NSMakeRange(0, newline.location + 1)];
          NSData *data = [one dataUsingEncoding:NSUTF8StringEncoding];
          id parsed = data == nil
                          ? nil
                          : [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
          if (![parsed isKindOfClass:NSDictionary.class]) continue;
          NSString *command = parsed[@"cmd"];
          if ([command isEqualToString:@"stop"]) {
            requestStop();
            return;
          }
          if ([command isEqualToString:@"display"]) {
            NSNumber *identifier = parsed[@"id"];
            if (identifier != nil) {
              atomic_store(&gTargetDisplay, (CGDirectDisplayID)identifier.unsignedIntValue);
              refreshDisplay(true);
            }
          }
        }
      }
      requestStop();
    }
  });
}

typedef struct {
  double hz;
  double shapeHz;
  double flushMs;
  bool clicks;
  CGDirectDisplayID display;
} RunOptions;

static int runSampler(RunOptions options) {
  gOut = [NSMutableData dataWithCapacity:64 * 1024];

  /*
   * AppKit needs a shared application before `NSCursor`'s factory cursors return
   * anything: in a process that has never called this, every one of them is a 0×0
   * image, so the shape-name fingerprint table comes back empty and every cursor in
   * `cursors/index.json` is named `unknown`. `Prohibited` is what keeps that from
   * costing a Dock icon, a menu bar or a window — this helper must stay invisible.
   */
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

  atomic_store(&gTargetDisplay, options.display);
  atomic_store(&gClicksRequested, options.clicks);
  refreshDisplay(false);

  // A parent that goes away mid-write must not kill us before the buffer is flushed.
  signal(SIGPIPE, SIG_IGN);
  dispatch_source_t termSource = NULL;
  dispatch_source_t intSource = NULL;
  watchSignal(SIGTERM, &termSource);
  watchSignal(SIGINT, &intSource);

  NSDictionary<NSString *, NSString *> *shapeNames = buildShapeNames();
  NSMutableSet<NSString *> *seenShapes = [NSMutableSet set];

  emitObject(@{
    @"k" : @"hello",
    @"version" : @(kProtocolVersion),
    @"pid" : @(getpid()),
    @"tUs" : @(nowUptimeUs()),
    @"monotonicUs" : @(nowMonotonicUs()),
    @"hz" : @(options.hz),
    /* Zero here means AppKit gave us no cursors to fingerprint, so every shape in
     * `cursors/index.json` will be `unknown`. Worth being able to see. */
    @"shapeNames" : @(shapeNames.count),
  });
  emitDisplayLine(currentDisplay());

  /* Clicks first, so the very first status line already tells the truth about them. */
  if (options.clicks) {
    if (startTap()) {
      pthread_t thread;
      pthread_create(&thread, NULL, tapThread, NULL);
      pthread_detach(thread);
    }
  } else {
    setClickState(ClicksNotRequested);
  }

  CGDisplayRegisterReconfigurationCallback(displayReconfigured, NULL);

  /*
   * Position sampling: §6.1 specifies 120 Hz, measured at 0.383 µs/call, and 120 Hz
   * also feeds the 125 Hz spring grid almost exactly. A user-interactive queue with
   * zero leeway is what keeps the interval honest; the scout measured 0.42 ms sd.
   */
  dispatch_queue_t sampleQueue = dispatch_queue_create_with_target(
      "loom.sample", DISPATCH_QUEUE_SERIAL,
      dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0));
  dispatch_source_t sampleTimer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, sampleQueue);
  uint64_t interval = (uint64_t)(NSEC_PER_SEC / options.hz);
  dispatch_source_set_timer(sampleTimer, DISPATCH_TIME_NOW, interval, 0);
  dispatch_source_set_event_handler(sampleTimer, ^{
    CGEventRef probe = CGEventCreate(NULL);
    if (probe == NULL) return;
    CGPoint location = CGEventGetLocation(probe);
    CFRelease(probe);

    DisplayBox box = currentDisplay();
    double x = 0;
    double y = 0;
    normalizePoint(location, box, &x, &y);
    atomic_fetch_add(&gSampleCount, 1);
    emitCursorLine(nowUptimeUs(), x, y, currentShapeId(),
                   modifierMask(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState)));
  });

  /*
   * Cursor *shape* is polled far slower than position, and on the main thread because
   * `NSCursor` is AppKit. Position is what phase 10's follow math integrates; the
   * shape only has to be right to within a frame or two, and §6.1 replaces shape
   * segments shorter than a second with the dominant shape at edit time anyway — so
   * polling faster than this buys nothing that survives the pipeline.
   *
   * Two caches sit under it, and together they are what keeps the poll off the
   * critical path: `lastFingerprint` skips everything when the cursor has not changed
   * since the previous poll (almost every poll), and `idByFingerprint` skips the
   * expensive hash for a shape seen earlier in the recording.
   */
  __block NSString *lastFingerprint = nil;
  NSMutableDictionary<NSString *, NSString *> *idByFingerprint = [NSMutableDictionary dictionary];

  dispatch_source_t shapeTimer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(shapeTimer, DISPATCH_TIME_NOW,
                            (uint64_t)(NSEC_PER_SEC / options.shapeHz), NSEC_PER_MSEC * 5);
  dispatch_source_set_event_handler(shapeTimer, ^{
    @autoreleasepool {
      NSCursor *cursor = NSCursor.currentSystemCursor;
      if (cursor == nil) cursor = NSCursor.arrowCursor;

      NSString *fingerprint = cursorFingerprint(cursor);
      if (fingerprint == nil) return;
      if ([fingerprint isEqualToString:lastFingerprint]) return; /* unchanged */
      lastFingerprint = fingerprint;

      NSString *known = idByFingerprint[fingerprint];
      if (known != nil) {
        setShapeId(known);
        return;
      }

      CursorShot shot;
      if (!captureCursor(cursor, &shot)) {
        // Forget the fingerprint, or a shape that failed to encode once would never
        // be attempted again and every later sample would carry the previous id.
        lastFingerprint = nil;
        return;
      }
      idByFingerprint[shot.fingerprint] = shot.identifier;
      setShapeId(shot.identifier);
      if ([seenShapes containsObject:shot.identifier]) return;
      [seenShapes addObject:shot.identifier];

      NSString *name = shapeNames[shot.identifier];
      if (name == nil && shot.transparent) name = @"hidden";
      emitObject(@{
        @"k" : @"cursorimg",
        @"id" : shot.identifier,
        @"shape" : name == nil ? @"unknown" : name,
        @"hotspot" : @[ rounded4(shot.hotspotX), rounded4(shot.hotspotY) ],
        @"size" : @[ @(shot.pixelWidth), @(shot.pixelHeight) ],
        @"png" : shot.png,
      });
    }
  });

  dispatch_source_t flushTimer = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
      dispatch_queue_create_with_target("loom.flush", DISPATCH_QUEUE_SERIAL,
                                        dispatch_get_global_queue(QOS_CLASS_UTILITY, 0)));
  dispatch_source_set_timer(flushTimer, DISPATCH_TIME_NOW,
                            (uint64_t)(NSEC_PER_MSEC * options.flushMs), NSEC_PER_MSEC);
  dispatch_source_set_event_handler(flushTimer, ^{
    flushOutput();
  });

  /*
   * The watchdog. A tap can die without ever calling back — a revoked grant mid-
   * session (§7.3) is exactly that — so liveness is polled rather than trusted, and
   * the `health` line gives every consumer positive evidence that the sampler is
   * alive and what it has actually seen. Counts are the honest denominator behind
   * "no clicks happened".
   */
  dispatch_source_t healthTimer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(healthTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
                            NSEC_PER_SEC, NSEC_PER_MSEC * 50);
  dispatch_source_set_event_handler(healthTimer, ^{
    @autoreleasepool {
      if (atomic_load(&gClicksRequested)) {
        bool trusted = AXIsProcessTrusted();
        atomic_store(&gAxTrusted, trusted);
        if (gTap != NULL) {
          bool enabled = CGEventTapIsEnabled(gTap);
          atomic_store(&gTapEnabled, enabled);
          if (!trusted) {
            setClickState(ClicksAccessibilityDenied);
          } else if (!enabled) {
            setClickState(ClicksTapDead);
          } else {
            setClickState(ClicksAvailable);
          }
        } else if (!trusted) {
          setClickState(ClicksAccessibilityDenied);
        }
      }
      emitObject(@{
        @"k" : @"health",
        @"tUs" : @(nowUptimeUs()),
        @"samples" : @(atomic_load(&gSampleCount)),
        @"clicks" : @(atomic_load(&gClickCount)),
        @"dropped" : @(atomic_load(&gDroppedLines)),
        @"axTrusted" : @(atomic_load(&gAxTrusted)),
        @"tapCreated" : @(atomic_load(&gTapCreated)),
        @"tapEnabled" : @(atomic_load(&gTapEnabled)),
      });
    }
  });

  dispatch_resume(sampleTimer);
  dispatch_resume(shapeTimer);
  dispatch_resume(flushTimer);
  dispatch_resume(healthTimer);
  startStdinWatch();

  CFRunLoopRun();

  dispatch_source_cancel(sampleTimer);
  dispatch_source_cancel(shapeTimer);
  dispatch_source_cancel(healthTimer);
  dispatch_source_cancel(flushTimer);
  dispatch_source_cancel(termSource);
  dispatch_source_cancel(intSource);
  CGDisplayRemoveReconfigurationCallback(displayReconfigured, NULL);
  if (gTap != NULL) CGEventTapEnable(gTap, false);
  emitObject(@{@"k" : @"bye", @"tUs" : @(nowUptimeUs())});
  flushOutput();
  return 0;
}

/*
 * Re-exec ourselves with TCC responsibility disclaimed, so the child answers for its
 * own code identity instead of inheriting the terminal's Accessibility grant.
 * Used by the phase-5 acceptance test to *exercise* the revoked path on a machine
 * where the developer's terminal happens to be trusted.
 */
static int runSpawnDisclaimed(int argc, char **argv) {
  if (responsibility_spawnattrs_setdisclaim == NULL) {
    fprintf(stderr, "loom-input-sampler: disclaim SPI unavailable on this system\n");
    return 70;
  }
  posix_spawnattr_t attributes;
  if (posix_spawnattr_init(&attributes) != 0) return 70;
  if (responsibility_spawnattrs_setdisclaim(&attributes, 1) != 0) {
    posix_spawnattr_destroy(&attributes);
    fprintf(stderr, "loom-input-sampler: could not disclaim TCC responsibility\n");
    return 70;
  }

  char **childArgv = calloc((size_t)argc, sizeof(char *));
  if (childArgv == NULL) return 70;
  childArgv[0] = argv[0];
  for (int i = 2; i < argc; i += 1) childArgv[i - 1] = argv[i];

  pid_t child = 0;
  int rc = posix_spawn(&child, argv[0], NULL, &attributes, childArgv, environ);
  posix_spawnattr_destroy(&attributes);
  free(childArgv);
  if (rc != 0) {
    fprintf(stderr, "loom-input-sampler: posix_spawn failed: %s\n", strerror(rc));
    return 70;
  }

  int status = 0;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) continue;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 70;
}

static double doubleArgument(int argc, char **argv, const char *name, double fallback) {
  for (int i = 0; i + 1 < argc; i += 1) {
    if (strcmp(argv[i], name) == 0) return atof(argv[i + 1]);
  }
  return fallback;
}

static void usage(void) {
  fprintf(stderr,
          "usage: loom-input-sampler <probe|run|shapes|spawn-disclaimed>\n"
          "  run [--hz 120] [--shape-hz 10] [--flush-ms 100] [--display <id>] [--no-clicks]\n");
}

/*
 * Print the shape fingerprint table. Diagnostic, and the only way to check the
 * naming half of cursor capture without a human moving a mouse over a text field.
 */
static int runShapes(void) {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
  NSData *json = [NSJSONSerialization dataWithJSONObject:buildShapeNames() options:0 error:NULL];
  if (json == nil) return 1;
  writeAll(STDOUT_FILENO, json.bytes, json.length);
  writeAll(STDOUT_FILENO, "\n", 1);
  return 0;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 2) {
      usage();
      return 64;
    }
    if (strcmp(argv[1], "probe") == 0) return runProbe();
    if (strcmp(argv[1], "shapes") == 0) return runShapes();
    if (strcmp(argv[1], "spawn-disclaimed") == 0) return runSpawnDisclaimed(argc, argv);
    if (strcmp(argv[1], "run") != 0) {
      usage();
      return 64;
    }

    RunOptions options = {
        .hz = doubleArgument(argc, argv, "--hz", 120.0),
        .shapeHz = doubleArgument(argc, argv, "--shape-hz", 10.0),
        .flushMs = doubleArgument(argc, argv, "--flush-ms", 100.0),
        .clicks = true,
        .display = CGMainDisplayID(),
    };
    for (int i = 2; i < argc; i += 1) {
      if (strcmp(argv[i], "--no-clicks") == 0) options.clicks = false;
    }
    double display = doubleArgument(argc, argv, "--display", 0);
    if (display > 0) options.display = (CGDirectDisplayID)display;
    if (options.hz <= 0 || options.hz > 1000) options.hz = 120.0;
    if (options.shapeHz <= 0 || options.shapeHz > 240) options.shapeHz = 10.0;
    if (options.flushMs < 1 || options.flushMs > 5000) options.flushMs = 100.0;

    return runSampler(options);
  }
}
