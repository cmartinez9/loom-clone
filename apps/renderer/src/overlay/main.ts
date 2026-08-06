/**
 * The live drawing overlay's page. Phase 12.
 *
 * A full-display transparent canvas, a palette, and the pen. Three obligations,
 * from §8's gate and this phase's constraints, and each one shapes the code below:
 *
 * 1. **Strokes appear live.** The canvas is redrawn as the pointer moves — this
 *    window is what the presenter is looking at, so the ink has to be here before
 *    it is anywhere else. Nothing waits on main.
 * 2. **They are absent from the raw capture.** Not this file's doing:
 *    `setContentProtection(true)` on the role in `apps/main/src/windows.ts` is,
 *    and `test/phase12-overlay.test.ts` measures it in captured pixels.
 * 3. **They are deletable in the editor.** Also not this file's doing — a stroke
 *    becomes a span on one generated track (`packages/edl/src/drawing.ts`), which
 *    an ordinary `track.remove` deletes. What *is* this file's doing is that the
 *    log it writes is complete enough to rebuild what was on screen: an `erase`
 *    and a `clear` are logged as events rather than applied by silence, because
 *    "this stroke was rubbed out at 0:40" and "this stroke was never drawn" are
 *    different recordings.
 *
 * ## It must not swallow the user's clicks
 *
 * The window covers the display being recorded, and main creates it ignoring mouse
 * events with `{ forward: true }` — so *moves* arrive here even while clicks fall
 * through to the app underneath. That forwarding is the whole mechanism: this page
 * watches where the pointer is, and asks main to arm the window only while it is
 * over the palette. Once the user picks up a pen the window stays armed until they
 * put it down, because a pen that disarmed itself between strokes would be a pen
 * that dropped every second line.
 *
 * ## Nothing here may fail the recording
 *
 * Every message to main is fire-and-forget, and every handler is defensive. The
 * overlay is an accessory (see `apps/main/src/overlay.ts`); the worst thing that
 * happens if this page throws is that the user loses their pen.
 */

import '@loom/design/css';
import './overlay.css';
import type { DrawingTool, OverlayStatus } from '@loom/ipc';

const loom = window.loom;

const canvas = must('ink') as HTMLCanvasElement;
const palette = must('palette');
const penButton = must('pen') as HTMLButtonElement;
const highlighterButton = must('highlighter') as HTMLButtonElement;
const undoButton = must('undo') as HTMLButtonElement;
const clearButton = must('clear') as HTMLButtonElement;
const closeButton = must('close') as HTMLButtonElement;

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`overlay.html is missing #${id}`);
  return element;
}

/**
 * The two pens, as the numbers they draw with.
 *
 * `width` is an isotropic fraction of the display **width**, which is phase 11's
 * `strokeWidth` convention and what the importer writes straight through — so what
 * the presenter sees here and what the editor composites are the same thickness
 * relative to the same frame.
 *
 * The colours are Pressroom's: vermilion is the brand and the accent, ochre is what
 * the language reserves for a marker. Both are read out of the design tokens rather
 * than written twice, so a palette change moves the ink with it.
 */
interface Pen {
  tool: DrawingTool;
  width: number;
  cssVar: string;
  /** What the live canvas paints with; the editor re-derives it from `color`. */
  alpha: number;
}

const PENS: Record<DrawingTool, Pen> = {
  pen: { tool: 'pen', width: 0.004, cssVar: '--accent', alpha: 1 },
  // Wide and translucent, which is what makes a marker a marker: the words under
  // it stay readable. `packages/edl/src/drawing.ts` puts the same 0.35 into the
  // span's colour so the editor draws the same ink.
  highlighter: { tool: 'highlighter', width: 0.022, cssVar: '--audio', alpha: 0.35 },
};

/**
 * A stroke, while it is being drawn and after.
 *
 * `points` are normalized 0–1 against this window, which covers the display — §2.5's
 * convention for `cursor.ndjson`, and the space the importer expects.
 */
interface Stroke {
  id: string;
  tool: DrawingTool;
  color: string;
  width: number;
  alpha: number;
  points: number[];
  /** `performance.now()` at the pen going down and coming up. */
  startedMs: number;
  endedMs: number;
}

/**
 * Points closer than this — as a fraction of the display width — are the same
 * point as far as the ink is concerned.
 *
 * A pointer at 120 Hz over a 3456-wide display emits a sample every few pixels even
 * when the hand is still, and every one of those would be a segment in the document
 * and a quad in the compositor. Dropping them costs nothing visible and is the
 * difference between a stroke of two hundred points and a stroke of two thousand.
 */
const MIN_POINT_SPACING = 0.0015;

