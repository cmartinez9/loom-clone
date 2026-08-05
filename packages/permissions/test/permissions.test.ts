/**
 * The permission model, asserted without an Electron.
 *
 * Two of these tests are the phase 2 gate expressed as code rather than as prose in
 * a report, and they are the reason this package is pure:
 *
 * - **provenance beats status.** A `granted` from a dev binary must never satisfy
 *   {@link isTrustworthy}, because it is the terminal's grant (research report §7,
 *   trap 6).
 * - **`axTrusted` alone is never "clicks work".** The captain's decision exists
 *   because the click API succeeds without the permission and then delivers nothing;
 *   a model that concludes `live` from TCC alone would ship that failure.
 */

import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_KINDS,
  PERMISSION_LIST,
  allGranted,
  blockingKinds,
  canRecord,
  concludeAccessibility,
  degradedKinds,
  describeAccessibility,
  describePermission,
  describeProvenance,
  isPermissionKind,
  isSettingsUrl,
  isTrustworthy,
  relaunchRequired,
  summarize,
  toRecordingState,
  type AccessibilityDetail,
  type PermissionKind,
  type PermissionReport,
  type PermissionStatus,
} from '../src/index.ts';

function report(
  statuses: Partial<Record<PermissionKind, PermissionStatus>> = {},
  accessibility: Partial<AccessibilityDetail> = {},
  provenance = { packaged: true, responsibleForSelf: true },
): PermissionReport {
  return {
    statuses: {
      screen: 'granted',
      camera: 'granted',
      microphone: 'granted',
      accessibility: 'granted',
      ...statuses,
    },
    accessibility: { axTrusted: true, tapLive: null, settingsOpened: false, ...accessibility },
    provenance,
  };
}

