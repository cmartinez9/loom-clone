/**
 * The marker instrument: paint a window an unmistakable colour, capture the screen,
 * and count how much of a rectangle came back as that colour.
 *
 * Phase 2 built this to answer one question — *does `setContentProtection(true)`
 * actually keep the recorder HUD out of captured frames?* — and phase 12 asks the
 * same question of the drawing overlay. It lives here rather than in either caller
 * so that the two answers come from one instrument: a second implementation of
 * {@link isMarker} would be a second opinion about what counts as evidence, and the
 * whole value of the phase-2 measurement is that its tolerance was **derived from a
 * failed run** rather than chosen.
 *
 * **The control is the design, not a nicety.** "The marker is absent from the
 * protected window's rectangle" passes just as well when the capture is black, when
 * the coordinates are wrong, or when the window never painted. Every caller of this
 * module therefore places a second window — same page, same size, same paint,
 * `setContentProtection` *not* called — and requires it to show the marker first. If
 * the control does not clear, the run is `blocked` rather than a pass it did not
 * earn.
 *
 * Electron-side by necessity (`desktopCapturer`, `NativeImage`), and deliberately
 * free of anything else: it takes a window, a display and a rectangle.
 */

import { desktopCapturer, type BrowserWindow, type NativeImage } from 'electron';

/** A colour no part of the Pressroom palette contains, so a match is unambiguous. */
export const MARKER = { r: 0xff, g: 0x00, b: 0xff };

/**
 * Whether a captured pixel is the marker.
 *
 * **Not an exact match, and the reason is measured rather than defensive.** The
 * marker is painted as sRGB `#FF00FF`; this machine's display is Display P3, and a
 * capture comes back in the display's colour space. sRGB magenta lands near
 * (234, 51, 239) there — 51 away from zero on green, which a tight per-channel
 * tolerance rejects. The first run of this check reported 0.0% inside the *control*
 * window, which is exactly what the control exists to catch.
 *
 * So the test is the shape of the colour rather than its coordinates: strongly red
 * and blue, weakly green. Nothing in the Pressroom palette is — paper is neutral
 * (r≈g≈b), vermilion and ochre have low blue, pine has low red — so a false positive
 * would need something magenta already on screen inside a 420×92 rectangle we placed.
 */
export function isMarker(r: number, g: number, b: number): boolean {
  return r > 150 && b > 150 && g < 130 && r - g > 70 && b - g > 70;
}

/**
 * Paint a window a flat marker colour without changing which window it is.
 *
 * `insertCSS` rather than loading a different page: the window under test has to
 * remain the real HUD, created through the real registry with the real role, or the
 * flag being checked is not the flag that ships.
 */
export async function paintMarker(window: BrowserWindow): Promise<void> {
  const hex = `#${MARKER.r.toString(16).padStart(2, '0')}${MARKER.g
    .toString(16)
    .padStart(2, '0')}${MARKER.b.toString(16).padStart(2, '0')}`;
  await window.webContents.insertCSS(
    `html, body { background: ${hex} !important; } body * { visibility: hidden !important; }`,
  );
}

export async function captureDisplay(display: Electron.Display): Promise<NativeImage | null> {
  const sources = await desktopCapturer
    .getSources({
      types: ['screen'],
      fetchWindowIcons: false,
      // Ask for the display's own DIP size so one thumbnail pixel is one DIP and the
      // window rectangles map across without a scale guess.
      thumbnailSize: { width: display.bounds.width, height: display.bounds.height },
    })
    .catch(() => []);
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0] ?? null;
  if (source === null) return null;
  const image = source.thumbnail;
  return image.isEmpty() ? null : image;
}

/**
 * How much of `rect` is the marker, plus the mean colour actually found there.
 *
 * The mean is reported even on a pass. When this check blocks, "the control rect
 * averaged (244, 240, 228)" says *paper* — the window never painted — while
 * "(20, 18, 12)" says the capture was black, and those are different problems with
 * different fixes. A bare percentage would leave whoever runs this guessing.
 */
export function markerFraction(
  image: NativeImage,
  display: Electron.Display,
  rect: { x: number; y: number; width: number; height: number },
): { fraction: number; mean: [number, number, number]; sampled: number } {
  const size = image.getSize();
  const bitmap = image.toBitmap(); // BGRA, row-major, no padding.
  const scaleX = size.width / display.bounds.width;
  const scaleY = size.height / display.bounds.height;

  const x0 = Math.max(0, Math.round((rect.x - display.bounds.x) * scaleX));
  const y0 = Math.max(0, Math.round((rect.y - display.bounds.y) * scaleY));
  const x1 = Math.min(size.width, Math.round((rect.x - display.bounds.x + rect.width) * scaleX));
  const y1 = Math.min(size.height, Math.round((rect.y - display.bounds.y + rect.height) * scaleY));
  if (x1 <= x0 || y1 <= y0) return { fraction: 0, mean: [0, 0, 0], sampled: 0 };

  let hits = 0;
  let total = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size.width + x) * 4;
      const b = bitmap[i] ?? 0;
      const g = bitmap[i + 1] ?? 0;
      const r = bitmap[i + 2] ?? 0;
      total++;
      sr += r;
      sg += g;
      sb += b;
      if (isMarker(r, g, b)) hits++;
    }
  }
  if (total === 0) return { fraction: 0, mean: [0, 0, 0], sampled: 0 };
  return {
    fraction: hits / total,
    mean: [Math.round(sr / total), Math.round(sg / total), Math.round(sb / total)],
    sampled: total,
  };
}
