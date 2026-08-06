/**
 * The anti-generic constraint, as a build failure.
 *
 * `data/loom-scope/decision-visual-direction.md`: *"The captain's original
 * constraint stands and is now a review criterion, not a preference: **no
 * AI-generated look.**"* The measured evidence is `data/loom-design/report.md` §2 —
 * Wispr Flow, the captain's own reference, ships **zero gradients, zero
 * backdrop-filters, and exactly one shadow with no blur** across its entire
 * homepage.
 *
 * Not everything in that decision is checkable by a machine. These are the parts
 * that are, and a taste argument is a much shorter conversation when the mechanical
 * half is already settled.
 */

import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');

async function cssFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of [join(packageRoot, 'css'), join(repoRoot, 'apps/renderer/src')]) {
    for (const path of await walk(dir)) {
      if (path.endsWith('.css')) found.push(path);
    }
  }
  return found;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

async function allCss(): Promise<{ path: string; text: string }[]> {
  const paths = await cssFiles();
  return Promise.all(paths.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
}

/** Comments explain the rules; the rules are about declarations. */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('no AI-generated look', () => {
  it('uses no colour-blend gradient anywhere', async () => {
    for (const { path, text } of await allCss()) {
      const code = stripCssComments(text);
      // `repeating-linear-gradient` as a *pattern* (paper tooth, checkerboard mat)
      // is allowed by the design report; a colour blend is not. Neither appears
      // today, so the simplest true assertion is: no gradient function at all.
      expect(code, `${path} must not use a gradient`).not.toMatch(
        /\b(linear|radial|conic)-gradient\(/,
      );
    }
  });

  it('uses no backdrop-filter', async () => {
    for (const { path, text } of await allCss()) {
      expect(stripCssComments(text), `${path} must not use backdrop-filter`).not.toMatch(
        /backdrop-filter\s*:/,
      );
    }
  });

  it('casts no blurred shadow', async () => {
    // The elevation rule: a hard offset shadow with zero blur, and only on things
    // that float above the desktop. Every `box-shadow` must be `var(--lift*)`, and
    // every `--lift*` must end in `0` blur before its colour.
    for (const { path, text } of await allCss()) {
      const code = stripCssComments(text);
      for (const [, value] of code.matchAll(/box-shadow\s*:\s*([^;]+);/g)) {
        expect(value, `${path}: box-shadow must be a --lift token`).toMatch(/var\(--lift/);
      }
      for (const [, value] of code.matchAll(/--lift[a-z-]*\s*:\s*([^;]+);/g)) {
        expect(value, `${path}: --lift must have zero blur`).toMatch(/^\s*-?\d+px\s+-?\d+px\s+0\s/);
      }
    }
  });

  it('has no blue-black neutral and no violet or indigo', async () => {
    // Blue-black (#0B0C10 and friends) is the single most reliable tell of a
    // generated dark UI; the neutrals here are warm, and provably so: in every
    // hex neutral, red is greater than or equal to blue.
    const banned = [
      /#0f172a/i, // shadcn slate-900
      /#64748b/i, // shadcn slate-500
      /#6366f1/i, // indigo-500
      /#8b5cf6/i, // violet-500
      /#a78bfa/i,
      /#4d2ff5/i, // Screen Studio's violet — our closest competitor wears it
    ];
    for (const { path, text } of await allCss()) {
      for (const pattern of banned) {
        expect(text, `${path} must not use ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps every neutral warm — red never below blue', async () => {
    const tokens = await readFile(join(packageRoot, 'css/tokens.css'), 'utf8');
    const neutrals = [...tokens.matchAll(/--(paper|ink|night)-\d+:\s*#([0-9A-Fa-f]{6})/g)];
    expect(neutrals.length).toBeGreaterThan(10);
    for (const [, name, hex] of neutrals) {
      const r = Number.parseInt(hex!.slice(0, 2), 16);
      const b = Number.parseInt(hex!.slice(4, 6), 16);
      expect(r, `--${String(name)} #${String(hex)} is cool, not warm`).toBeGreaterThanOrEqual(b);
    }
  });

  it('ships no Inter and no font CDN', async () => {
    for (const { path, text } of await allCss()) {
      expect(text, `${path} must not reference Inter`).not.toMatch(/\bInter\b/);
      expect(text, `${path} must not fetch a font over the network`).not.toMatch(
        /@import\s+url\(["']?https?:/,
      );
      for (const [, url] of text.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        expect(url, `${path}: every asset is self-hosted`).not.toMatch(/^https?:/);
      }
    }
  });

  it('self-hosts all five faces', async () => {
    const fonts = await readdir(join(packageRoot, 'fonts'));
    expect(fonts.filter((f) => f.endsWith('.woff2')).sort()).toEqual([
      'instrument-serif-italic.woff2',
      'instrument-serif-normal.woff2',
      'martian-mono-normal.woff2',
      'mona-sans-italic.woff2',
      'mona-sans-normal.woff2',
    ]);
    for (const font of fonts) {
      expect((await stat(join(packageRoot, 'fonts', font))).size).toBeGreaterThan(1000);
    }
  });

  it('uses no emoji as iconography', async () => {
    const sources = [
      join(packageRoot, 'src/icons.ts'),
      join(repoRoot, 'apps/renderer/src/library/main.ts'),
      join(repoRoot, 'apps/renderer/src/library.html'),
      // The editor is the largest surface in the app and the one most likely to
      // reach for a glyph instead of an icon, so it is on the list too.
      join(repoRoot, 'apps/renderer/src/editor/main.ts'),
      join(repoRoot, 'apps/renderer/src/editor/timeline.ts'),
      join(repoRoot, 'apps/renderer/src/editor.html'),
    ];
    const emoji = /\p{Extended_Pictographic}/u;
    for (const path of sources) {
      expect(await readFile(path, 'utf8'), `${path} must contain no emoji`).not.toMatch(emoji);
    }
  });

  it('draws icons with butt caps and mitre joins, never round', async () => {
    // The visible, checkable difference from the Feather/Lucide set that ships
    // with every generated interface (design report §6).
    const icons = await readFile(join(packageRoot, 'src/icons.ts'), 'utf8');
    expect(icons).toMatch(/stroke-linecap="butt"/);
    expect(icons).toMatch(/stroke-linejoin="miter"/);
    expect(icons).not.toMatch(/stroke-linecap="round"/);
    expect(icons).toMatch(/stroke-width="1\.75"/);
  });
});

describe('tokens.css is the authoritative file, unmodified', () => {
  it('still declares the roles the rest of the app is written against', async () => {
    const tokens = await readFile(join(packageRoot, 'css/tokens.css'), 'utf8');
    for (const role of [
      '--bg',
      '--bg-raised',
      '--bg-sunken',
      '--bg-deep',
      '--fg',
      '--fg-muted',
      '--fg-subtle',
      '--fg-faint',
      '--keyline',
      '--divider',
      '--accent',
      '--ok',
      '--audio',
      '--stage',
      '--lift',
    ]) {
      expect(tokens, `tokens.css must declare ${role}`).toMatch(new RegExp(`\\${role}\\s*:`));
    }
  });

  it('keeps the stage theme-invariant', async () => {
    // "The one rule worth restating: THE STAGE IS ALWAYS DARK." Footage is judged
    // against a constant ground in both modes, the way a lightbox is a constant
    // regardless of the room. Mechanically that means every `--stage*` property is
    // declared exactly once — a second declaration is a theme override by
    // definition, whichever block it sits in.
    const tokens = stripCssComments(await readFile(join(packageRoot, 'css/tokens.css'), 'utf8'));
    const counts = new Map<string, number>();
    for (const [, name] of tokens.matchAll(/(--stage[a-z0-9-]*)\s*:/g)) {
      counts.set(name!, (counts.get(name!) ?? 0) + 1);
    }
    expect(counts.size).toBeGreaterThan(4);
    for (const [name, count] of counts) {
      expect(count, `${name} is redeclared; the stage must not flip with the theme`).toBe(1);
    }

    // And the theme blocks themselves do exist, so the check above is meaningful.
    expect(tokens).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(tokens).toMatch(/:root\[data-theme="dark"\]/);
  });
});
