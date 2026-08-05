/**
 * The app's identity is frozen, and this test is the freeze.
 *
 * Research report §7, trap 7: *"Give the app a stable bundle identifier
 * immediately. TCC keys on identity; a churning identity means repeated permission
 * prompts and mysterious black frames."*
 *
 * A bundle identifier is not a name — it is the key macOS files the user's Screen
 * Recording, Camera, Microphone and Accessibility grants under. Change it and all
 * four are lost: three re-prompt, screen capture returns black frames until they
 * are granted again, and Accessibility does not re-prompt at all but requires a
 * manual System Settings trip and a relaunch.
 *
 * So it is declared once, in `identity.ts`, read by `electron-builder.yml`, and
 * asserted here. If a future phase needs a different identifier, that is a captain
 * decision with a migration story — not an edit that passes CI.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_RECORDINGS_SUBPATH,
  LOOM_BUNDLE_ID,
  LOOM_PRODUCT_NAME,
  MINIMUM_MACOS_VERSION,
} from '../src/identity.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function builderConfig(): Promise<Record<string, unknown>> {
  const text = await readFile(resolve(repoRoot, 'electron-builder.yml'), 'utf8');
  return parseYaml(text) as Record<string, unknown>;
}

describe('bundle identity', () => {
  it('is exactly the value chosen in phase 0 and never changes', () => {
    expect(LOOM_BUNDLE_ID).toBe('com.github.cmartinez9.loom-clone');
  });

  it('is a well-formed CFBundleIdentifier', () => {
    // Apple allows alphanumerics, hyphen and period. Anything else and the signed
    // bundle is rejected at codesign time rather than at review time.
    expect(LOOM_BUNDLE_ID).toMatch(/^[A-Za-z0-9.-]+$/);
    expect(LOOM_BUNDLE_ID.split('.').length).toBeGreaterThanOrEqual(3);
  });

  it('matches the packaging config, which is what actually reaches Info.plist', async () => {
    expect((await builderConfig())['appId']).toBe(LOOM_BUNDLE_ID);
  });

  it('names the product consistently', async () => {
    const config = await builderConfig();
    expect(LOOM_PRODUCT_NAME).toBe('Loom Clone');
    expect(config['productName']).toBe(LOOM_PRODUCT_NAME);
    // The recordings root the user sees in Finder carries the same name.
    expect(DEFAULT_RECORDINGS_SUBPATH).toEqual(['Movies', LOOM_PRODUCT_NAME]);
  });
});

describe('macOS floor', () => {
  /**
   * Captain decision 7 (`data/loom-scope/decision-macos-floor.md`): macOS 14+.
   * Below 14, system audio needs a CoreAudio HAL plug-in, an installer, an admin
   * password prompt and a `coreaudiod` restart — which is exactly the path the
   * decision bought its way out of.
   */
  it('is 14.0 in both places that state it', async () => {
    const config = await builderConfig();
    const mac = config['mac'] as Record<string, unknown>;
    const extendInfo = mac['extendInfo'] as Record<string, unknown>;

    expect(MINIMUM_MACOS_VERSION).toBe('14.0');
    expect(mac['minimumSystemVersion']).toBe('14.0');
    expect(extendInfo['LSMinimumSystemVersion']).toBe('14.0');
  });

  it('targets macOS only — there is no cross-platform hedging in this build', async () => {
    const config = await builderConfig();
    expect(config['win']).toBeUndefined();
    expect(config['linux']).toBeUndefined();
  });

  it('declares the TCC purpose strings a capture build will need', async () => {
    // A *missing* purpose string is not a prompt the user declines; it is an
    // immediate crash the first time the API is touched. Phase 2 owns the final
    // copy; phase 0 owns the fact that the keys exist.
    const mac = (await builderConfig())['mac'] as Record<string, unknown>;
    const extendInfo = mac['extendInfo'] as Record<string, unknown>;
    expect(extendInfo['NSCameraUsageDescription']).toBeTypeOf('string');
    expect(extendInfo['NSMicrophoneUsageDescription']).toBeTypeOf('string');
  });

  it('packages only the bundled dist, with no runtime node_modules', async () => {
    const config = await builderConfig();
    expect(config['files']).toEqual(['dist/**/*', 'package.json']);
  });
});
