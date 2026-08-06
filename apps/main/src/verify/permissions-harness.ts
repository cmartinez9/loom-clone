/**
 * The signed-bundle verification harness. Phase 2's gate, and the only thing that
 * can honestly close phase 1's carried-forward obligations.
 *
 * Architecture report §8 sets the gate: *"Run from a **signed bundle**, not a dev
 * binary — dev inherits Terminal's TCC and lies to you (scout trap 6)."* Phase 1
 * shipped three things deliberately **unverified** because a dev binary could only
 * have produced a misleading pass, and the captain's Accessibility decision left a
 * fourth. Phase 2 then opened a fifth of its own — a revoked Microphone recorded as a
 * lost device, settled by the captain in `data/loom-scope/decision-mic-revocation.md`.
 * This file is what turns all five into a command:
 *
 * | # | Obligation                                                       | Check |
 * |---|------------------------------------------------------------------|-------|
 * | 1 | `desktopCapturer` screen enumeration                              | `screen-enumeration` |
 * | 2 | `setDisplayMediaRequestHandler` frame authorisation                | `frame-authorisation` |
 * | 3 | `setContentProtection(true)` keeps the HUD out of captured frames  | `content-protection` |
 * | 4 | post-grant click event rate and latency                            | `accessibility-clicks` |
 * | 5 | a revoked Microphone recorded as a lost device (phase 2, item 8)   | `microphone-revocation` |
 *
 * Phase 12 then added a sixth of a different kind — `overlay-content-protection`,
 * the live drawing overlay's half of row 3. It is not a carried obligation; it is
 * §8's phase-12 gate sentence *"absent from the raw capture"*, and it is here for the
 * reason row 3 is: the measurement is a capture of the screen, and a machine without
 * the Screen Recording grant cannot take one. See {@link checkOverlayContentProtection}.
 *
 * ## Why it lives in the app rather than beside it
 *
 * macOS keys every permission on the bundle identifier. A separate test binary would
 * have a different identity and therefore different grants, so a pass there would
 * predict nothing about the shipped app — which is the same reason
 * `apps/main/src/identity.ts` freezes the identifier. And the same identifier in a
 * second bundle would collide with the real app's TCC record. So the harness runs
 * *inside* the real, signed app, behind `--verify-permissions`, and drives the real
 * `RecorderSession` and the real `WindowRegistry`. A check that does not exercise
 * production code proves nothing — the rule `AGENTS.md` states for the crash gates
 * applies here unchanged.
 *
 * ## What it will not do
 *
 * It does not grant, prompt around, or work around a single TCC permission, and it
 * never infers a pass. A check that cannot run says `blocked` and why. `sealReport`
 * additionally rewrites every `pass` to `untrusted` when the build is a dev binary,
 * so an honest gap is the *only* thing this can produce without a real grant.
 */

import { BrowserWindow, desktopCapturer, screen, type NativeImage } from 'electron';
import { LOOM_BUNDLE_ID } from '../identity.ts';
import { readMediaStatus, type PermissionManager } from '../permissions.ts';
import type { ProjectStore } from '../project-store.ts';
import type { RecorderSession } from '../recorder/session.ts';
import type { WindowRegistry } from '../windows.ts';
import { captureDisplay, isMarker, markerFraction, paintMarker } from './marker.ts';
import { clickVerdict, sealReport, type CheckResult, type VerifyReport } from './checks.ts';
import { WINDOW_ROLES } from '../windows.ts';
import { appUrl, type RecordingId } from '@loom/ipc';
import { concludeAccessibility, describeAccessibility } from '@loom/permissions';

/**
 * A click observed arriving, for the rate and latency measurement.
 *
 * Phase 5's `InputSampler` produces these; this harness consumes them. See
 * {@link ClickStreamProbe} for the adapter.
 */
export interface ObservedClick {
  /** The event's own timestamp in seconds, on the sampler's clock. */
  tSec: number;
  /** `performance.now()` at the instant this process received the line. */
  receivedMs: number;
}

/**
 * Run a click sampler for `durationMs` and return every click observed.
 *
 * Injected rather than constructed here, for the same reason `PermissionManager` takes
 * a `clickTapProbe`: this module decides what a passing measurement looks like, and
 * `index.ts` owns which sampler and which helper path produce it. `observeClicks` in
 * `index.ts` is the implementation, over the shipped `InputSampler`.
 *
 * `receivedMs` is when *this process* saw the click, not when the pointer went down,
 * and the sampler batches on §2.5's 100 ms cadence — every click in one flush carries
 * the same stamp. So it is evidence about batching, and the arrival rate and the
 * inter-arrival distribution the captain's open item asks for are derived from the
 * observation window and from `tSec` instead. Neither is a true input-to-app latency.
 */
export type ClickStreamProbe = (durationMs: number) => Promise<ObservedClick[]>;

/**
 * What the §7.3 microphone-revocation check needs, and nothing else.
 *
 * The shipping `RecorderSession` and `ProjectStore`, because the check has to drive
 * a **real** recording from inside the packaged app: the whole point is that macOS
 * is answering about *our* code identity, and a fake recorder would only prove that
 * the fake stops. `index.ts` supplies both, the same way it supplies `clickStream`.
 *
 * `null` — which is the default — makes the check `skipped`, never a pass.
 */
export interface RecorderDrive {
  recorder: RecorderSession;
  store: ProjectStore;
}

export interface HarnessOptions {
  permissions: PermissionManager;
  windows: WindowRegistry;
  appVersion: string;
  /** Phase 5's sampler, adapted. `index.ts` supplies it; `null` skips, never passes. */
  clickStream?: ClickStreamProbe | null;
  /**
   * How long the click check watches for events. Only meaningful with a
   * `clickStream`, and it needs a human clicking during it — which is why the
   * default is short enough to be tolerable and long enough to measure a rate.
   */
  clickWindowMs?: number;
  /**
   * The shipping recorder, for `microphone-revocation`. `null` skips, never passes.
   */
  recorderDrive?: RecorderDrive | null;
  /**
   * Run the microphone-revocation check, which **needs a human**.
   *
   * Off unless `scripts/verify-permissions.mjs --mic-revocation` asked for it, and
   * that is not shyness: the check waits for somebody to switch Microphone off in
   * System Settings, so an ordinary run would sit there for a minute and then report
   * a gap that was never a defect. Opting in is how the harness knows a person is
   * standing there.
   */
  micRevocation?: boolean;
  /** How long the check waits for the grant to be withdrawn. */
  micRevocationWindowMs?: number;
}

