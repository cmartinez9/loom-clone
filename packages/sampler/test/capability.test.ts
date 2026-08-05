/**
 * The capability model — the small explicit API phase 2 drives its permission UI from.
 *
 * The captain's decision requires the app to *"detect the grant, tell the user a
 * restart is needed, and offer to relaunch"*, and to *"verify the grant with
 * `AXIsProcessTrusted()`, never by assuming"*. `needsRestart` is that detection, and
 * `describeClickCapability` is the sentence — kept beside the state so the main-process
 * log, `recording.json` and whatever phase 2 renders cannot drift apart.
 */

import { describe, expect, it } from 'vitest';
import {
  describeClickCapability,
  failedClickCapability,
  initialClickCapability,
  needsRestart,
} from '../src/capability.ts';
import { CLICK_UNAVAILABLE_REASONS, type ClickTapState } from '../src/protocol.ts';

const state = (over: Partial<ClickTapState> = {}): ClickTapState => ({
  available: false,
  reason: 'accessibility-denied',
  requested: true,
  axTrusted: false,
  tapCreated: false,
  tapEnabled: false,
  ...over,
});

describe('needsRestart', () => {
  it('is true when TCC trusts the process and no live tap can be built', () => {
    // The one combination with exactly one fix: an Accessibility grant does not
    // reach a running process's event taps.
    expect(needsRestart(state({ axTrusted: true, tapCreated: true, tapEnabled: false }))).toBe(
      true,
    );
  });

  it('is false when the grant is simply absent', () => {
    // Telling somebody to relaunch when they have not granted anything wastes a
    // restart and teaches them the message is noise.
    expect(needsRestart(state({ axTrusted: false }))).toBe(false);
  });

  it('is false when the tap is live', () => {
    expect(
      needsRestart(state({ available: true, axTrusted: true, tapCreated: true, tapEnabled: true })),
    ).toBe(false);
  });

  it('is false when clicks were never asked for', () => {
    expect(needsRestart(state({ requested: false, axTrusted: true }))).toBe(false);
  });
});

describe('initialClickCapability', () => {
  it('starts with a null count, so nothing can read a zero out of it', () => {
    expect(initialClickCapability(true).count).toBeNull();
    expect(initialClickCapability(true).reason).toBe('unknown');
  });

  it('says not-requested when clicks are off, rather than denied', () => {
    expect(initialClickCapability(false).reason).toBe('not-requested');
  });
});

describe('describeClickCapability', () => {
  it('has a distinct sentence for every reason the protocol can produce', () => {
    const sentences = new Set<string>();
    for (const reason of CLICK_UNAVAILABLE_REASONS) {
      const sentence = describeClickCapability(failedClickCapability(reason));
      expect(sentence.length).toBeGreaterThan(0);
      sentences.add(sentence);
    }
    // `tap-create-failed` and `tap-dead` deliberately share one sentence: from the
    // user's side they are the same event with the same remedy. Everything else is
    // its own case, which is what stops the UI collapsing them into "it didn't work".
    expect(sentences.size).toBe(CLICK_UNAVAILABLE_REASONS.length - 1);
  });

  it('says "relaunch" only when a relaunch would help', () => {
    const denied = failedClickCapability('accessibility-denied');
    expect(describeClickCapability(denied)).not.toContain('restart');

    const granted = {
      ...failedClickCapability('tap-dead'),
      axTrusted: true,
      restartRequired: true,
    };
    expect(describeClickCapability(granted)).toContain('restart');
  });

  it('says the recording is still fine, because it is', () => {
    // Decision: "A user who declines Accessibility must still get a fully working
    // recorder." The copy has to say so, or the user reasonably assumes otherwise.
    for (const reason of ['not-requested', 'accessibility-denied', 'tap-dead'] as const) {
      expect(describeClickCapability(failedClickCapability(reason))).toContain('position');
    }
  });
});
