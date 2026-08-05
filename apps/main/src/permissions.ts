/**
 * The macOS permission prober and request driver. Phase 2.
 *
 * **This is the only file in the repo that calls `systemPreferences`.** Everything
 * that is *policy* about the four grants — what each is for, what breaks without it,
 * which System Settings pane turns it on — lives in `@loom/permissions`, which is
 * pure and unit-testable. What lives here is the part that needs a running Electron:
 * asking macOS, asking the user, opening a pane, and coming back.
 *
 * Authority: the captain's decision in
 * `data/loom-scope/decision-accessibility-clicks.md` (ask up front, all four, explain
 * each, verify Accessibility with `AXIsProcessTrusted()` and never by assuming);
 * architecture report §7.3 (revocation and the deep links); research report §5.3 and
 * §7 trap 6 (what a dev binary reports, and why it is worthless).
 *
 * ## Three things this file refuses to do
 *
 * 1. **It never grants anything.** There is no API that grants a TCC permission and
 *    no supported way to fake one. `request()` asks; macOS and the user answer.
 * 2. **It never infers a grant from a success.** The click API is the standing
 *    example: `CGEvent.tapCreate` succeeds without Accessibility and then silently
 *    delivers zero events. So Accessibility is read from `AXIsProcessTrusted()` and,
 *    where phase 5's sampler is present, cross-checked against a live tap.
 * 3. **It never claims a status is about us when it might not be.** Every report
 *    carries {@link ReportProvenance}, and a dev binary's `granted` is marked
 *    untrustworthy at the source rather than at the point it misleads someone.
 */