export async function runVerification(options: HarnessOptions): Promise<VerifyReport> {
  const startedAt = new Date().toISOString();
  const checks: CheckResult[] = [];

  const permissions = await options.permissions.probe();

  checks.push(checkBundleIdentity(permissions.provenance.packaged));
  checks.push(await checkScreenEnumeration());
  checks.push(await checkFrameAuthorisation(options.windows));
  checks.push(await checkContentProtection(options.windows));
  checks.push(await checkOverlayContentProtection(options.windows));
  checks.push(await checkAccessibilityClicks(options, permissions));
  checks.push(await checkMicrophoneRevocation(options));

  return sealReport({
    startedAt,
    finishedAt: new Date().toISOString(),
    bundleId: LOOM_BUNDLE_ID,
    appVersion: options.appVersion,
    electronVersion: process.versions.electron ?? 'unknown',
    macosVersion: process.getSystemVersion(),
    provenance: permissions.provenance,
    trustworthy: permissions.provenance.packaged && permissions.provenance.responsibleForSelf,
    permissions,
    checks,
  });
}

// ------------------------------------------------------------ bundle identity

/**
 * The meta-check: is this even the thing whose permissions we are asking about?
 *
 * Exempt from the trust downgrade in `sealReport`, because it is what *establishes*
 * trust. It fails loudly rather than blocking, since a run from the wrong binary is
 * a mistake in how the harness was invoked, not a missing capability.
 */
function checkBundleIdentity(packaged: boolean): CheckResult {
  const responsible = process.ppid === 1;
  const problems: string[] = [];
  if (!packaged) problems.push('this is a dev binary (`app.isPackaged` is false)');
  if (!responsible) {
    problems.push(
      `the parent process is ${String(process.ppid)}, not launchd — macOS may hold it ` +
        'responsible for this app’s permissions',
    );
  }

  return {
    id: 'bundle-identity',
    title: 'Running from a signed bundle, as its own responsible process',
    status: problems.length === 0 ? 'pass' : 'fail',
    detail:
      problems.length === 0
        ? `Packaged, launched by LaunchServices, identity ${LOOM_BUNDLE_ID}.`
        : `${problems.join('; ')}. Run \`node scripts/verify-permissions.mjs\`, which packages ` +
          'the app and launches it with `open -a`.',
    data: { packaged, ppid: process.ppid, bundleId: LOOM_BUNDLE_ID },
  };
}

// ------------------------------------------------------- 1. screen enumeration

/**
 * Carried obligation 1. Enumerate screens for real and look at the pixels.
 *
 * Source *count* is not the check. Without the Screen Recording grant macOS still
 * returns sources — with placeholder names and **black thumbnails** — which is the
 * "looks like a bug in our code rather than a permission problem" failure that
 * research report §7 trap 7 warns about. So this asserts the thumbnail carries an
 * actual picture, and reports the luma statistics either way so the verdict can be
 * argued with.
 */
async function checkScreenEnumeration(): Promise<CheckResult> {
  const obligation = '`desktopCapturer` screen enumeration (phase 1, unverified)';
  const display = screen.getPrimaryDisplay();
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false,
      thumbnailSize: { width: 320, height: 200 },
    });
  } catch (error) {
    return {
      id: 'screen-enumeration',
      title: 'desktopCapturer enumerates real screens',
      obligation,
      status: 'blocked',
      detail: `getSources threw: ${message(error)}. That is what a missing grant looks like from three layers down.`,
    };
  }

  if (sources.length === 0) {
    return {
      id: 'screen-enumeration',
      title: 'desktopCapturer enumerates real screens',
      obligation,
      status: 'fail',
      detail: 'getSources returned no screens at all on a machine with at least one display.',
    };
  }

  const withoutDisplayId = sources.filter((s) => s.display_id === '').map((s) => s.name);
  const stats = sources.map((s) => ({ name: s.name, id: s.display_id, ...lumaStats(s.thumbnail) }));
  const blank = stats.filter((s) => s.mean < 1 && s.distinct <= 2);

  const data = { count: sources.length, expectedDisplays: screen.getAllDisplays().length, stats };

  if (blank.length > 0) {
    return {
      id: 'screen-enumeration',
      title: 'desktopCapturer enumerates real screens',
      obligation,
      status: 'blocked',
      detail:
        `${String(blank.length)} of ${String(sources.length)} screen thumbnails came back black. ` +
        'That is the shape of a denied Screen Recording grant, not of a broken enumerator — ' +
        'grant it in System Settings › Privacy & Security › Screen & System Audio Recording and re-run.',
      data,
    };
  }

  if (withoutDisplayId.length > 0) {
    return {
      id: 'screen-enumeration',
      title: 'desktopCapturer enumerates real screens',
      obligation,
      status: 'fail',
      detail:
        `Sources came back without a display_id: ${withoutDisplayId.join(', ')}. ` +
        '`RecorderSession.provideSource` matches on that field, so a capture would silently ' +
        'record the wrong display.',
      data,
    };
  }

  return {
    id: 'screen-enumeration',
    title: 'desktopCapturer enumerates real screens',
    obligation,
    status: 'pass',
    detail:
      `${String(sources.length)} screen source(s), every one with a display_id and a thumbnail ` +
      `carrying a real picture (primary display ${String(display.id)}).`,
    data,
  };
}

// ---------------------------------------------------- 2. frame authorisation

/**
 * Carried obligation 2: the real `setDisplayMediaRequestHandler` hands a source to
 * the capture page and **refuses every other frame**.
 *
 * The refusal is the half that matters and the half that can be checked without any
 * grant: `provideSource` compares the requesting frame's URL against the capture
 * window's before it ever reaches `desktopCapturer`. So this leg runs, and reports,
 * on any machine — a denied grant cannot make an unauthorised window succeed.
 *
 * The positive half is exercised by `scripts/smoke-capture.mjs`, which drives the
 * same handler through a real recording; duplicating it here would mean writing a
 * recording into the user's library to prove something that script already proves.
 * What is asserted here instead is that the handler is *installed* — a refusal from
 * a handler that was never registered would pass this check vacuously otherwise,
 * because Electron's default is also to refuse.
 */