/**
 * How far a point may sit from the line between its neighbours before it is a
 * corner rather than a wobble. Douglas–Peucker's ε, in the same units.
 *
 * Applied once, when the pen comes up, so the live drawing keeps every sample the
 * hand produced and only what is *written down* is simplified. A stroke that
 * changed shape at the moment you lifted the pen would be unnerving; at this ε it
 * does not move by a pixel at 4K.
 */
const SIMPLIFY_EPSILON = 0.0006;

/** The most points one written stroke may carry. Matches `@loom/edl`'s bound. */
const MAX_STROKE_POINTS = 4096;

let pen: Pen = PENS.pen;
let armed = false;
/** Strokes still on screen, oldest first. An erase or a clear removes them here. */
let strokes: Stroke[] = [];
let live: Stroke | null = null;
let strokeSeq = 0;

// ---------------------------------------------------------------- the canvas

const context = canvas.getContext('2d');

/**
 * Size the backing store to device pixels and the element to CSS pixels.
 *
 * Not a nicety on this window: the ink is the only thing on it, so a canvas at CSS
 * resolution would put a visibly soft line over a sharp desktop.
 */
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  redraw();
}

/** Redraw everything on screen. Called on every pointer move while drawing. */
function redraw(): void {
  if (context === null) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of strokes) paint(context, stroke);
  if (live !== null) paint(context, live);
}

function paint(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const count = stroke.points.length >> 1;
  if (count < 1) return;
  const widthPx = stroke.width * canvas.width;
  ctx.save();
  ctx.globalAlpha = stroke.alpha;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = Math.max(1, widthPx);
  // Round joins and caps, because the compositor draws the same polyline as a
  // chain of round-capped capsules. Two renderers of one stroke is one more than
  // ideal — §4.5's rule is about preview and export, and this is neither — but a
  // live pen has to be here, so the least that can be done is that they agree on
  // the shape of a line.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (count === 1) {
    ctx.beginPath();
    ctx.arc(
      (stroke.points[0] ?? 0) * canvas.width,
      (stroke.points[1] ?? 0) * canvas.height,
      Math.max(0.5, widthPx / 2),
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo((stroke.points[0] ?? 0) * canvas.width, (stroke.points[1] ?? 0) * canvas.height);
  for (let i = 1; i < count; i++) {
    ctx.lineTo(
      (stroke.points[i * 2] ?? 0) * canvas.width,
      (stroke.points[i * 2 + 1] ?? 0) * canvas.height,
    );
  }
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------------- the pen

canvas.addEventListener('pointerdown', (event: PointerEvent) => {
  if (!armed) return;
  canvas.setPointerCapture(event.pointerId);
  strokeSeq += 1;
  live = {
    id: `s${String(strokeSeq)}_${String(Math.round(performance.now()))}`,
    tool: pen.tool,
    color: inkColor(pen),
    width: pen.width,
    alpha: pen.alpha,
    points: [normX(event.clientX), normY(event.clientY)],
    startedMs: performance.now(),
    endedMs: performance.now(),
  };
  redraw();
});

canvas.addEventListener('pointermove', (event: PointerEvent) => {
  const stroke = live;
  if (stroke === null) return;
  const x = normX(event.clientX);
  const y = normY(event.clientY);
  const n = stroke.points.length;
  const lastX = stroke.points[n - 2] ?? 0;
  const lastY = stroke.points[n - 1] ?? 0;
  if (Math.hypot(x - lastX, y - lastY) < MIN_POINT_SPACING) return;
  stroke.points.push(x, y);
  redraw();
});

for (const type of ['pointerup', 'pointercancel'] as const) {
  canvas.addEventListener(type, () => {
    finishStroke();
  });
}

/**
 * The pen comes up: keep the stroke on screen, and write it down.
 *
 * The written form is simplified and the on-screen form is not — see
 * {@link SIMPLIFY_EPSILON}. The stroke stays in `strokes` either way, so what the
 * presenter sees does not change under them at the moment they lift the pen.
 */
function finishStroke(): void {
  const stroke = live;
  live = null;
  if (stroke === null) return;
  stroke.endedMs = performance.now();
  strokes.push(stroke);
  redraw();

  const points = simplify(stroke.points, SIMPLIFY_EPSILON).slice(0, MAX_STROKE_POINTS * 2);
  const now = performance.now();
  loom.overlay.stroke({
    id: stroke.id,
    startedMsAgo: Math.max(0, now - stroke.startedMs),
    endedMsAgo: Math.max(0, now - stroke.endedMs),
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    points,
  });
}

/**
 * Douglas–Peucker, on a flat `[x0, y0, x1, y1, …]` array.
 *
 * Iterative rather than recursive: a stroke is user input, a pathological one has
 * thousands of points, and a stack overflow in the pen would be a stack overflow
 * during a recording. The endpoints are always kept, so a simplified stroke starts
 * and ends exactly where the hand did.
 */
function simplify(points: readonly number[], epsilon: number): number[] {
  const count = points.length >> 1;
  if (count < 3) return [...points];
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: [number, number][] = [[0, count - 1]];

  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) break;
    const [first, last] = span;
    if (last - first < 2) continue;
    const ax = points[first * 2] ?? 0;
    const ay = points[first * 2 + 1] ?? 0;
    const bx = points[last * 2] ?? 0;
    const by = points[last * 2 + 1] ?? 0;
    let worst = -1;
    let worstAt = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointSegmentDistance(points[i * 2] ?? 0, points[i * 2 + 1] ?? 0, ax, ay, bx, by);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worst > epsilon && worstAt > 0) {
      keep[worstAt] = 1;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (keep[i] === 1) out.push(points[i * 2] ?? 0, points[i * 2 + 1] ?? 0);
  }
  return out;
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function normX(clientX: number): number {
  return window.innerWidth > 0 ? clientX / window.innerWidth : 0;
}

function normY(clientY: number): number {
  return window.innerHeight > 0 ? clientY / window.innerHeight : 0;
}

/**
 * The pen's colour, as `#rrggbb`.
 *
 * Read out of the design tokens rather than written here, so the ink and the
 * palette's swatch cannot drift. A token that resolves to something other than a
 * six-digit hex — a theme that has not loaded yet — falls back to the accent's own
 * value rather than sending main a string it cannot store.
 */
function inkColor(which: Pen): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(which.cssVar).trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : '#DC3F12';
}

