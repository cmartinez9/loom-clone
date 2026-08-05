/**
 * The IPC boundary, asserted mechanically.
 *
 * Architecture report §1.4 states two rules that are easy to write down and easy to
 * erode one convenient shortcut at a time. This file turns both into build
 * failures.
 *
 * 1. **Raw and decoded frames never cross a process boundary.** A single 3456×2234
 *    NV12 frame is 11.6 MB; at 30 fps that is 347 MB/s of structured-clone traffic
 *    to accomplish nothing. Encoded chunks may cross — measured 289 MB/s against a
 *    ~2 MB/s requirement.
 * 2. **The preload exposes a fixed surface, never a passthrough.** A generic
 *    `invoke(channel, ...args)` would hand every present and future channel to
 *    whatever ends up running in a renderer and would make the contract
 *    unenforceable in one line.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CHANNEL,
  INVOKE_CHANNELS,
  LOOM_HOST,
  LOOM_SCHEME,
  SEND_CHANNELS,
  appUrl,
  isConflict,
  recordingUrl,
} from '../src/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const CONTRACT = resolve(repoRoot, 'packages/ipc/src/index.ts');
const PRELOAD = resolve(repoRoot, 'apps/main/src/preload.ts');

/**
 * Type names that must never appear in a payload that crosses IPC. Matched as
 * whole words so prose in a comment explaining the rule does not trip it — the
 * check is on `: VideoFrame`-shaped usage, not on the words themselves.
 */
const FORBIDDEN = [
  'VideoFrame',
  'AudioData',
  'ImageBitmap',
  'ImageData',
  'OffscreenCanvas',
  'WebGLFramebuffer',
  'CanvasRenderingContext2D',
];

/** Strip comments so the rule can be *explained* in the file it governs. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('nothing raw crosses IPC', () => {
  it('the contract names no frame or pixel-buffer type', async () => {
    const code = stripComments(await readFile(CONTRACT, 'utf8'));
    for (const name of FORBIDDEN) {
      expect(code, `@loom/ipc must not carry ${name} across a process boundary`).not.toMatch(
        new RegExp(`\\b${name}\\b`),
      );
    }
  });

  it('the preload names no frame or pixel-buffer type', async () => {
    const code = stripComments(await readFile(PRELOAD, 'utf8'));
    for (const name of FORBIDDEN) {
      expect(code, `the preload must not carry ${name} across a process boundary`).not.toMatch(
        new RegExp(`\\b${name}\\b`),
      );
    }
  });

  it('the high-rate capture channel carries encoded bytes, not frames', async () => {
    const code = await readFile(CONTRACT, 'utf8');
    // `ChunkMsg.data` is a `Uint8Array` of already-encoded output. That is the
    // whole reason the channel is affordable.
    expect(code).toMatch(/data:\s*Uint8Array/);
  });
});

describe('the preload surface', () => {
  it('exposes no generic invoke passthrough', async () => {
    const code = stripComments(await readFile(PRELOAD, 'utf8'));
    // Every `invoke` must name a constant from CHANNEL. A call whose first
    // argument is a variable is a passthrough.
    const invocations = [...code.matchAll(/ipcRenderer\.(invoke|send)\(([^,)]+)/g)];
    expect(invocations.length).toBeGreaterThan(0);
    for (const [, , firstArg] of invocations) {
      expect(firstArg?.trim(), 'preload channels must be literals from CHANNEL').toMatch(
        /^CHANNEL\.\w+$/,
      );
    }
  });

  it('gives a renderer no filesystem, no node and no electron beyond the bridge', async () => {
    const code = stripComments(await readFile(PRELOAD, 'utf8'));
    expect(code).not.toMatch(/require\(/);
    expect(code).not.toMatch(/\bnode:/);
    expect(code).not.toMatch(/\bfs\b/);
    // The only electron imports are the two the bridge needs.
    const electronImport = /import\s*{([^}]*)}\s*from\s*'electron'/.exec(code);
    const imported = (electronImport?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(imported.sort()).toEqual(['contextBridge', 'ipcRenderer']);
  });

  it('binds every declared channel and declares every bound channel', async () => {
    const code = stripComments(await readFile(PRELOAD, 'utf8'));
    const bound = new Set([...code.matchAll(/CHANNEL\.(\w+)/g)].map(([, name]) => name!));
    expect([...bound].sort()).toEqual(Object.keys(CHANNEL).sort());
  });

  it('separates invoke channels from send-only ones with no overlap', () => {
    const all = new Set(Object.values(CHANNEL));
    expect(new Set([...INVOKE_CHANNELS, ...SEND_CHANNELS])).toEqual(all);
    for (const channel of INVOKE_CHANNELS) expect(SEND_CHANNELS).not.toContain(channel);
  });
});

describe('loom:// urls', () => {
  it('builds a recording url with every segment encoded', () => {
    expect(recordingUrl('01K1Y7', 'media/screen.000.mp4')).toBe(
      'loom://recording/01K1Y7/media/screen.000.mp4',
    );
    // A name with a slash or a space cannot break out of its segment.
    expect(recordingUrl('a/b', 'media/a b.mp4')).toBe('loom://recording/a%2Fb/media/a%20b.mp4');
  });

  it('builds an app url', () => {
    expect(appUrl('library.html')).toBe('loom://app/library.html');
  });

  it('has exactly two hosts', () => {
    expect(Object.values(LOOM_HOST).sort()).toEqual(['app', 'recording']);
    expect(LOOM_SCHEME).toBe('loom');
  });
});

describe('applyOps results', () => {
  it('distinguishes a revision from a conflict', () => {
    expect(isConflict({ revision: 3 })).toBe(false);
    expect(
      isConflict({
        conflict: {
          schema: 'loom.edit/1',
          revision: 4,
          output: { size: [1920, 1080], fps: 30, background: { kind: 'none' } },
          clips: [],
          tracks: [],
        },
      }),
    ).toBe(true);
  });
});
