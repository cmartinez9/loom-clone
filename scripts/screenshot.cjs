/**
 * Screenshot the real app's windows, from inside Electron.
 *
 *   npm run build
 *   npx electron scripts/screenshot.cjs --out shots --theme light
 *
 * Development-only. It boots `dist/main/index.cjs` — the actual main process, with
 * the actual `ProjectStore` and the actual `loom://` protocol — waits for the
 * windows to settle, and uses `webContents.capturePage()` on each. Capturing from
 * inside the app rather than with `screencapture` means the result does not depend
 * on what else is on screen, which Space is active, or whether something is
 * fullscreen.
 *
 * `--theme` forces `data-theme` on the document, so both halves of the token file
 * can be checked without changing the machine's appearance setting.
 */

const { app, BrowserWindow } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}

const outDir = resolve(process.cwd(), arg('out', 'shots'));
const theme = arg('theme', null);
const settleMs = Number(arg('settle-ms', '2500'));

// Boot the real main process.
require(resolve(__dirname, '../dist/main/index.cjs'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(settleMs);
  await mkdir(outDir, { recursive: true });

  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    console.error('screenshot: no windows were opened');
    app.exit(1);
    return;
  }

  for (const [index, window] of windows.entries()) {
    if (theme !== null) {
      await window.webContents.executeJavaScript(
        `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`,
      );
      await wait(300);
    }
    const image = await window.webContents.capturePage();
    const name = `${String(index)}-${theme ?? 'system'}.png`;
    await writeFile(join(outDir, name), image.toPNG());
    console.log(`wrote ${join(outDir, name)}`);
  }

  app.exit(0);
});