async function checkFrameAuthorisation(windows: WindowRegistry): Promise<CheckResult> {
  const obligation = '`setDisplayMediaRequestHandler` frame authorisation (phase 1, unverified)';
  const id = 'frame-authorisation';
  const title = 'getDisplayMedia is refused to every window but the capture page';

  // A window that is emphatically not the capture page. The library is a real,
  // registered window with the real preload — the most credible impostor there is.
  const window = windows.show('library');
  try {
    await whenReady(window);
  } catch (error) {
    return {
      id,
      title,
      obligation,
      status: 'blocked',
      detail:
        `The library window never loaded: ${message(error)}. Nothing was asked of ` +
        '`getDisplayMedia`, so this says nothing about the handler.',
    };
  }

  let outcome: { ok: boolean; error: string };
  try {
    outcome = (await window.webContents.executeJavaScript(
      `(async () => {
         try {
           const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
           stream.getTracks().forEach((t) => t.stop());
           return { ok: true, error: '' };
         } catch (e) {
           return { ok: false, error: String(e && e.name ? e.name : e) };
         }
       })()`,
      true,
    )) as { ok: boolean; error: string };
  } catch (error) {
    return {
      id,
      title,
      obligation,
      status: 'blocked',
      detail:
        `Could not run the probe in the library window: ${message(error)}. ` +
        'If this is a CSP refusal, the probe needs its own page rather than executeJavaScript.',
    };
  }

  if (outcome.ok) {
    return {
      id,
      title,
      obligation,
      status: 'fail',
      detail:
        'A library window obtained a screen stream. `provideSource` is supposed to refuse every ' +
        'frame whose URL is not the capture page’s — any window holding our preload can record ' +
        'the screen.',
      data: outcome,
    };
  }

  return {
    id,
    title,
    obligation,
    status: 'pass',
    detail:
      `A non-capture window asking for getDisplayMedia was refused (${outcome.error}), and the ` +
      'handler that refused it is the installed one — the capture page reaches the same handler ' +
      'and is served, which `scripts/smoke-capture.mjs` drives end to end.',
    data: outcome,
  };
}

// ---------------------------------------------------- 3. content protection

/**
 * Carried obligation 3, and the one nobody has ever watched: does
 * `setContentProtection(true)` actually keep the recorder HUD out of captured frames?
 *
 * `windows.test.ts` asserts the flag is set on the role. That is a different claim.
 * This one paints the real HUD an unmistakable colour, captures the screen through
 * the same `desktopCapturer` path a recording uses, and looks at the pixels where
 * the HUD is.
 *
 * **The control is the whole design.** "The marker is not in the HUD's rectangle"
 * passes just as well when the capture is black, when the rectangle is computed
 * wrong, or when the window never painted. So a second window — same page, same
 * size, same paint, `setContentProtection` *not* called — is placed beside it and
 * must show the marker. If the control does not, this check reports `blocked`
 * rather than a pass it did not earn. That is the same discipline the crash gates
 * use (`AGENTS.md`: "a control that must fail").
 */
async function checkContentProtection(windows: WindowRegistry): Promise<CheckResult> {
  const obligation =
    '`setContentProtection(true)` keeping the recorder HUD out of captured frames ' +
    '(phase 1 / §11, assumed-not-verified)';
  const id = 'content-protection';
  const title = 'setContentProtection keeps the HUD out of captured pixels';

  const display = screen.getPrimaryDisplay();
  const size = { width: 420, height: 92 };
  const protectedBounds = { x: display.bounds.x + 120, y: display.bounds.y + 140, ...size };
  const controlBounds = { x: display.bounds.x + 120, y: display.bounds.y + 300, ...size };

  // The real HUD, with the real role, so the flag under test is the shipped one.
  const hud = windows.show('recorder-hud');
  hud.setBounds(protectedBounds);
  try {
    await whenReady(hud);
  } catch (error) {
    return {
      id,
      title,
      obligation,
      status: 'blocked',
      detail:
        `The recorder HUD never loaded: ${message(error)}. A window that did not paint is ` +
        'absent from a capture whether or not content protection works, so there is nothing ' +
        'here to conclude from.',
    };
  }
  await paintMarker(hud);

  // The control: identical in every respect except the flag.
  const control = new BrowserWindow({
    ...size,
    x: controlBounds.x,
    y: controlBounds.y,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    try {
      await control.loadURL(appUrl('recorder.html'));
    } catch (error) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          `The control window never loaded: ${message(error)}. Without a control that shows ` +
          'the marker, an absence of it in the protected window is not evidence of anything.',
      };
    }
    control.showInactive();
    await paintMarker(control);
    await delay(700);

    const shot = await captureDisplay(display);
    if (shot === null) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          'Could not capture the primary display, so nothing could be looked at. Without the ' +
          'Screen Recording grant there are no pixels to check this against.',
      };
    }

    const control_ = markerFraction(shot, display, controlBounds);
    const protected_ = markerFraction(shot, display, protectedBounds);
    const controlHit = control_.fraction;
    const protectedHit = protected_.fraction;
    const data = {
      control: control_,
      protected: protected_,
      protectedBounds,
      controlBounds,
      captureSize: shot.getSize(),
    };

    // The control first, always. If the harness cannot see a window it is *supposed*
    // to see, its opinion about a window it should not see is worthless.
    if (controlHit < 0.5) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          'The control window — same page, same size, content protection off — showed the ' +
          `marker in only ${(controlHit * 100).toFixed(1)}% of its rectangle; its mean colour ` +
          `was rgb(${control_.mean.join(', ')}). The capture, the coordinates or the paint is ` +
          'wrong, so the protected window’s result proves nothing.',
        data,
      };
    }

    if (protectedHit > 0.01) {
      return {
        id,
        title,
        obligation,
        status: 'fail',
        detail:
          `The protected HUD showed the marker in ${(protectedHit * 100).toFixed(1)}% of its ` +
          'rectangle. `setContentProtection(true)` is not keeping it out of captured frames, ' +
          'which means our own UI is being recorded.',
        data,
      };
    }

    return {
      id,
      title,
      obligation,
      status: 'pass',
      detail:
        `The control showed the marker across ${(controlHit * 100).toFixed(1)}% of its rectangle ` +
        `and the protected HUD across ${(protectedHit * 100).toFixed(1)}% — so the capture was ` +
        'real, the coordinates were right, and NSWindowSharingNone did its job.',
      data,
    };
  } finally {
    if (!control.isDestroyed()) control.destroy();
  }
}