// --------------------------------------------------------------- the palette

/**
 * Arm while the pointer is over the palette, so the buttons are reachable.
 *
 * This is the one thing that makes a click-through window usable on its own. Main
 * forwards mouse *moves* into the window while it is ignoring clicks, so the
 * pointer arriving here is observable even though a click at the same spot would
 * have gone to the app underneath.
 */
palette.addEventListener('pointerenter', () => {
  setArmed(true);
});

palette.addEventListener('pointerleave', () => {
  // Leaving the palette disarms only when no pen is selected. Once the user has
  // picked one up the window stays armed, because a pen that let go between
  // strokes would drop every second line.
  if (!penSelected) setArmed(false);
});

let penSelected = false;

penButton.addEventListener('click', () => {
  selectPen('pen');
});
highlighterButton.addEventListener('click', () => {
  selectPen('highlighter');
});

function selectPen(tool: DrawingTool): void {
  // A second click on the pen already in hand puts it down — which is how the user
  // gets their clicks back without closing the overlay and losing what is on it.
  if (penSelected && pen.tool === tool) {
    penSelected = false;
    setArmed(false);
  } else {
    pen = PENS[tool];
    penSelected = true;
    setArmed(true);
  }
  penButton.setAttribute('aria-pressed', String(penSelected && pen.tool === 'pen'));
  highlighterButton.setAttribute('aria-pressed', String(penSelected && pen.tool === 'highlighter'));
}

undoButton.addEventListener('click', () => {
  const removed = strokes.pop();
  if (removed === undefined) return;
  redraw();
  loom.overlay.erase({ ids: [removed.id], atMsAgo: 0 });
});

clearButton.addEventListener('click', () => {
  if (strokes.length === 0) return;
  strokes = [];
  live = null;
  redraw();
  loom.overlay.clear({ atMsAgo: 0 });
});

closeButton.addEventListener('click', () => {
  loom.overlay.setOpen(false);
});

function setArmed(next: boolean): void {
  if (armed === next) return;
  armed = next;
  document.body.classList.toggle('armed', armed);
  loom.overlay.setArmed(armed);
}

// ------------------------------------------------------------------ lifecycle

/**
 * Main's own view of the overlay, echoed back.
 *
 * The page trusts it over its own: main is what actually calls
 * `setIgnoreMouseEvents`, so if the two ever disagree the window's behaviour is
 * main's answer and this one is a stale belief.
 */
loom.overlay.onStatus((status: OverlayStatus) => {
  if (status.armed === armed) return;
  armed = status.armed;
  document.body.classList.toggle('armed', armed);
  if (!armed) penSelected = false;
});

window.addEventListener('resize', resize);
resize();

/**
 * Exposed for `test/phase12-overlay.test.ts`, which drives this page with real
 * pointer events and reads the canvas back.
 *
 * A gate that reached into module scope would be a gate that pins the shape of the
 * module; a gate that reimplemented the pen would measure its own pen. This is the
 * narrow middle: the counts and the pixels, and nothing that could draw.
 */
Object.defineProperty(window, '__loomOverlayProbe', {
  value: {
    strokeCount: (): number => strokes.length,
    armed: (): boolean => armed,
    selectPen,
    setArmed,
    canvas: (): HTMLCanvasElement => canvas,
  },
});