import { app, ipcMain, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import {
  CHANNEL,
  DEFAULT_CAPTURE_OPTIONS,
  requestedCaptureOptions,
  type CaptureOptions,
  type PreflightReport,
} from '@loom/ipc';
import {
  PERMISSIONS,
  blockingKinds,
  canRecord,
  degradedKinds,
  isPermissionKind,
  isSettingsUrl,
  summarize,
  type AccessibilityDetail,
  type PermissionKind,
  type PermissionReport,
  type PermissionStatus,
} from '@loom/permissions';
import type { SetupState } from '@loom/format';
import type { ProjectStore } from './project-store.ts';

/**
 * The one thing phase 2 needs from phase 5's cursor sampler, expressed as the
 * narrowest port that `@loom/sampler`'s `probeInput()` already satisfies.
 *
 * The sampler owns the hard half — running a native helper, building a real
 * `CGEventTap`, reading `tapIsEnabled` — and phase 5 was deliberately scoped to stop
 * there and leave the asking to phase 2. So this is a *port*, not a reimplementation:
 * `index.ts` passes `@loom/sampler`'s `probeInput` straight through, and that is the
 * whole of the wiring. `probeInput` returns an `InputProbe` whose `clicks` is a
 * `ClickTapState`, which has both fields below and more — so it satisfies this type
 * structurally, with no adapter to keep in sync.
 *
 * It stays a port rather than an import so a test can run this class without
 * spawning a native helper. With no port the probe is `null` and `tapLive` stays
 * `null`, which reads as **unverified** everywhere rather than as a pass: a build
 * that cannot ask whether clicks would arrive must not answer.
 */
export type ClickTapProbe = () => Promise<{
  clicks: { axTrusted: boolean; tapEnabled: boolean };
}>;

export interface PermissionManagerOptions {
  store: ProjectStore;
  /** Phase 5's `probeInput`. `null` only where no native helper can run — tests. */
  clickTapProbe?: ClickTapProbe | null;
  /**
   * How the app quits and comes back. Injected because the real one ends the
   * process, which a test cannot survive, and because the graceful-shutdown ordering
   * it has to respect lives in `index.ts` rather than here.
   */
  relaunchApp: () => void;
  /** Push a changed report to every window. Injected so this class owns no windows. */
  broadcast: (report: PermissionReport) => void;
  /**
   * Hand over from the setup window to the library. Injected for the same reason
   * as {@link broadcast}: which window opens next is main's policy, not this
   * class's.
   */
  onSetupComplete: () => void;
  /**
   * Bring the first-run explanation back, after setup has been completed once.
   *
   * A user who pressed Continue with Screen Recording refused has a recorder that
   * cannot record; without this there is no route back to the explanation or the
   * System Settings deep links. Injected for the same reason as
   * {@link onSetupComplete}.
   */
  onOpenSetup: () => void;
}

/**
 * How long a click-tap answer is reused before the helper is run again.
 *
 * The other three legs of a probe are `systemPreferences` reads; this one spawns the
 * native sampler. `refresh()` runs on every window focus, so without a window here
 * alt-tabbing forks a process per switch — beside the helper a live recording is
 * already running. Nothing can change the answer without `axTrusted` changing or time
 * passing, and both invalidate it.
 */
const TAP_PROBE_TTL_MS = 3000;

/**
 * Read one of the three media grants. macOS is the only source; nothing here
 * guesses.
 *
 * Exported so that `recorder/session.ts` — which records the permissions in force at
 * capture time into `recording.json` — reads them through the same narrowing rather
 * than casting Electron's string. That cast was how `unknown` could have been
 * written into a user's recording as `PermissionState`, which is a value that type
 * does not have and a claim macOS never made.
 */
export function readMediaStatus(kind: 'screen' | 'camera' | 'microphone'): PermissionStatus {
  // Electron returns the five values `PermissionStatus` names. It is typed as
  // `string` in some versions, so this is narrowed rather than cast blindly: an
  // unrecognised value becomes `unknown`, which is the truth, instead of being
  // laundered into `not-determined`, which would be a guess.
  const raw: string = systemPreferences.getMediaAccessStatus(kind);
  switch (raw) {
    case 'granted':
    case 'denied':
    case 'not-determined':
    case 'restricted':
      return raw;
    default:
      return 'unknown';
  }
}

/**
 * `AXIsProcessTrusted()`.
 *
 * `false` is passed on purpose and it is the whole difference between a status check
 * and a user-visible event: `isTrustedAccessibilityClient(true)` fires the system
 * prompt (research §5.3, note 6). This is called on every launch, on every window
 * focus and every time the setup window refreshes; prompting from any of those would
 * be a dialog the user did not ask for.
 */
export function readAxTrusted(): boolean {
  return systemPreferences.isTrustedAccessibilityClient(false);
}

export class PermissionManager {
  private readonly options: PermissionManagerOptions;
  /**
   * Set once this process has pointed the user at the Accessibility pane.
   *
   * Held in memory *and* persisted (`settings.setup.accessibilityOpenedAt`), because
   * the two answer different questions. In memory: "this session sent them, so offer
   * a relaunch." On disk: it survives the relaunch it is about, which is how the
   * window that comes back knows why it came back.
   */
  private accessibilityAsked = false;
  /**
   * Set once this process has spent the persisted ask on its own launch, so the
   * clear is attempted once rather than on every probe while the write is in flight.
   */
  private accessibilityAskAnswered = false;
  private last: PermissionReport | null = null;
  /**
   * Settings writes started by this class, serialized.
   *
   * One chain, so a relaunch can wait for all of them without knowing which are in
   * flight. Ordering against every *other* settings write is `ProjectStore`'s, which
   * serializes the read-modify-write itself — this chain is about knowing when ours
   * have landed, not about who wins.
   */
  private pending: Promise<unknown> = Promise.resolve();
  /** The last click-tap answer and when it was taken. See {@link TAP_PROBE_TTL_MS}. */
  private tapProbe: { axTrusted: boolean; tapLive: boolean | null; atMs: number } | null = null;
  /** A tap probe already running, so concurrent probes share one helper process. */
  private tapProbeInFlight: Promise<boolean | null> | null = null;

  constructor(options: PermissionManagerOptions) {
    this.options = options;
  }

  // -------------------------------------------------------------------- probe

  /**
   * What macOS says right now, plus whether it is talking about us.
   *
   * Cheap enough to call freely: three `getMediaAccessStatus` reads and one
   * `AXIsProcessTrusted`. The click-tap leg is the only expensive part, and it is
   * skipped entirely when no probe is wired.
   */
  async probe(): Promise<PermissionReport> {
    const axTrusted = readAxTrusted();
    const accessibility: AccessibilityDetail = {
      axTrusted,
      tapLive: await this.probeTap(axTrusted),
      settingsOpened: this.accessibilityEverAsked(axTrusted),
    };

    const report: PermissionReport = {
      statuses: {
        screen: readMediaStatus('screen'),
        camera: readMediaStatus('camera'),
        microphone: readMediaStatus('microphone'),
        // TCC has no `getMediaAccessStatus('accessibility')`. `AXIsProcessTrusted()`
        // is a boolean and it is the whole of what macOS will tell us, so the two
        // states it can express are the two states reported. `not-determined` is
        // never claimed for Accessibility: macOS does not distinguish "not yet
        // asked" from "asked and declined" here, and pretending otherwise would put
        // a fact in the UI that nothing established.
        accessibility: accessibility.axTrusted ? 'granted' : 'denied',
      },
      accessibility,
      provenance: {
        packaged: app.isPackaged,
        // No public API exposes the responsible process. An app launched by
        // LaunchServices — `open -a`, or a double click — is its own; one launched
        // from a shell inherits that shell's grants, and `ppid` is the cheapest
        // honest signal for which happened (research §7, trap 6).
        responsibleForSelf: process.ppid === 1,
      },
    };

    this.last = report;
    return report;
  }

  /**
   * Whether this app has pointed the user at the Accessibility pane and is still
   * waiting to find out what came of it.
   *
   * Read on every probe rather than latched once. `settings.json` is loaded
   * asynchronously at launch, so anything that reads it at construction time is
   * reading the fresh-install default, and the relaunch offer this field exists to
   * survive is exactly what would be lost.
   *
   * **The persisted ask survives exactly one relaunch, because one relaunch is what
   * it exists to answer.** If it came from a process that is not this one, then a
   * relaunch has already happened — and an `axTrusted` of `false` here *is* the
   * answer: the grant was not given. Spending the timestamp at that point is what
   * stops {@link concludeAccessibility} returning `relaunch-to-find-out` on every
   * launch for the rest of the install, which offers a Relaunch button that cannot
   * change anything and holds the setup window's refusal card permanently open. What
   * the user gets back is the ordinary `not-granted` row, with its Allow button.
   *
   * Within the session that asked, nothing changes: `accessibilityAsked` short-
   * circuits this, the conclusion stays `relaunch-to-find-out`, and the relaunch it
   * offers is still the right next step.
   */
  private accessibilityEverAsked(axTrusted: boolean): boolean {
    if (this.accessibilityAsked) return true;
    if (this.accessibilityAskAnswered) return false;
    if (this.options.store.setup.accessibilityOpenedAt === null) return false;
    // Granted is not an answer that needs spending: the conclusion no longer reads
    // this field, and a grant revoked later comes back through the branch below.
    if (axTrusted) return true;
    this.forgetAccessibilityAsked();
    return false;
  }

  /**
   * Drop the persisted ask, because the relaunch it was waiting for has happened.
   *
   * Chained onto {@link pending} like the write that made it, so the two cannot
   * cross: an "Allow" pressed moments later must land *after* this clear, not be
   * erased by it.
   */
  private forgetAccessibilityAsked(): void {
    this.accessibilityAskAnswered = true;
    this.pending = this.pending
      .then(() => this.options.store.updateSetup({ accessibilityOpenedAt: null }))
      .catch((error: unknown) => {
        // Costs one more launch showing the stale relaunch offer, nothing else. The
        // next launch tries again.
        console.error('[permissions] could not clear the accessibility ask:', error);
      });
  }

  /**
   * Whether a live event tap is delivering. `null` when nothing looked.
   *
   * A probe that throws returns `null`, not `false`: "the helper fell over" and "the
   * tap is dead" are different diagnoses, and the second one drives a relaunch
   * prompt that would be wrong for the first.
   *
   * Coalesced and briefly cached, because this is the one leg of a probe that costs a
   * process (see {@link TAP_PROBE_TTL_MS}). Never cached across a change in
   * `axTrusted`: that is the input the answer depends on.
   */
  private async probeTap(axTrusted: boolean): Promise<boolean | null> {
    const probe = this.options.clickTapProbe;
    if (probe === null || probe === undefined) return null;

    const cached = this.tapProbe;
    if (
      cached !== null &&
      cached.axTrusted === axTrusted &&
      Date.now() - cached.atMs < TAP_PROBE_TTL_MS
    ) {
      return cached.tapLive;
    }

    this.tapProbeInFlight ??= probe()
      .then((result) => result.clicks.tapEnabled)
      .catch((error: unknown) => {
        console.error('[permissions] click-tap probe failed:', error);
        return null;
      })
      .then((tapLive: boolean | null) => {
        this.tapProbe = { axTrusted, tapLive, atMs: Date.now() };
        this.tapProbeInFlight = null;
        return tapLive;
      });
    return this.tapProbeInFlight;
  }

  // ------------------------------------------------------------------ request

  /**
   * Ask for one permission, then re-probe.
   *
   * Three genuinely different flows, picked from the permission's `requestMode` so
   * that no caller has to know which is which:
   *
   * - **`prompt`** (camera, microphone) — `askForMediaAccess` shows the system
   *   prompt and resolves with the answer. The only one of the three that is a real
   *   request.
   * - **`implicit`** (screen) — there is no request API. macOS prompts the first
   *   time an app actually tries to capture, so the ask *is* an enumeration attempt.
   *   The grant does not reach this process until it restarts, which is why the
   *   window that called this shows a relaunch path rather than a tick.
   * - **`settings-only`** (accessibility) — nothing can be granted programmatically.
   *   `isTrustedAccessibilityClient(true)` is the one nudge macOS offers: a dialog
   *   whose only useful button opens System Settings. Spending it is recorded,
   *   because macOS shows it at most once per launch.
   */
  async request(kind: PermissionKind): Promise<PermissionReport> {
    switch (PERMISSIONS[kind].requestMode) {
      case 'prompt':
        // `kind` is narrowed by the mode: only camera and microphone are `prompt`.
        await systemPreferences
          .askForMediaAccess(kind as 'camera' | 'microphone')
          .catch((error: unknown) => {
            console.error(`[permissions] askForMediaAccess(${kind}) failed:`, error);
            return false;
          });
        break;

      case 'implicit':
        await this.triggerScreenPrompt();
        break;

      case 'settings-only':
        // The nudge. This is the *only* call in this file that can put a dialog on
        // screen without the user having pressed something, and it is behind an
        // explicit request for exactly that reason.
        systemPreferences.isTrustedAccessibilityClient(true);
        this.rememberAccessibilityAsked();
        // A `request` is awaited by the window that made it, so it resolves only
        // once the ask has actually been recorded — the report it returns is then
        // consistent with what a relaunch would find on disk.
        await this.whenSettled();
        break;
    }
    return this.probe();
  }

  /**
   * Make macOS show the Screen Recording prompt, by trying to do the thing it
   * governs.
   *
   * There is no `askForMediaAccess('screen')`. Enumerating sources is the documented
   * trigger and it is what the recorder does anyway; doing it here means the prompt
   * appears during onboarding, where it is explained, rather than in the middle of
   * the user's first recording.
   *
   * The result is deliberately discarded. A first call can return placeholder
   * sources while the prompt is still up, so believing it would be reading an answer
   * out of a question — {@link probe} is what says whether it worked, on the next
   * launch, which is when the grant takes effect.
   */
  private async triggerScreenPrompt(): Promise<void> {
    // Imported lazily so that requiring this module in a test does not pull in the
    // desktop capturer, which needs a running app.
    const { desktopCapturer } = await import('electron');
    await desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .catch((error: unknown) => {
        // Expected when the grant is absent, and not an error worth surfacing: the
        // prompt is the point, and `probe()` reports the outcome.
        console.warn('[permissions] screen enumeration during request:', error);
        return [];
      });
  }

  /** Open the System Settings pane for one permission. */
  openSettings(kind: PermissionKind): void {
    const url = PERMISSIONS[kind].settingsUrl;
    // Belt and braces. The renderer names a `PermissionKind`, so `url` already comes
    // from the closed table — but `openExternal` hands whatever it is given to the
    // OS handler for its scheme, and this is the last line before that happens.
    if (!isSettingsUrl(url)) {
      console.error('[permissions] refusing to open a url outside the settings table:', url);
      return;
    }
    void shell.openExternal(url).catch((error: unknown) => {
      console.error(`[permissions] could not open ${PERMISSIONS[kind].settingsPaneName}:`, error);
    });
    if (kind === 'accessibility') this.rememberAccessibilityAsked();
  }

  /**
   * Record that the user has been pointed at the Accessibility pane.
   *
   * Chained onto {@link pending} rather than fired and forgotten, because the very
   * next thing the user does is often press Relaunch — and a quit that outran this
   * write would come back with no memory of having asked, which is precisely the
   * state `accessibilityOpenedAt` exists to prevent. {@link relaunch} waits for it.
   */
  private rememberAccessibilityAsked(): void {
    this.accessibilityAsked = true;
    this.accessibilityAskAnswered = false;
    const at = new Date().toISOString();
    this.pending = this.pending
      .then(() => this.options.store.updateSetup({ accessibilityOpenedAt: at }))
      .catch((error: unknown) => {
        // Losing this costs a relaunch offer, not data. It must not take down the
        // permission flow with it.
        console.error('[permissions] could not record the accessibility ask:', error);
      });
  }

  /** Resolves once every settings write this class started has landed. */
  whenSettled(): Promise<void> {
    return this.pending.then(() => undefined);
  }

  /**
   * Quit and come back, which is the only way an Accessibility grant reaches this
   * app.
   *
   * The actual relaunch is injected, because it has to go through main's
   * `before-quit` handler — producers stopped, journals flushed, bundle locks
   * released — and that ordering is main's to own, not this class's.
   *
   * The wait is not a nicety. "Open System Settings" and "Relaunch" are adjacent
   * buttons on the same card, and a quit that beat the `accessibilityOpenedAt` write
   * would return to a window that has forgotten it ever asked — which shows the user
   * "Allow" again instead of the relaunch they just performed.
   */
  relaunch(): void {
    void this.whenSettled().then(() => {
      this.options.relaunchApp();
    });
  }

  // ---------------------------------------------------------------- preflight

  /**
   * Whether a capture could start, as two actionable lists.
   *
   * Named under `recorder` in §1.4 and implemented here because this is the module
   * that knows the answer. The answer is currently the same for every capture — a
   * refused Camera or Microphone is `degraded` whether or not this recording asked
   * for one — so `options` does not change the result yet. It is taken so that
   * narrowing the answer to what a recording actually opens lands on this call
   * rather than inventing a second one.
   */
  async preflight(_options: CaptureOptions): Promise<PreflightReport> {
    const report = await this.probe();
    return {
      report,
      ready: canRecord(report),
      blocking: blockingKinds(report),
      degraded: degradedKinds(report),
    };
  }

  // ------------------------------------------------------------------- wiring

  /**
   * Re-probe and push if anything changed.
   *
   * macOS does not tell an app that a grant was given. The user switches to System
   * Settings, flips a switch, and comes back — so a window regaining focus is the
   * closest thing to an event there is, and turning it into one is what lets the
   * setup window update itself instead of growing a "check again" button.
   */
  async refresh(): Promise<void> {
    const previous = this.last;
    const next = await this.probe();
    if (previous !== null && JSON.stringify(previous) === JSON.stringify(next)) return;
    console.log('[permissions]', summarize(next));
    this.options.broadcast(next);
  }

  install(): void {
    ipcMain.handle(CHANNEL.permissionsProbe, (): Promise<PermissionReport> => this.probe());

    ipcMain.handle(
      CHANNEL.permissionsRequest,
      async (_event: IpcMainInvokeEvent, raw: unknown): Promise<PermissionReport> => {
        return this.request(requireKind(raw));
      },
    );

    ipcMain.on(CHANNEL.permissionsOpenSettings, (_event, raw: unknown) => {
      // A bad kind from a renderer is dropped rather than thrown: this is a
      // send-only channel, so there is nobody to throw to.
      if (!isPermissionKind(raw)) {
        console.error('[permissions] openSettings called with a bad kind:', raw);
        return;
      }
      this.openSettings(raw);
    });

    ipcMain.on(CHANNEL.permissionsRelaunch, () => {
      this.relaunch();
    });

    ipcMain.handle(
      CHANNEL.recorderPreflight,
      (_event: IpcMainInvokeEvent, raw: unknown): Promise<PreflightReport> => {
        // The same sanitizer `recorder.start` runs, and for the same reason: this is
        // a message from a renderer, and phases 3 and 4 make these fields load-bearing
        // here. Two readings of one message is how the checked one gets bypassed.
        return this.preflight({ ...DEFAULT_CAPTURE_OPTIONS, ...requestedCaptureOptions(raw) });
      },
    );

    ipcMain.on(CHANNEL.setupOpen, () => {
      this.options.onOpenSetup();
    });

    ipcMain.handle(CHANNEL.setupState, (): SetupState => this.options.store.setup);

    ipcMain.handle(CHANNEL.setupComplete, async (): Promise<void> => {
      // Persisted before the handover, so a crash between the two costs a second
      // look at the setup window rather than a user who can never leave it.
      await this.options.store.updateSetup({ completedAt: new Date().toISOString() });
      this.options.onSetupComplete();
    });
  }

  uninstall(): void {
    for (const channel of [
      CHANNEL.permissionsProbe,
      CHANNEL.permissionsRequest,
      CHANNEL.permissionsOpenSettings,
      CHANNEL.permissionsRelaunch,
      CHANNEL.recorderPreflight,
      CHANNEL.setupOpen,
      CHANNEL.setupState,
      CHANNEL.setupComplete,
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
  }
}

function requireKind(value: unknown): PermissionKind {
  if (!isPermissionKind(value)) {
    throw new Error(`unknown permission: ${JSON.stringify(value)}`);
  }
  return value;
}