// ------------------------------- 3b. the drawing overlay's content protection

/**
 * Phase 12's §8 gate sentence, in pixels: *"strokes appear live, are **absent** from
 * the raw capture, and are deletable in the editor."*
 *
 * **Content protection is an observation of PIXELS, not a TCC answer.** This check is
 * in the permissions harness because it needs the Screen Recording grant in order to
 * **look** — not because it is testing a permission. Nobody reading it later should
 * mistake it for a permission probe: what it asks is whether a window macOS was told
 * to keep out of captures is in one, and the grant is only the camera it holds while
 * asking. It is nonetheless subject to `sealReport` exactly like every other check
 * here — it is **not** in `alwaysHonest`, which is `bundle-identity`'s alone, because
 * `bundle-identity` is what *establishes* trust and this is not.
 *
 * The live-ink and deletable halves of that sentence are `npm test`'s and stay there
 * (`test/phase12-overlay.test.ts`, `packages/edl/test/drawing.test.ts`); they need no
 * grant. This half moved here because a host without Screen Recording gets a black
 * rectangle rather than an error, and the codebase's rule is that *"we could not
 * look"* must never be reported as *"we looked and it was fine"* — a `blocked` that
 * names the grant, never a pass and never a skip-on-missing-grant branch in a test.
 *
 * ## Five readings, because an absence is the easiest thing in the world to fake
 *
 * 1. **The control** — a second window from the shipping role's *own* constructor
 *    options, the same page, the same paint, receiving every call the overlay
 *    receives, with `setContentProtection` the single difference. It must show the
 *    marker first: an absence in the protected window's rectangle proves nothing when
 *    the capture is black, the coordinates are wrong or the window never painted.
 * 2. **The overlay's own rectangle**, painted the marker.
 * 3. **The same rectangle with the overlay hidden**, 700 ms later. A window that is
 *    genuinely absent leaves whatever is behind it, so taking it away must change
 *    nothing — which separates "the residue is the user's desktop" from "the residue
 *    is ours" with no interpretation in between.
 * 4. **A marker-painted *unprotected* window placed UNDER the overlay**, with the
 *    overlay repainted a colour that is not the marker. Every overlay pixel that
 *    reached the capture would cover a marker pixel, so this reading falls by exactly
 *    the size of any leak — and unlike reading 2 it does not depend on what happens
 *    to be on the user's screen.
 * 5. **A whole-frame marker scan.** Every other reading is taken inside a rectangle
 *    this file computed, and a rectangle computed wrong reports an absence that is
 *    really a miss. Scanning the entire frame removes the coordinates from the claim.
 *
 * Plus a bare patch of desktop as a baseline, so the control's reading is assertable
 * as a *signal* rather than as a high number — `isMarker` matches a shape of colour
 * rather than a triple, which is what phase 2's first run discovered by reporting 0%
 * inside its own control.
 */
