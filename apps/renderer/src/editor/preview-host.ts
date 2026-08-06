/**
 * The preview, hosted in a window at last.
 *
 * `apps/renderer/src/preview/` has had the loop since phase 6 and no window to live
 * in — its own `index.ts` said so: *"the editor window that hosts it is still ahead:
 * until then its only caller is the phase-6 gate harness."* This is that host, and
 * it is deliberately thin. It owns a canvas, a GL context, a `Compositor` and a
 * `PreviewLoop`, and it adds no rendering of its own, because §4.5 puts preview and
 * export on the must-be-identical list and a preview-only draw call is the one thing
 * that cannot be true of both.
 *
 * ## The composite is rendered at the output size, not the window size
 *
 * `canvas.width`/`height` are `edit.output.size` (§2.6) and CSS scales the element
 * to whatever room the window has. So resizing the window costs a scale in the
 * browser's compositor and changes nothing about what is drawn — which is the point:
 * the picture a person is judging is the picture the exporter will encode, at the
 * resolution it will encode it, and it does not change because they dragged a
 * corner. It also means the frame budget does not move with the window.
 *
 * ## There is no audio
 *
 * Deliberately, and it is a decision rather than an omission. §5.4 mechanism 4
 * requires playback time to come from the audio output's played-sample count and
 * **never** from `requestAnimationFrame` accumulation — which is exactly what
 * `PreviewLoop` does today. Playing audio against that clock would let the sound and
 * the scrub bar walk apart at the device's own error, 90 ms over thirty minutes at
 * §5.5's 50 ppm, so adding sound means implementing mechanism 4 first.
 * `packages/format/src/sync/align.ts` now records where that work belongs.
 */

import { Compositor } from '@loom/compositor';
import type { CompiledTimeline } from '@loom/edl';
import { PreviewLoop } from '../preview/index.ts';
import type { ScreenSource } from './screen-source.ts';

export interface PreviewHostOptions {
  canvas: HTMLCanvasElement;
  screen: ScreenSource;
  timeline: CompiledTimeline;
  /** `edit.output.size` — what the exporter will encode (§2.6). */
  outputSize: readonly [number, number];
  /**
   * Reported once per run of a condition, already phrased for a person.
   *
   * `PreviewLoop` latches its own reports, so this is not called sixty times a
   * second for one persistent fault.
   */
  onTrouble: (message: string) => void;
}

export class PreviewHost {
  readonly loop: PreviewLoop;

  readonly #compositor: Compositor;
  readonly #screen: ScreenSource;

  constructor(options: PreviewHostOptions) {
    const { canvas, outputSize } = options;
    canvas.width = Math.max(1, Math.round(outputSize[0]));
    canvas.height = Math.max(1, Math.round(outputSize[1]));

    // The same context attributes the phase-6 gate harness asks for, for the same
    // reasons: no alpha to composite against the page, no depth or stencil to
    // allocate, and `preserveDrawingBuffer: false` because keeping the drawing
    // buffer around costs a full-frame copy per present and nothing here reads it.
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (gl === null) {
      throw new Error('this machine has no WebGL2 context, so the preview cannot draw');
    }
    // A lost context is silent — every call becomes a no-op and `getParameter`
    // answers `null` — so the one thing to do about it is say so. Nothing here can
    // restore it: the program, the textures and the render target all went with it.
    canvas.addEventListener('webglcontextlost', () => {
      options.onTrouble('The graphics context was lost. Close and reopen this editor.');
    });

    this.#compositor = new Compositor(gl, [canvas.width, canvas.height]);
    this.#screen = options.screen;
    this.loop = new PreviewLoop({
      compositor: this.#compositor,
      screen: options.screen,
      durationSec: options.timeline.durationSec,
      timeline: options.timeline,
      onError: (error) => {
        options.onTrouble(error.message);
      },
      onStall: (info) => {
        options.onTrouble(
          `The picture stopped at ${info.timelineSec.toFixed(2)}s — the recording says there is ` +
            `a frame at ${info.atSec.toFixed(2)}s of the source and it has not arrived for ` +
            `${(info.forMs / 1000).toFixed(0)}s.`,
        );
      },
    });
  }

  /**
   * Swap in a recompiled timeline — a trim, or anything else that changed the
   * document (§3.6's *"`compile` on load and on any op that changes a spring
   * channel, debounced 100 ms"*).
   *
   * The playhead is kept where it was in *timeline* time and clamped by the loop,
   * which is what a person means by trimming: the picture under the playhead may
   * change, but the playhead does not jump because a handle moved somewhere else.
   */
  set timeline(value: CompiledTimeline) {
    this.loop.timeline = value;
  }

  get timeline(): CompiledTimeline {
    return this.loop.timeline;
  }

  start(): void {
    this.loop.start();
  }

  /** Stop rendering and let go of every decoded frame. */
  dispose(): void {
    this.loop.stop();
    this.#screen.close();
    this.#compositor.dispose();
  }

  /**
   * The composited pixels, RGBA8, top row first, at the output size.
   *
   * Present because a gate has to be able to prove the preview draws a *picture* —
   * `test/editor-gate.test.ts` compares the pixels under the playhead before and
   * after a trim, which is the only assertion that can tell "the trim moved the
   * picture" apart from "the playhead moved and the picture did not". A frame
   * counter cannot: it counts just as happily when every frame is the same stale
   * one. This reads the compositor's own render target, so what it returns is what
   * `present()` blitted, not a second rendering of anything.
   */
  readPixels(): Uint8Array {
    return this.#compositor.readPixels();
  }
}
