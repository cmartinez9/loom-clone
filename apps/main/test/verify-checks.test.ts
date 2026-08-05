/**
 * The one rule the verification harness cannot be talked out of.
 *
 * Architecture report §8 makes phase 2's gate *"run from a signed bundle, not a dev
 * binary"*. `sealReport` is that rule as code: it rewrites every `pass` to
 * `untrusted` when the run's provenance says the answers were not about this app.
 *
 * These tests exist because the failure mode is not a crash. A harness that quietly
 * returned `verified` from a dev binary would look exactly like a working harness,
 * and the thing it certified — that `setContentProtection` keeps our HUD out of a
 * recording — would be believed by everyone downstream without anyone having watched
 * a single pixel.
 */

import { describe, expect, it } from 'vitest';
import {
  formatReport,
  sealReport,
  type CheckResult,
  type VerifyReport,
} from '../src/verify/checks.ts';

function draft(
  checks: CheckResult[],
  trustworthy: boolean,
): Omit<VerifyReport, 'outcome' | 'trustworthy'> & { trustworthy: boolean } {
  return {
    startedAt: '2026-08-05T00:00:00.000Z',
    finishedAt: '2026-08-05T00:00:10.000Z',
    bundleId: 'com.github.cmartinez9.loom-clone',
    appVersion: '0.1.0',
    electronVersion: '43.3.0',
    macosVersion: '14.0',
    provenance: { packaged: trustworthy, responsibleForSelf: trustworthy },
    trustworthy,
    permissions: {
      statuses: {
        screen: 'granted',
        camera: 'granted',
        microphone: 'granted',
        accessibility: 'granted',
      },
      accessibility: { axTrusted: true, tapLive: true, settingsOpened: false },
      provenance: { packaged: trustworthy, responsibleForSelf: trustworthy },
    },
    checks,
  };
}

const passing: CheckResult = {
  id: 'content-protection',
  title: 'setContentProtection keeps the HUD out of captured pixels',
  status: 'pass',
  detail: 'The control showed the marker and the protected HUD did not.',
};

describe('sealReport downgrades a pass it cannot stand behind', () => {
  it('turns every pass into untrusted when the build is a dev binary', () => {
    const sealed = sealReport(draft([passing], false));
    expect(sealed.checks[0]?.status).toBe('untrusted');
    expect(sealed.checks[0]?.detail).toMatch(/cannot be believed/i);
    expect(sealed.outcome).toBe('incomplete');
  });

  it('CONTROL: the same check passes from a trustworthy build', () => {
    // Without this the test above would pass just as well against a `sealReport`
    // that downgraded everything unconditionally — which would be a harness that can
    // never certify anything and would look, from the failing side, identical.
    const sealed = sealReport(draft([passing], true));
    expect(sealed.checks[0]?.status).toBe('pass');
    expect(sealed.outcome).toBe('verified');
  });

  it('leaves the identity check honest, because it is what establishes trust', () => {
    // `bundle-identity` reports on the very thing the downgrade is derived from.
    // Downgrading it would erase the only check able to say *why* the run cannot be
    // trusted.
    const identity: CheckResult = {
      id: 'bundle-identity',
      title: 'Running from a signed bundle',
      status: 'pass',
      detail: 'Packaged and launched by LaunchServices.',
    };
    const sealed = sealReport(draft([identity, passing], false));
    expect(sealed.checks[0]?.status).toBe('pass');
    expect(sealed.checks[1]?.status).toBe('untrusted');
  });

  it('does not promote a fail, a block or a skip', () => {
    const others: CheckResult[] = [
      { id: 'a', title: 'a', status: 'fail', detail: 'broken' },
      { id: 'b', title: 'b', status: 'blocked', detail: 'no grant' },
      { id: 'c', title: 'c', status: 'skipped', detail: 'no sampler' },
    ];
    const sealed = sealReport(draft(others, false));
    expect(sealed.checks.map((c) => c.status)).toEqual(['fail', 'blocked', 'skipped']);
  });
});

describe('the outcome', () => {
  it('is verified only when every check passed', () => {
    expect(sealReport(draft([passing], true)).outcome).toBe('verified');
  });

  it('is failed when anything failed, even alongside passes', () => {
    const sealed = sealReport(
      draft([passing, { id: 'x', title: 'x', status: 'fail', detail: 'no' }], true),
    );
    expect(sealed.outcome).toBe('failed');
  });

  it('is incomplete when something could not run', () => {
    const sealed = sealReport(
      draft([passing, { id: 'x', title: 'x', status: 'skipped', detail: 'no sampler' }], true),
    );
    // Not "verified with an asterisk". A skipped obligation is an open obligation.
    expect(sealed.outcome).toBe('incomplete');
  });

  it('can never be verified from an untrustworthy build, whatever the checks saw', () => {
    expect(sealReport(draft([passing], false)).outcome).not.toBe('verified');
  });
});

describe('the human rendering', () => {
  it('says out loud that nothing may be called verified', () => {
    const text = formatReport(sealReport(draft([passing], false)));
    expect(text).toMatch(/may be described as verified/i);
    expect(text).toMatch(/trap 6/);
  });

  it('names each check and what it closes', () => {
    const text = formatReport(
      sealReport(draft([{ ...passing, obligation: 'the §11 assumption' }], true)),
    );
    expect(text).toContain('setContentProtection keeps the HUD out of captured pixels');
    expect(text).toContain('closes: the §11 assumption');
  });
});