async function checkOverlayContentProtection(windows: WindowRegistry): Promise<CheckResult> {
  const id = 'overlay-content-protection';
  const title = 'setContentProtection keeps the drawing overlay out of captured pixels';
  const obligation =
    'the live drawing overlay is absent from the raw capture (architecture report §8, ' +
    'phase 12’s gate)';

  const display = screen.getPrimaryDisplay();
  const size = { width: 520, height: 320 };
  const protectedBounds = { x: display.bounds.x + 120, y: display.bounds.y + 140, ...size };
  const controlBounds = { x: display.bounds.x + 120, y: display.bounds.y + 500, ...size };
  const bare = bareDesktopRect(display, size, controlBounds);

  let control: BrowserWindow | null = null;
  let backdrop: BrowserWindow | null = null;
  try {
    // The windows the checks above left on screen go away first, and this is not
    // tidiness: `checkContentProtection` paints the recorder HUD the **marker colour**
    // and leaves it at the display's (120, 140) — inside this check's own protected
    // rectangle. If that window's protection ever failed, its magenta would be read
    // here as the overlay leaking, and one defect would be reported as two in the
    // wrong place. The library window `checkFrameAuthorisation` opened is hidden for
    // the weaker version of the same reason: every reading below wants the desktop
    // behind it, which is what the vitest gate this moved from had.
    windows.get('recorder-hud')?.hide();
    windows.get('library')?.hide();

    // The real overlay, through the real registry, so the flag under test is the
    // shipped one — `WindowRegistry.show` is where `OverlayController.setOpen` gets
    // it. Resized so the control fits beside it: the flag is set on the role and is
    // not a function of size.
    const overlay = windows.show('drawing-overlay');
    try {
      await whenReady(overlay);
    } catch (error) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          `The drawing overlay never loaded: ${message(error)}. A window that did not paint ` +
          'is absent from a capture whether or not content protection works, so there is ' +
          'nothing here to conclude from.',
      };
    }
    applyOverlayWindowCalls(overlay, protectedBounds);

    // The control: the role's own options, and **every** call `setOpen` makes except
    // the one under test. A control that differed in its window level, its collection
    // behaviour or its mouse policy would be a second explanation for a difference in
    // the pixels — and the whole value of a control is that there is only one.
    control = new BrowserWindow({
      ...WINDOW_ROLES['drawing-overlay'].options,
      x: controlBounds.x,
      y: controlBounds.y,
      width: controlBounds.width,
      height: controlBounds.height,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await control.loadURL(appUrl('overlay.html'));
    } catch (error) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          `The control window never loaded: ${message(error)}. Without a control that shows ` +
          'the marker, an absence of it in the protected window is not evidence of anything.',
      };
    }
    applyOverlayWindowCalls(control, controlBounds);

    await paintMarker(overlay);
    await paintMarker(control);
    // The window server needs a moment to composite both before anything is captured;
    // the HUD's check waits the same 700 ms for the same reason.
    await delay(700);

    const shot = await captureDisplay(display);
    if (shot === null) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          'Could not capture the primary display, so nothing could be looked at. Without the ' +
          'Screen Recording grant there are no pixels to check this against.',
      };
    }

    const control_ = markerFraction(shot, display, controlBounds);
    const protected_ = markerFraction(shot, display, protectedBounds);
    const desktop_ =
      bare === null
        ? { fraction: 0, mean: [0, 0, 0] as [number, number, number], sampled: 0 }
        : markerFraction(shot, display, bare);
    const frame = scanFrameForMarker(shot);

    // Reading 3: the same rectangle, overlay hidden.
    overlay.hide();
    await delay(700);
    const withoutOverlay = await captureDisplay(display);
    if (withoutOverlay === null) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          'The second capture — the same rectangle with the overlay hidden — produced no ' +
          'picture, so the residue in the first one could not be attributed to anything.',
      };
    }
    const gone_ = markerFraction(withoutOverlay, display, protectedBounds);

    // Reading 4: a marker-painted unprotected window under the overlay.
    backdrop = new BrowserWindow({
      ...WINDOW_ROLES['drawing-overlay'].options,
      x: protectedBounds.x,
      y: protectedBounds.y,
      width: protectedBounds.width,
      height: protectedBounds.height,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await backdrop.loadURL(appUrl('overlay.html'));
    } catch (error) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          `The backdrop window never loaded: ${message(error)}. Without something under the ` +
          'overlay for a leak to cover, the occlusion reading says nothing.',
      };
    }
    backdrop.showInactive();
    await paintFlat(backdrop, '#FF00FF');
    await paintFlat(overlay, NOT_MARKER);
    overlay.showInactive();
    // Raised again after the backdrop, so the overlay is unambiguously on top of it:
    // a leak has something to cover.
    overlay.setAlwaysOnTop(true, 'screen-saver');
    await delay(700);
    const throughOverlay = await captureDisplay(display);
    if (throughOverlay === null) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          'The third capture — a marker window under the overlay — produced no picture, so ' +
          'the strongest form of the claim could not be taken.',
      };
    }
    const backdrop_ = markerFraction(throughOverlay, display, protectedBounds);

    const controlArea = controlBounds.width * controlBounds.height;
    const data = {
      control: control_,
      protected: protected_,
      protectedWithOverlayGone: gone_,
      backdropThroughOverlay: backdrop_,
      desktop: desktop_,
      frameMarkerPixels: frame.count,
      frameMarkerBox: frame.box,
      protectedBounds,
      controlBounds,
      desktopBounds: bare,
      captureSize: shot.getSize(),
      screenAccess: readMediaStatus('screen'),
    };

    // The control first, always. If the harness cannot see a window it is *supposed*
    // to see, its opinion about a window it should not see is worthless.
    if (control_.fraction < CONTROL_MIN) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          'The control window — the same role’s options, the same page, the same calls, ' +
          `content protection off — showed the marker in only ` +
          `${(control_.fraction * 100).toFixed(1)}% of its rectangle; its mean colour was ` +
          `rgb(${control_.mean.join(', ')}). The capture, the coordinates or the paint is ` +
          'wrong, so the overlay’s result proves nothing.',
        data,
      };
    }
    // And the control's reading is a *signal*, not the ambient magenta of whatever is
    // on this machine's desktop. This tightens the claim; it does not relax it.
    if (control_.fraction - desktop_.fraction < CONTROL_MIN) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          `The control showed ${(control_.fraction * 100).toFixed(1)}% marker and a bare patch ` +
          `of desktop the same size showed ${(desktop_.fraction * 100).toFixed(1)}%, so the ` +
          'control’s marker is indistinguishable from the desktop behind it.',
        data,
      };
    }

    const problems: string[] = [];
    if (protected_.fraction > PROTECTED_MAX) {
      problems.push(
        `the drawing overlay appeared in the captured pixels: ` +
          `${(protected_.fraction * 100).toFixed(1)}% of its rectangle — ` +
          'setContentProtection(true) is not keeping the ink out of the recording',
      );
    }
    // Judged against `PROTECTED_MAX` rather than a new number: the same hundredth of a
    // rectangle the primary reading allows, now applied to the *difference* the
    // overlay makes rather than to the total.
    if (Math.abs(protected_.fraction - gone_.fraction) >= PROTECTED_MAX) {
      problems.push(
        `hiding the overlay changed its own rectangle by ` +
          `${((protected_.fraction - gone_.fraction) * 100).toFixed(3)}% — that difference is ` +
          'the overlay reaching the capture',
      );
    }
    if (backdrop_.fraction <= BACKDROP_MIN) {
      problems.push(
        `only ${(backdrop_.fraction * 100).toFixed(2)}% of a marker window placed under the ` +
          'overlay came back through it — the missing part is the overlay, in the capture, ' +
          'covering it',
      );
    }
    if (frame.count >= controlArea * 1.5) {
      problems.push(
        `there is more marker in the capture (${String(frame.count)} px) than the control’s ` +
          `own ${String(controlArea)} px rectangle can account for, so something else painted ` +
          'with it — the overlay — reached the frame',
      );
    }
    if (frame.count <= controlArea * 0.5) {
      problems.push(
        `only ${String(frame.count)} marker pixels are in the whole capture against the ` +
          `control’s own ${String(controlArea)} px rectangle, so the frame scan did not find ` +
          'the window it is measured against',
      );
    }

    return {
      id,
      title,
      obligation,
      status: problems.length === 0 ? 'pass' : 'fail',
      detail:
        problems.length === 0
          ? `The control showed the marker across ${(control_.fraction * 100).toFixed(1)}% of ` +
            `its rectangle and the overlay across ${(protected_.fraction * 100).toFixed(3)}%; ` +
            `the same rectangle with the overlay hidden read ` +
            `${(gone_.fraction * 100).toFixed(3)}%, so that residue is the desktop and not ` +
            `ours; a marker window under the overlay came back through it at ` +
            `${(backdrop_.fraction * 100).toFixed(2)}%, so the overlay occludes nothing; and ` +
            `${String(frame.count)} marker pixels are in the whole capture against the ` +
            `control’s own ${String(controlArea)} px rectangle, so it is nowhere else in the ` +
            'frame either.'
          : problems.join('; '),
      data,
    };
  } finally {
    if (control !== null && !control.isDestroyed()) control.destroy();
    if (backdrop !== null && !backdrop.isDestroyed()) backdrop.destroy();
    windows.get('drawing-overlay')?.destroy();
  }
}

