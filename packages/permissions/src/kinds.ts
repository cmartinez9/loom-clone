/**
 * The four grants this app asks for, and everything that is *policy* about them.
 *
 * Authority: the captain's settled decision in
 * `data/loom-scope/decision-accessibility-clicks.md` — **ask up front**, all four
 * together, as one deliberate onboarding step; research report §5.3 for the TCC
 * service names, the `Info.plist` keys and the deep links; architecture report §7.3
 * for what happens when one is revoked mid-recording.
 *
 * ## Why the copy lives here and not in the window
 *
 * The captain's decision requires the app to "explain each permission in plain
 * language and say what breaks without it", and Accessibility in particular to state
 * that it detects clicks *and nothing else*. That sentence has to survive: it is the
 * sentence that earns the most invasive of the four. If it lives in a `<p>` in the
 * setup page, the second surface that has to say the same thing — the recorder's
 * degraded-mode banner, a main-process log line, a preflight report — writes its own
 * version, and the two drift. So the copy is data, next to the policy it describes,
 * and every surface renders the same strings. This is the same reasoning that put
 * `describeClickCapability()` in `@loom/sampler` rather than in a window.
 *
 * ## Why this is a package and not a file in `apps/main`
 *
 * Both halves need it. Main probes and decides; the renderer explains. A renderer
 * cannot import from `apps/main`, and duplicating the table is exactly the drift
 * this file exists to prevent. Same justification that `@loom/ipc` carries.
 *
 * This entry point is **pure**: no `electron`, no `node:`, no DOM. The Electron
 * calls that produce a {@link PermissionStatus} live in
 * `apps/main/src/permissions.ts`; its header states which files may make them.
 */

/**
 * The four. Ordered as the setup window lists them: the one that is required, then
 * the two the OS will prompt for, then the one only a trip to System Settings can
 * turn on.
 */
export const PERMISSION_KINDS = ['screen', 'camera', 'microphone', 'accessibility'] as const;

export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/**
 * What macOS says about a grant.
 *
 * The first four match `@loom/format`'s `PermissionState`, which is what
 * `recording.json` records. `unknown` is Electron's fifth value for
 * `getMediaAccessStatus` and it is kept rather than folded away: writing it into
 * `recording.json` as `not-determined` would be recording a guess as a fact, so the
 * narrowing is explicit and happens in one place ({@link toRecordingState}).
 */
export type PermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

/**
 * How this permission can be asked for. The three are genuinely different flows,
 * and treating them as one is how an app ends up with a button that does nothing.
 *
 * - `implicit` — there is no request API. macOS prompts the first time the app
 *   actually tries to capture, and never again. Screen Recording only.
 * - `prompt` — a real request API exists (`systemPreferences.askForMediaAccess`)
 *   that shows the system prompt and resolves with the answer. Camera and mic.
 * - `settings-only` — no grant API at all. The best any app can do is open the
 *   right System Settings pane and say what to switch on. Accessibility only, and
 *   it additionally needs a **relaunch** before the grant reaches this process.
 */
export type RequestMode = 'implicit' | 'prompt' | 'settings-only';

export interface PermissionFacts {
  kind: PermissionKind;
  /** Row heading in the setup window, and the name macOS itself uses. */
  title: string;
  /**
   * `true` for the one permission without which this app has no reason to run.
   * Everything else degrades to a smaller but still working recorder — the
   * captain's decision is explicit that declining Accessibility must still leave a
   * "fully working recorder".
   */
  required: boolean;
  requestMode: RequestMode;
  /**
   * `true` when the grant does not reach an already-running process.
   *
   * Accessibility only, and it is the whole reason phase 2 has a restart flow: the
   * user switches the app on in System Settings, comes back, and nothing works
   * until the process is replaced.
   */
  needsRelaunch: boolean;
  /** What the app does with it. Plain language, one sentence, from the approved design. */
  why: string;
  /**
   * What it does **not** do — the limit, in the quieter voice.
   *
   * Required by the captain's decision, and load-bearing for Accessibility: "reads
   * pointer position and click events only. Not keystrokes, not window contents,
   * not what you type" is the sentence that makes the ask reasonable.
   */
  limit: string;
  /** What the user loses by saying no. Shown wherever the app runs degraded. */
  whatBreaks: string;
  /** The exact System Settings pane, named the way the user will see it. */
  settingsPaneName: string;
  /**
   * The `x-apple.systempreferences:` deep link for that pane (architecture report
   * §7.3 names the Screen Recording one verbatim; research report §5.3 note 5 the
   * Accessibility one).
   *
   * These are the only URLs this app ever hands to `shell.openExternal` outside a
   * browser link, and {@link isSettingsUrl} is what main checks before it does.
   */
  settingsUrl: string;
}

const SETTINGS_ROOT = 'x-apple.systempreferences:com.apple.preference.security';

