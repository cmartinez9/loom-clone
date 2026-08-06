/**
 * Screen-only preview: the consumer that wires `@loom/decode` and `@loom/edl` to
 * `@loom/compositor`.
 *
 * Architecture report §8, phase 6. Phase 7 landed the timeline model the loop now
 * resolves through, and phase 14 built the window that hosts it:
 * `apps/renderer/src/editor/preview-host.ts` is the shipping caller. The phase-6 gate
 * harness is the other one, and drives this same loop rather than a copy of it.
 */

export { FRAME_BUDGET_MS, FrameMetrics } from './frame-metrics.ts';
export {
  PreviewLoop,
  rafScheduler,
  STALL_TIMEOUT_MS,
  type FrameScheduler,
  type PreviewCompositor,
  type PreviewLoopOptions,
  type PreviewSource,
} from './preview-loop.ts';