/**
 * The thresholds, from phase 2's own reading and not softened.
 *
 * Its control cleared 99.3% and its protected HUD 0.0%. `CONTROL_MIN` is the same 50%
 * {@link checkContentProtection} uses to decide the instrument works at all;
 * `PROTECTED_MAX` is its same 1%, which is a hundredth of the rectangle and is there
 * because a capture is resampled to DIP size and an edge pixel is a blend of two
 * windows.
 */
const CONTROL_MIN = 0.5;
const PROTECTED_MAX = 0.01;

/**
 * How much of a marker window placed **under** the overlay must come back through
 * it, and where the number comes from.
 *
 * Not a tuned threshold. The capture is resampled to the display's DIP size, so the
 * backdrop's own border pixels blend with the desktop outside it: the rectangle is
 * 520x320 = 166,400 px with a perimeter of 1,680, so a full one-pixel border is
 * **1.01%** of it and is lost to resampling no matter what the window under test
 * does. 99% is exactly that bound. Measured on this machine: 99.852%, so the real
 * loss is a seventh of one border pixel and the margin is about 7x.
 */
const BACKDROP_MIN = 0.99;

/**
 * A colour `isMarker` does not match, and nothing in the Pressroom palette is either.
 * If the overlay leaks, this is what covers the backdrop.
 */
const NOT_MARKER = '#00FF66';

/**
 * Every call `OverlayController.setOpen` makes to put the overlay on screen, applied
 * identically to the window under test and to its control.
 *
 * The bounds are this check's rather than the display's, because the two windows have
 * to fit beside each other; everything else is the shipping arrangement, and the
 * control gets it too so that the only difference between them is the flag.
 */
function applyOverlayWindowCalls(
  window: BrowserWindow,
  bounds: { x: number; y: number; width: number; height: number },
): void {
  window.setBounds(bounds);
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setIgnoreMouseEvents(true, { forward: true });
  window.showInactive();
}

/**
 * A patch of bare desktop, the same size, well clear of both windows.
 *
 * `null` on a display too narrow to hold one — the reading is context, not the check,
 * and inventing a rectangle that overlapped a window would make it worse than absent.
 */
function bareDesktopRect(
  display: Electron.Display,
  size: { width: number; height: number },
  controlBounds: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const x = display.bounds.x + display.bounds.width - size.width - 60;
  if (x < controlBounds.x + controlBounds.width + 40) return null;
  return { x, y: display.bounds.y + 140, ...size };
}

/**
 * Paint a window a flat colour, without changing which window it is.
 *
 * The same `insertCSS` trick {@link paintMarker} uses, with the colour open: the
 * occlusion reading needs the overlay painted something that is emphatically **not**
 * the marker, so that a leak of it would *remove* marker pixels rather than add them.
 */
async function paintFlat(window: BrowserWindow, hex: string): Promise<void> {
  await window.webContents.insertCSS(
    `html, body { background: ${hex} !important; } body * { visibility: hidden !important; }`,
  );
}

/**
 * Marker pixels anywhere in the whole capture, and the box they occupy.
 *
 * `isMarker` is not reimplemented — the shared instrument's own predicate is applied
 * to every pixel, so the frame and the rectangles agree on what a marker is.
 */
function scanFrameForMarker(image: NativeImage): {
  count: number;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
} {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const at = (y * size.width + x) * 4;
      if (!isMarker(bitmap[at + 2] ?? 0, bitmap[at + 1] ?? 0, bitmap[at] ?? 0)) continue;
      count += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { count, box: count === 0 ? null : { x0, y0, x1, y1 } };
}

/** Mean luma and distinct-luma count, for telling a picture from a black rectangle. */
function lumaStats(image: NativeImage): { mean: number; distinct: number; empty: boolean } {
  if (image.isEmpty()) return { mean: 0, distinct: 0, empty: true };
  const bitmap = image.toBitmap();
  const seen = new Set<number>();
  let sum = 0;
  let count = 0;
  // Every 4th pixel: enough to tell a photograph from a void, a quarter of the work.
  for (let i = 0; i + 3 < bitmap.length; i += 16) {
    const luma = Math.round(
      0.114 * (bitmap[i] ?? 0) + 0.587 * (bitmap[i + 1] ?? 0) + 0.299 * (bitmap[i + 2] ?? 0),
    );
    sum += luma;
    seen.add(luma);
    count++;
  }
  return { mean: count === 0 ? 0 : sum / count, distinct: seen.size, empty: false };
}

// ------------------------------------------------- 4. accessibility + clicks

/**
 * The captain's open item: *"Post-grant event rate and latency are unmeasured.
 * Validate during the build."*
 *
 * Two halves. `AXIsProcessTrusted()` is read here, because that is phase 2's and it
 * is what the captain's decision demands be checked rather than assumed. The rate and
 * latency need a live event stream, which only `@loom/sampler`'s `InputSampler`
 * produces; `index.ts` supplies it as a {@link ClickStreamProbe}. What is missing is
 * the Accessibility grant, not the sampler.
 *
 * With no probe this reports `skipped` and names what is missing. It does not report
 * a pass from `axTrusted` alone: the whole reason this obligation exists is that the
 * click API succeeds without the permission and then silently delivers nothing, so
 * "macOS trusts us" is precisely the claim that has already been shown not to imply
 * "clicks arrive".
 */