describe('the four permissions', () => {
  it('is exactly the set the captain decided to ask for up front', () => {
    // `decision-accessibility-clicks.md`: "First-run setup requests Screen Recording,
    // Camera, Microphone and Accessibility together, as one deliberate onboarding
    // step." A fifth arriving quietly would change what the user is asked in a way
    // the decision did not settle.
    expect([...PERMISSION_KINDS]).toEqual(['screen', 'camera', 'microphone', 'accessibility']);
    expect(PERMISSION_LIST.map((f) => f.kind)).toEqual([...PERMISSION_KINDS]);
  });

  it('makes exactly one of them required', () => {
    // The captain's decision requires a user who declines the optional ones to still
    // get "a fully working recorder". More than one required grant would break that.
    expect(PERMISSION_LIST.filter((f) => f.required).map((f) => f.kind)).toEqual(['screen']);
  });

  it('says what each one does and what it does not do', () => {
    for (const facts of PERMISSION_LIST) {
      expect(facts.why.length, `${facts.kind} has no explanation`).toBeGreaterThan(40);
      expect(facts.limit.length, `${facts.kind} does not state its limit`).toBeGreaterThan(40);
      expect(facts.whatBreaks.length, `${facts.kind} does not say what breaks`).toBeGreaterThan(20);
    }
  });

  it('states the Accessibility limit the captain asked for, in so many words', () => {
    // "state that it is used to detect clicks for auto-zoom and nothing else." This
    // is the sentence that earns the most invasive of the four, so it is asserted
    // rather than left to survive the next copy edit by luck.
    const limit = PERMISSIONS.accessibility.limit;
    expect(limit).toMatch(/pointer position and click events only/i);
    expect(limit).toMatch(/not keystrokes/i);
    expect(limit).toMatch(/not what you type/i);
  });

  it('promises a working recorder without Accessibility', () => {
    expect(PERMISSIONS.accessibility.whatBreaks).toMatch(/cursor-follow by position/i);
    expect(PERMISSIONS.accessibility.whatBreaks).toMatch(/manual zoom/i);
  });

  it('knows which grants do not reach a running process', () => {
    // Camera and mic take effect immediately; screen and Accessibility need the app
    // replaced. Offering a relaunch for the first two would be an action that cannot
    // change the outcome.
    expect(PERMISSION_LIST.filter((f) => f.needsRelaunch).map((f) => f.kind)).toEqual([
      'screen',
      'accessibility',
    ]);
  });

  it('has a distinct System Settings deep link for each, and allows no other url', () => {
    const urls = PERMISSION_LIST.map((f) => f.settingsUrl);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) {
      expect(url.startsWith('x-apple.systempreferences:')).toBe(true);
      expect(isSettingsUrl(url)).toBe(true);
    }
    // The allow-list is a closed set of exact strings, not a scheme check: anything
    // else handed to `shell.openExternal` goes to whatever the OS has registered.
    expect(isSettingsUrl('x-apple.systempreferences:com.apple.anything')).toBe(false);
    expect(isSettingsUrl('https://example.com')).toBe(false);
  });

  it('matches architecture report §7.3’s Screen Recording link verbatim', () => {
    expect(PERMISSIONS.screen.settingsUrl).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  it('recognises its own kinds and nothing else', () => {
    expect(isPermissionKind('camera')).toBe(true);
    expect(isPermissionKind('bluetooth')).toBe(false);
    expect(isPermissionKind(null)).toBe(false);
  });
});

describe('provenance', () => {
  it('refuses to call a dev binary’s answers trustworthy', () => {
    // The whole phase 2 gate. Everything granted, and it still does not count.
    const dev = report({}, {}, { packaged: false, responsibleForSelf: true });
    expect(allGranted(dev)).toBe(true);
    expect(isTrustworthy(dev)).toBe(false);
    expect(describeProvenance(dev)).toMatch(/development build/i);
  });

  it('refuses a packaged app that something else was responsible for launching', () => {
    const shellLaunched = report({}, {}, { packaged: true, responsibleForSelf: false });
    expect(isTrustworthy(shellLaunched)).toBe(false);
    expect(describeProvenance(shellLaunched)).toMatch(/launched from another process/i);
  });

  it('is silent when there is nothing wrong', () => {
    expect(isTrustworthy(report())).toBe(true);
    expect(describeProvenance(report())).toBeNull();
  });
});

describe('the accessibility conclusion', () => {
  it('never calls TCC’s word alone "live"', () => {
    // The failure the captain's decision is about: the tap succeeds and delivers
    // nothing. `trusted-unverified` is the honest state and it is what this build,
    // with no sampler, is genuinely in.
    expect(concludeAccessibility({ axTrusted: true, tapLive: null, settingsOpened: false })).toBe(
      'trusted-unverified',
    );
    expect(describeAccessibility('trusted-unverified')).toMatch(/has not been checked/i);
  });

  it('is live only when a tap has been observed delivering', () => {
    expect(concludeAccessibility({ axTrusted: true, tapLive: true, settingsOpened: false })).toBe(
      'live',
    );
  });

  it('calls trusted-but-dead a relaunch, because that is the only fix', () => {
    expect(concludeAccessibility({ axTrusted: true, tapLive: false, settingsOpened: false })).toBe(
      'relaunch-required',
    );
    expect(describeAccessibility('relaunch-required')).toMatch(/after a\s+restart/i);
  });

  it('distinguishes never-asked from asked-and-maybe-granted', () => {
    // The half phase 5 explicitly left here: from inside the sampler these two look
    // identical, and only the side that opened the pane knows a relaunch is worth
    // offering.
    expect(concludeAccessibility({ axTrusted: false, tapLive: null, settingsOpened: false })).toBe(
      'not-granted',
    );
    expect(concludeAccessibility({ axTrusted: false, tapLive: null, settingsOpened: true })).toBe(
      'relaunch-to-find-out',
    );
  });

  it('offers a relaunch for both undecided cases and neither decided one', () => {
    expect(relaunchRequired(report({}, { tapLive: false }))).toBe(true);
    expect(
      relaunchRequired(
        report(
          { accessibility: 'denied' },
          {
            axTrusted: false,
            settingsOpened: true,
          },
        ),
      ),
    ).toBe(true);
    expect(relaunchRequired(report({}, { tapLive: true }))).toBe(false);
    expect(relaunchRequired(report({ accessibility: 'denied' }, { axTrusted: false }))).toBe(false);
  });
});

describe('what blocks and what degrades', () => {
  it('lets everything but screen be missing', () => {
    const minimal = report({ camera: 'denied', microphone: 'denied', accessibility: 'denied' });
    expect(canRecord(minimal)).toBe(true);
    expect(blockingKinds(minimal)).toEqual([]);
    expect(degradedKinds(minimal)).toEqual(['camera', 'microphone', 'accessibility']);
  });

  it('blocks on screen alone', () => {
    const noScreen = report({ screen: 'denied' });
    expect(canRecord(noScreen)).toBe(false);
    expect(blockingKinds(noScreen)).toEqual(['screen']);
  });

  it('treats restricted and not-determined as not granted, because they are', () => {
    expect(canRecord(report({ screen: 'restricted' }))).toBe(false);
    expect(canRecord(report({ screen: 'not-determined' }))).toBe(false);
    expect(canRecord(report({ screen: 'unknown' }))).toBe(false);
  });
});

describe('describing a status', () => {
  it('says what breaks, not just that something is off', () => {
    for (const kind of PERMISSION_KINDS) {
      const text = describePermission(kind, 'denied');
      expect(text).toContain(PERMISSIONS[kind].title);
      expect(text).toMatch(/System Settings|Privacy/);
    }
  });

  it('does not launder an unknown into a claim', () => {
    expect(describePermission('camera', 'unknown')).toMatch(/did not say/i);
  });

  it('summarises a report in one line and flags an untrustworthy one', () => {
    expect(summarize(report())).not.toMatch(/UNTRUSTWORTHY/);
    expect(summarize(report({}, {}, { packaged: false, responsibleForSelf: true }))).toMatch(
      /UNTRUSTWORTHY/,
    );
  });
});

describe('narrowing for recording.json', () => {
  it('keeps the four values the format has, and maps the fifth explicitly', () => {
    expect(toRecordingState('granted')).toBe('granted');
    expect(toRecordingState('denied')).toBe('denied');
    expect(toRecordingState('restricted')).toBe('restricted');
    expect(toRecordingState('not-determined')).toBe('not-determined');
    // `unknown` is not a `PermissionState`. Casting it would put a value in a user's
    // recording that the type says cannot be there.
    expect(toRecordingState('unknown')).toBe('not-determined');
  });
});