/**
 * The table. Copy is lifted verbatim from the approved mockup
 * (`data/loom-design/a-permissions.html`) — that page *is* the approved wording,
 * so it is quoted rather than paraphrased.
 */
export const PERMISSIONS: Readonly<Record<PermissionKind, Readonly<PermissionFacts>>> = {
  screen: {
    kind: 'screen',
    title: 'Screen Recording',
    required: true,
    // No `askForMediaAccess('screen')` exists. macOS prompts on the first real
    // capture attempt and, once answered, never asks again — which is why the
    // refusal path in the setup window is a numbered list and a relaunch button
    // rather than a second "Allow".
    requestMode: 'implicit',
    needsRelaunch: true,
    why:
      'Captures the display, window or region you pick. This is the picture — ' +
      'without it there is no recording at all.',
    limit: 'Only while a recording is running, and only the source you chose in the setup panel.',
    whatBreaks: 'Nothing can be recorded at all.',
    settingsPaneName: 'Privacy & Security › Screen & System Audio Recording',
    settingsUrl: `${SETTINGS_ROOT}?Privacy_ScreenCapture`,
  },
  camera: {
    kind: 'camera',
    title: 'Camera',
    required: false,
    requestMode: 'prompt',
    needsRelaunch: false,
    why:
      'Records your face to a separate video file, so the bubble’s shape, size and ' +
      'position stay changeable after the fact instead of being burned into the picture.',
    limit: 'Turn the camera off in the setup panel and this is never opened.',
    whatBreaks: 'No camera bubble. Screen, cursor and audio are unaffected.',
    settingsPaneName: 'Privacy & Security › Camera',
    settingsUrl: `${SETTINGS_ROOT}?Privacy_Camera`,
  },
  microphone: {
    kind: 'microphone',
    title: 'Microphone',
    required: false,
    requestMode: 'prompt',
    needsRelaunch: false,
    why:
      'Records your voice to its own audio track, so it can be levelled or muted in ' +
      'the editor without touching anything else.',
    limit:
      'System audio — what your speakers are playing — is a different thing that macOS ' +
      'will not grant to any app on its own. That one needs a helper.',
    whatBreaks: 'Recordings have no voice track. The picture is unaffected.',
    settingsPaneName: 'Privacy & Security › Microphone',
    settingsUrl: `${SETTINGS_ROOT}?Privacy_Microphone`,
  },
  accessibility: {
    kind: 'accessibility',
    title: 'Accessibility',
    required: false,
    // There is no API that grants this and none that prompts for it usefully:
    // `isTrustedAccessibilityClient(true)` shows a dialog whose only button opens
    // System Settings. The honest model is "we can open the pane, and that is all".
    requestMode: 'settings-only',
    needsRelaunch: true,
    why:
      'Logs where your pointer is and when you click, as timestamps in a text file. ' +
      'That log is what makes auto-zoom-on-click and cursor-follow possible later.',
    limit:
      'It reads pointer position and click events only. Not keystrokes, not window ' +
      'contents, not what you type. Skip it and manual zoom keyframes still work.',
    whatBreaks:
      'Click-triggered auto-zoom and click highlights are off. Cursor-follow by position, ' +
      'manual zoom and everything else keep working.',
    settingsPaneName: 'Privacy & Security › Accessibility',
    settingsUrl: `${SETTINGS_ROOT}?Privacy_Accessibility`,
  },
};

/** The four, in display order, as an array. */
export const PERMISSION_LIST: readonly Readonly<PermissionFacts>[] = PERMISSION_KINDS.map(
  (kind) => PERMISSIONS[kind],
);

export function isPermissionKind(value: unknown): value is PermissionKind {
  return typeof value === 'string' && (PERMISSION_KINDS as readonly string[]).includes(value);
}

/**
 * The allow-list `shell.openExternal` is checked against in main.
 *
 * `windows.ts` deliberately restricts renderer-supplied URLs to `http:`/`https:`,
 * because `openExternal` hands whatever it is given to the OS handler for that
 * scheme. A settings deep link is a fifth thing main may open, so it is a closed set
 * of four exact strings rather than a scheme check — a renderer naming
 * `x-apple.systempreferences:` freely would be a widening of that surface, and a
 * renderer here names a {@link PermissionKind} instead.
 */
export function isSettingsUrl(url: string): boolean {
  return PERMISSION_LIST.some((facts) => facts.settingsUrl === url);
}

/**
 * Narrow to the four values `recording.json` may carry (`@loom/format`'s
 * `PermissionState`).
 *
 * `unknown` becomes `not-determined`, which is the closest true statement: macOS
 * declined to say, so we have not established that it was granted. Doing this in one
 * named function, rather than with a cast at each call site, is what keeps a guess
 * from being written into a user's recording as a fact.
 */
export function toRecordingState(
  status: PermissionStatus,
): 'granted' | 'denied' | 'not-determined' | 'restricted' {
  return status === 'unknown' ? 'not-determined' : status;
}
