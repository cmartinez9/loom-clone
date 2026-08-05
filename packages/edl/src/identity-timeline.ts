/**
 * A compiled timeline for "the recording as captured, with no edits".
 *
 * Not a special case in the model — it is `compile()` of an empty document over one
 * clip — and that is the point. The preview loop, the phase-6 gate harness and any
 * caller that has a duration but not yet a project all get a real
 * `CompiledTimeline` and call the real `resolve`, so there is no second code path
 * that could behave differently from the one the exporter uses (§4.5).
 */

import { newEditDocument, type Seconds } from '@loom/format';
import { compile, type CompiledTimeline } from './compile.ts';

export function identityTimeline(durationSec: Seconds): CompiledTimeline {
  const doc = newEditDocument();
  doc.clips = [
    { id: 'whole-source', sourceStart: 0, sourceEnd: Math.max(0, durationSec), speed: 1 },
  ];
  return compile(doc);
}
