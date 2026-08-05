/**
 * Screen-only preview: the consumer that wires `@loom/decode` to `@loom/compositor`.
 *
 * Architecture report §8, phase 6. The editor window that hosts this arrives with
 * phase 7; until then its only caller is the phase-6 gate harness, which is the
 * point — the gate exercises the shipping loop, not a copy of it.
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
