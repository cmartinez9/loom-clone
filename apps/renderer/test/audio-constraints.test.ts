/**
 * Research trap 3, and specifically the half of it that is easy to skip.
 *
 * > *"The system-audio track defaults to mono with AEC + NS + AGC enabled and will
 * > wreck any recording containing music or video. Always pass explicit
 * > constraints."*  — research report §7, trap 3
 *
 * Stating the constraints is the easy half, and a run on a machine that honours
 * them proves it: `scripts/smoke-capture.mjs` writes `echoCancellation: false`,
 * `noiseSuppression: false`, `autoGainControl: false`, `channelCount: 2` into
 * `recording.json` for both audio tracks. The hard half is what happens on a
 * machine that *ignores* one, which no run on a compliant machine can show and
 * which is exactly the case the trap is about — the platform silently applies
 * voice processing to what should be a clean loopback.
 *
 * The decision this file pins down: a constraint the platform ignored **does not
 * refuse the recording**. Audio the user asked for is worth having even when it
 * has been processed; what must not happen is silence about it. So the track is
 * kept, the settings that were *actually applied* are what get recorded (never the
 * ones we asked for), every ignored constraint is named, and the page says so
 * loudly — because the alternative is a recording that sounds wrong for reasons
 * nobody can reconstruct a month later.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAPTURE_OPTIONS,
  LOOPBACK_AUDIO_CONSTRAINTS,
  violatedLoopbackConstraints,
  type CaptureOptions,
} from '@loom/ipc';
import { loopbackFacts, micConstraints, settingsOf } from '../src/capture/audio.ts';

/** A track that reports whatever the platform decided to give us. */
function audioTrack(settings: Record<string, unknown>, label = 'System audio'): MediaStreamTrack {
  return { label, getSettings: () => settings } as unknown as MediaStreamTrack;
}

/** What a machine that honoured every constraint hands back. */
const HONOURED = {
  deviceId: 'loopback',
  sampleRate: 48000,
  channelCount: 2,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/** What the trap describes: the defaults, applied despite being asked not to. */
const PROCESSED = {
  deviceId: 'loopback',
  sampleRate: 48000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the constraints the loopback is asked for', () => {
  it('turns off all three processors and asks for stereo', () => {
    // The "set" half of trap 3, as a constant rather than an option: a loopback
    // capture has no echo to cancel, no noise to suppress and no level to ride.
    expect(LOOPBACK_AUDIO_CONSTRAINTS.echoCancellation).toBe(false);
    expect(LOOPBACK_AUDIO_CONSTRAINTS.noiseSuppression).toBe(false);
    expect(LOOPBACK_AUDIO_CONSTRAINTS.autoGainControl).toBe(false);
    expect(LOOPBACK_AUDIO_CONSTRAINTS.channelCount).toBe(2);
  });

  it('captures the microphone clean too, unless the user asks otherwise', () => {
    // The same processing, and the same irreversibility: nothing in this project
    // is baked in before export, so the default is the conservative one.
    expect(DEFAULT_CAPTURE_OPTIONS.micVoiceProcessing).toBe(false);
    const off = micConstraints(DEFAULT_CAPTURE_OPTIONS);
    expect(off.echoCancellation).toBe(false);
    expect(off.noiseSuppression).toBe(false);
    expect(off.autoGainControl).toBe(false);

    const asked: CaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS, micVoiceProcessing: true };
    const on = micConstraints(asked);
    expect(on.echoCancellation).toBe(true);
    expect(on.noiseSuppression).toBe(true);
    expect(on.autoGainControl).toBe(true);
  });
});

describe('the constraints the platform actually applied', () => {
  it('has nothing to report when every one of them was honoured', () => {
    expect(violatedLoopbackConstraints(settingsOf(audioTrack(HONOURED)))).toEqual([]);
  });

  it('names every processor the platform kept on, and the mono track', () => {
    expect(violatedLoopbackConstraints(settingsOf(audioTrack(PROCESSED)))).toEqual([
      'echoCancellation',
      'noiseSuppression',
      'autoGainControl',
      'channelCount=1',
    ]);
  });

  it('does not complain about a device that gave us more channels than we asked for', () => {
    const surround = { ...HONOURED, channelCount: 6 };
    expect(violatedLoopbackConstraints(settingsOf(audioTrack(surround)))).toEqual([]);
  });
});

describe('a loopback track the platform processed anyway', () => {
  it('is kept, recorded as it really is, and said out loud', () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const facts = loopbackFacts(audioTrack(PROCESSED, 'MacBook Pro Speakers'));

    // Kept: a refusal here would cost the user the system audio they asked for.
    expect(facts.source).toBe('getdisplaymedia-loopback');
    expect(facts.deviceName).toBe('MacBook Pro Speakers');

    // Recorded as it really is — these are the settings that reach recording.json,
    // so the trap is diagnosable from the bundle rather than from memory.
    expect(facts.settings).toEqual({
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(facts.violations).toEqual([
      'echoCancellation',
      'noiseSuppression',
      'autoGainControl',
      'channelCount=1',
    ]);

    // Said out loud: silence about it is the trap.
    expect(complained).toHaveBeenCalledTimes(1);
    const said = String(complained.mock.calls[0]?.[0] ?? '');
    expect(said).toContain('trap 3');
    expect(said).toContain('echoCancellation');
  });

  it('says nothing at all when the platform behaved', () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const facts = loopbackFacts(audioTrack(HONOURED));

    expect(facts.violations).toEqual([]);
    expect(facts.settings.channelCount).toBe(2);
    expect(complained, 'a clean loopback must not cry wolf').not.toHaveBeenCalled();
  });
});