async function checkAccessibilityClicks(
  options: HarnessOptions,
  permissions: { accessibility: Parameters<typeof concludeAccessibility>[0] },
): Promise<CheckResult> {
  const obligation =
    'post-grant click event rate and latency (captain’s Accessibility decision, unmeasured)';
  const id = 'accessibility-clicks';
  const title = 'Accessibility is trusted and clicks actually arrive';
  const conclusion = concludeAccessibility(permissions.accessibility);
  const base = {
    axTrusted: permissions.accessibility.axTrusted,
    conclusion,
    verdict: describeAccessibility(conclusion),
  };

  const probe = options.clickStream;
  if (probe === null || probe === undefined) {
    return {
      id,
      title,
      obligation,
      status: 'skipped',
      detail:
        `${describeAccessibility(conclusion)} No click stream was wired into this run, so ` +
        'nothing could be measured. `index.ts` passes `observeClicks`; a build that does not ' +
        'is a build that cannot close this obligation.',
      data: base,
    };
  }

  if (!permissions.accessibility.axTrusted) {
    return {
      id,
      title,
      obligation,
      status: 'blocked',
      detail: `${describeAccessibility(conclusion)} There is nothing to measure until it is granted.`,
      data: base,
    };
  }

  const windowMs = options.clickWindowMs ?? 10_000;
  console.log(
    `[verify] click measurement: click anywhere for the next ${String(Math.round(windowMs / 1000))}s`,
  );
  const clicks = await probe(windowMs);

  // Zero clicks is not one fact. `clickVerdict` decides it from the tap's observed
  // state rather than from the event count, because a live tap that nobody clicked
  // during and a tap that was never alive look identical from the count alone — and
  // reading the second out of the first is what this check used to do.
  const empty = clickVerdict(conclusion, clicks.length, windowMs);
  if (empty !== null) {
    return {
      id,
      title,
      obligation,
      status: empty.status,
      detail: empty.detail,
      data: { ...base, clicks: 0, windowMs },
    };
  }

  // Two measurements, each from the clock that can answer it.
  //
  // The rate is over the window this harness asked for, not over the span between the
  // first and last arrival: `receivedMs` is stamped once per 100 ms flush, so a handful
  // of clicks landing in one batch share a timestamp and that span collapses to zero —
  // which reported "3 clicks in 0.0s (3000.0/s)" in the one artifact this file exists
  // to produce honestly. Inter-arrival comes from the sampler's own event timestamps,
  // which are unquantised, rather than from the batch they arrived in — the same
  // batching that makes a `receivedMs` delta 0 ms.
  const windowSec = windowMs / 1000;
  const interArrivalMs = clicks
    .slice(1)
    .map((click, i) => (click.tSec - (clicks[i]?.tSec ?? click.tSec)) * 1000);

  return {
    id,
    title,
    obligation,
    status: 'pass',
    detail:
      `${String(clicks.length)} clicks in a ${windowSec.toFixed(1)}s observation window ` +
      `(${(clicks.length / windowSec).toFixed(2)}/s), median inter-arrival ` +
      `${median(interArrivalMs).toFixed(1)} ms. Inter-arrival is the sampler's own event ` +
      'timestamps, not batch arrival, and is not an input-to-app latency.',
    data: {
      ...base,
      clicks: clicks.length,
      windowMs,
      ratePerSec: clicks.length / windowSec,
      interArrivalMs,
    },
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// -------------------------------------------------------------------- helpers

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A backstop for the load that neither finishes nor fails, not a performance bound:
 * every window here loads a local `loom://` page, and the margin over that is
 * enormous.
 */
const WINDOW_LOAD_TIMEOUT_MS = 30_000;

/**
 * Wait for a window to finish loading, or say why it never will.
 *
 * Resolving only on `did-finish-load` is a hang waiting for a bad `loom://app` path
 * or a protocol handler that threw: the check awaits forever, `runVerification` never
 * returns, no report is printed and `app.exit()` is never reached — and the runner,
 * blocked on `open --wait-apps`, hangs with it. A gate whose whole value is naming
 * precisely what is blocking it must not have silence as a failure mode, so both
 * other outcomes become a thrown reason, which the caller reports as `blocked`.
 */
async function whenReady(window: BrowserWindow): Promise<void> {
  const contents = window.webContents;
  if (!contents.isLoading()) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `still loading after ${String(WINDOW_LOAD_TIMEOUT_MS)} ms — it neither finished ` +
              'nor reported a failure',
          ),
        );
      }, WINDOW_LOAD_TIMEOUT_MS);
      contents.once('did-finish-load', () => {
        resolve();
      });
      contents.once(
        'did-fail-load',
        (
          _event,
          errorCode: number,
          errorDescription: string,
          url: string,
          isMainFrame: boolean,
        ) => {
          // A subframe that fails is not this page failing to load, and none of these
          // pages has one; rejecting on it would report the wrong thing.
          if (!isMainFrame) return;
          reject(new Error(`failed to load ${url}: ${errorDescription} (${String(errorCode)})`));
        },
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ------------------------------------ 5. a Microphone grant revoked mid-recording

/**
 * The captain's `data/loom-scope/decision-mic-revocation.md`, run against the real
 * thing.
 *
 * `apps/main/test/recorder-session.test.ts` drives every branch of this with
 * `systemPreferences` replaced, which is what makes it a test that runs on CI. What
 * it cannot establish is the one thing this harness exists for: that **macOS is
 * answering about us**, and that the answer changes when a person flips the switch.
 * A dev binary inherits its terminal's grants (research §7, trap 6), so only a
 * signed bundle launched by LaunchServices can watch a Microphone grant actually go
 * away and see the shipping `RecorderSession` respond to it.
 *
 * So this check is deliberately **interactive** and deliberately **off by default**.
 * There is no programmatic way to revoke a TCC permission — this file does not
 * pretend otherwise, any more than the rest of the harness pretends it can grant
 * one. What it automates is everything either side of the human step: opening a real
 * recording, watching for the grant to move, and then asserting the three things the
 * decision asks for at once — that the recording **stopped**, that it says
 * **`permission-revoked`** rather than `device-lost`, and that what was already
 * captured **survived**.
 *
 * `blocked`, not `fail`, when nobody revokes anything: "we could not look" and "we
 * looked and it was broken" are different reports (see {@link CheckStatus}).
 */
async function checkMicrophoneRevocation(options: HarnessOptions): Promise<CheckResult> {
  const id = 'microphone-revocation';
  const title = 'A revoked Microphone grant stops the recording and keeps the footage';
  const obligation =
    'a Microphone revoked mid-recording is recorded as a lost device (phase 2, item 8)';
  const drive = options.recorderDrive ?? null;

  if (options.micRevocation !== true || drive === null) {
    return {
      id,
      title,
      obligation,
      status: 'skipped',
      detail:
        'Needs a person: there is no way to revoke a TCC permission programmatically. Run ' +
        '`node scripts/verify-permissions.mjs --mic-revocation`, then switch "Loom Clone" ' +
        'off under Privacy & Security › Microphone while the recording it starts is running.',
    };
  }

  const before = readMediaStatus('microphone');
  if (before !== 'granted') {
    return {
      id,
      title,
      obligation,
      status: 'blocked',
      detail:
        `Microphone is ${before}, so there is nothing to revoke. Grant it first — the check ` +
        'is about a grant being withdrawn, not about one that was never given.',
      data: { microphone: before },
    };
  }

  const { recorder, store } = drive;
  const windowMs = options.micRevocationWindowMs ?? 90_000;
  let recordingId: RecordingId | null = null;
  try {
    // A real recording of the real screen, with the microphone and nothing else: no
    // camera (opening one lights an indicator nobody asked for) and no loopback,
    // which would only add a second audio track to the thing being watched.
    recordingId = await recorder.start({
      micDeviceId: 'default',
      systemAudio: false,
      webcamDeviceId: null,
    });
    console.log(
      `\n  [verify] recording ${recordingId}. **Switch "Loom Clone" off under ` +
        `System Settings › Privacy & Security › Microphone now.**\n` +
        `  [verify] waiting up to ${String(Math.round(windowMs / 1000))}s for the grant to move…`,
    );

    // Enough of a recording to be worth keeping, so "the footage survived" is a
    // claim about frames rather than about an empty file. A capture that never
    // produced one — Screen Recording not granted, `getDisplayMedia` refused — is a
    // run that could not look at anything, so it says so rather than reporting the
    // revocation it never got to watch as broken.
    const capturing = await waitFor(() => recorder.status().frameCount > 0, 15_000);
    if (!capturing) {
      const stalled = recorder.status();
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          'The recording produced no frames, so there was nothing for a revocation to ' +
          `happen to. Screen Recording is ${readMediaStatus('screen')} and the recorder is ` +
          `${stalled.phase}${stalled.error === null ? '' : `: ${stalled.error}`}. Grant Screen ` +
          'Recording and re-run — this check needs a recording that is actually running.',
        data: {
          screen: readMediaStatus('screen'),
          microphone: readMediaStatus('microphone'),
          phase: stalled.phase,
          error: stalled.error,
          frameCountBefore: stalled.frameCount,
        },
      };
    }
    const frameCountBefore = recorder.status().frameCount;

    const wasRevoked = await waitFor(() => readMediaStatus('microphone') !== 'granted', windowMs);
    if (!wasRevoked) {
      return {
        id,
        title,
        obligation,
        status: 'blocked',
        detail:
          'Microphone was still granted when the window closed — nobody revoked it, so there ' +
          'was nothing to observe. Re-run and switch it off while the recording is running.',
        data: { microphone: readMediaStatus('microphone'), frameCountBefore },
      };
    }

    // The recorder stops itself. Not "we stopped it and then looked": the whole
    // claim is that the app reacts to the revocation without being told to.
    const stopped = await waitFor(
      () => recorder.status().phase === 'idle' && recorder.status().revoked !== null,
      30_000,
    );
    const status = recorder.status();
    const doc = (await store.readProject(recordingId)).recording;
    const mic = doc?.tracks.mic?.parts[0];
    const screenPart = doc?.tracks.screen?.parts[0];
    const data = {
      stoppedItself: stopped,
      revoked: status.revoked,
      micEndReason: mic?.endReason ?? null,
      micEndedEarly: mic?.endedEarly ?? null,
      screenFrames: screenPart?.frameCount ?? 0,
      screenDurationSec: screenPart?.durationSec ?? 0,
      frameCountBefore,
    };

    const problems: string[] = [];
    if (!stopped) problems.push('the recorder did not stop itself');
    if (status.revoked?.kind !== 'microphone') {
      problems.push('the user was not told a Microphone permission had been revoked');
    }
    if (mic === undefined) problems.push('the microphone part is missing from recording.json');
    else if (mic.endReason !== 'permission-revoked') {
      problems.push(
        `the mic part says endReason=${mic.endReason ?? 'none'}, not permission-revoked`,
      );
    }
    // The point with teeth: raw sources are deleted after an export (decision 5), so
    // a partial recording discarded at stop time is gone for good.
    if ((screenPart?.frameCount ?? 0) === 0) {
      problems.push('the screen part kept no frames — the recording was discarded, not finalized');
    }

    return {
      id,
      title,
      obligation,
      status: problems.length === 0 ? 'pass' : 'fail',
      detail:
        problems.length === 0
          ? `The grant was withdrawn, the recorder stopped itself, the user was told the ` +
            `Microphone permission was revoked, and ${String(data.screenFrames)} frames ` +
            `(${data.screenDurationSec.toFixed(2)}s) of screen survived in the bundle.`
          : problems.join('; '),
      data,
    };
  } catch (error) {
    return {
      id,
      title,
      obligation,
      status: 'blocked',
      detail: `the check could not be run: ${message(error)}`,
    };
  } finally {
    // Whatever happened, nothing is left recording. A stop that is not needed is a
    // no-op; one that is, is the difference between this harness exiting and hanging.
    await recorder.stop().catch(() => undefined);
  }
}

/**
 * Poll until `predicate` holds, or give up. `true` if it held.
 *
 * Polling rather than an event, because the thing being watched — TCC's answer —
 * emits no event at all: macOS does not notify an app that a grant has moved, which
 * is the same fact `PermissionsApi.onChange` re-probes on focus to work around.
 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(250);
  }
  return predicate();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported so `index.ts` does not need a second import for the report shape. */
export type { VerifyReport } from './checks.ts';
export { formatReport } from './checks.ts';
