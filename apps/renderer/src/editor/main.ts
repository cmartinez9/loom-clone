/**
 * The editor window.
 *
 * ## The framework decision, taken here because it was left here
 *
 * `apps/renderer/src/library/main.ts` deferred it in writing — *"picking a UI
 * framework for the editor is a decision phase 6/7 gets to make with the compositor
 * in front of them"* — and phases 6 and 7 both shipped without taking it. The answer
 * is **vanilla TypeScript against the Pressroom design system**, like the other four
 * windows, and the reasons are not only consistency:
 *
 *  - The two things this window does sixty times a second — composite a frame, move
 *    a playhead — are a WebGL draw and one style write. (`paintPlayhead` writes the
 *    timecode and the transport glyph as well, and does so only when they change,
 *    which is the whole of what a reconciler would have bought here.) Neither is a
 *    rendering a virtual DOM can help with, and the design language's own rule is
 *    that nothing on the input path animates or defers (`--t-instant`). A reconciler
 *    between a pointer and a playhead is latency spent for nothing.
 *  - §4.3's first anti-stutter rule is that nothing allocates in the loop. Every
 *    framework's answer to state is allocation.
 *  - The preview loop, the compositor and the timeline model are already the hard
 *    parts and are already framework-free by §1.3. What is left here is a few
 *    hundred lines of DOM.
 *
 * **Phase 15 inherited the choice and kept it.** The controls it added — the tool
 * rail, the direct-manipulation layer over the picture, and three inspector panels —
 * are rebuilt on a *document* change and a *selection* change, which is a person's
 * rate rather than a frame's, and none of them reads another control's value. The
 * two sixty-times-a-second things are still a WebGL draw and one style write. If it
 * ever stops paying, that is a decision to re-take with the reasoning written down,
 * not a thing to drift into.
 *
 * ## What this window does not do
 *
 * No audio: §5.4 mechanism 4 requires playback time to come from the audio output's
 * played-sample count and `PreviewLoop` accumulates `requestAnimationFrame` deltas,
 * so sound would drift against the scrub bar by design. `align.ts` records where
 * that work belongs.
 *
 * No **track stacking or blending UI**, and that is the captain's own carve-out:
 * `data/loom-scope/decision-editor-scope.md`, on the *Stack and blend tracks* row —
 * *"I don't think this is needed for MVP."* §3.5's engine is untouched and is what
 * makes the manual zoom beat the generated one; what is absent is a surface for
 * reordering tracks by hand. Every track this window writes therefore goes where
 * §3.5 says it goes without anyone being asked, and each site argues its own: a
 * manual zoom to the top of the array (`rewriteTrackOps`), a generated one below
 * every manual track and above every generator §3.5 ranks under it
 * (`generators.ts`'s `GENERATOR_RANK`).
 */

import '@loom/design/css';
import './editor.css';
import { formatBytes, formatTimecode, formatTimecodeCentis, icon } from '@loom/design';
import { compileClips, resolve, timelineTimeAt, type CompiledClips } from '@loom/edl';
import { recordingUrl, SUBJECT_PARAM, type EditOp, type OpenedProject } from '@loom/ipc';
import { applyOps } from '@loom/format';
import type { Seconds, Track, Vec2, VideoTrackDoc } from '@loom/format';
import { EditorProject } from './project.ts';
import { PreviewHost } from './preview-host.ts';
import { loadGlyphRaster } from '../glyphs.ts';
import { openVideoTrack } from '../media/track-reader.ts';
import { TimelineUi } from './timeline.ts';
import { clampZoom, zoomAbout, type TimelineView } from './timeline-geometry.ts';
import { readTrim, trimOp, type Trim } from './trim.ts';
import {
  annotationsOf,
  annotationAt,
  moveAnnotationOps,
  placeAnnotationOps,
  removeAnnotationOps,
  retimeAnnotationOps,
  styleAnnotationOps,
  DEFAULT_SPAN_SEC,
  type AnnotationView,
} from './annotate.ts';
import {
  generatorStates,
  readEventLogs,
  runGenerator,
  bakeOps,
  fetchText,
  sha256,
  GENERATOR_TRACK_ID,
  type EventLogs,
  type RunnableGenerator,
} from './generators.ts';
import { Inspector } from './inspector.ts';
import { StageUi } from './stage.ts';
import {
  buildRail,
  sameSelection,
  setPressedTool,
  toolSpec,
  type Selection,
  type ToolId,
} from './tools.ts';
import {
  generatedSegmentAt,
  moveKeyOps,
  overrideZoomOps,
  placeZoomOps,
  removeKeyOps,
  removeZoomOps,
  setKeyValueOps,
  updateZoomOps,
  zoomKeysOf,
  zoomRegionAt,
  zoomRegionsOf,
  DEFAULT_HOLD_SEC,
  DEFAULT_ZOOM_AMOUNT,
  ZOOM_RAMP_SEC,
  type ZoomRegion,
} from './zoom.ts';

const loom = window.loom;

/** An element the page is required to contain; a missing one is a broken build. */
function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`editor.html is missing #${id}`);
  return element;
}

const el = {
  top: must('top'),
  name: must('name'),
  meta: must('meta'),
  undo: must('undo') as HTMLButtonElement,
  redo: must('redo') as HTMLButtonElement,
  saveState: must('save-state'),
  refusal: must('refusal'),
  refusalIcon: must('refusal-icon'),
  refusalTitle: must('refusal-title'),
  refusalDetail: must('refusal-detail'),
  body: must('body'),
  rail: must('rail'),
  mat: must('mat'),
  film: must('film'),
  preview: must('preview') as HTMLCanvasElement,
  ovl: must('ovl'),
  inspSel: must('insp-sel'),
  zoomPanel: must('zoom-panel'),
  genPanel: must('gen-panel'),
  restart: must('restart') as HTMLButtonElement,
  playpause: must('playpause') as HTMLButtonElement,
  tcode: must('tcode'),
  facts: must('facts'),
  trimFacts: must('trim-facts'),
  inspNote: must('insp-note'),
  trouble: must('trouble'),
  tl: must('tl'),
  tlTc: must('tl-tc'),
  tlHint: must('tl-hint'),
  tlZoom: must('tl-zoom'),
  zoomIn: must('zoom-in'),
  zoomOut: must('zoom-out'),
  zoomFit: must('zoom-fit'),
  heads: must('heads'),
  lanes: must('lanes'),
  ruler: must('ruler'),
  laneStack: must('lane-stack'),
  shadeHead: must('shade-head'),
  shadeTail: must('shade-tail'),
  handleStart: must('handle-start'),
  handleEnd: must('handle-end'),
  playhead: must('playhead'),
};

// ---------------------------------------------------------------- chrome

function paintIcons(): void {
  const set = (element: HTMLElement, name: Parameters<typeof icon>[0], size: number): void => {
    element.innerHTML = icon(name, size);
  };
  set(el.undo, 'undo', 16);
  set(el.redo, 'redo', 16);
  set(el.restart, 'restart', 15);
  set(el.playpause, 'play', 15);
  set(el.zoomIn, 'plus', 14);
  set(el.zoomOut, 'minus', 14);
  el.refusalIcon.innerHTML = icon('alert', 22);
}

function refuse(title: string, detail: string): void {
  el.refusalTitle.textContent = title;
  el.refusalDetail.textContent = detail;
  el.refusal.hidden = false;
  el.body.hidden = true;
  el.tl.hidden = true;
}

/**
 * One line of trouble, latched by the thing that raised it rather than here.
 *
 * `PreviewLoop` reports the first frame of a run of a condition and not the next
 * sixty; `EditorProject` reports one failed write. So this replaces rather than
 * accumulates: the newest thing that went wrong is the one worth reading.
 */
function trouble(message: string): void {
  el.trouble.replaceChildren();
  const slot = document.createElement('span');
  slot.className = 'ic-slot';
  slot.innerHTML = icon('alert', 15);
  const text = document.createElement('span');
  text.textContent = message;
  el.trouble.append(slot, text);
  el.trouble.hidden = false;
}

function facts(container: HTMLElement, entries: readonly (readonly [string, string])[]): void {
  container.replaceChildren(
    ...entries.map(([term, value]) => {
      const group = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      group.append(dt, dd);
      return group;
    }),
  );
}

/**
 * What the generator panel reads before the logs have arrived.
 *
 * Not "no logs": `EventLogs.cursor` and `.clicks` are `null` here for the same reason
 * they are `null` for a recording that has none, and the panel says so — the
 * *difference* is `trouble`, which is `null` while a read is outstanding and a
 * sentence once one has failed. Phase 5 exists to keep "absent" and "empty" apart and
 * this is the same discipline one state further out.
 */
const EMPTY_LOGS: EventLogs = { cursor: null, clicks: null, digests: {}, trouble: null };

// ---------------------------------------------------------------- the editor

async function start(): Promise<void> {
  paintIcons();

  const id = new URLSearchParams(window.location.search).get(SUBJECT_PARAM);
  if (id === null || id === '') {
    refuse(
      'No recording was named.',
      'This window is opened from the library, which tells it which recording to show.',
    );
    return;
  }

  let opened: OpenedProject;
  try {
    opened = await loom.project.open(id);
  } catch (error) {
    refuse(
      'This recording could not be opened.',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  // §2.2's `exported` means the sources were deleted after a verified export
  // (captain decision 5). There is nothing behind an editor window onto one, and
  // finding that out by watching the preview fail to decode is the wrong way round.
  if (opened.project?.state === 'exported') {
    refuse(
      'This recording is final.',
      'Its sources were deleted after the export was verified, so there is nothing left ' +
        'to edit. The exported file is still where it was saved.',
    );
    return;
  }

  const { recording } = opened;
  if (recording === null) {
    refuse(
      'This recording has nothing to edit yet.',
      'Its recording.json is missing, which means capture never got far enough to write ' +
        'one, or the bundle still needs repairing. The library shows its state.',
    );
    return;
  }
  const screen: VideoTrackDoc | undefined = recording.tracks.screen;
  const parts = (screen?.parts ?? []).filter((part) => part.frameCount > 0);
  if (parts.length === 0) {
    refuse(
      'This recording has no picture.',
      'recording.json declares no screen part with any frames in it, so there is nothing ' +
        'to composite. The audio, if there is any, is still in the bundle.',
    );
    return;
  }

  const name = opened.project?.name ?? id;
  document.title = name;
  el.name.textContent = name;

  /**
   * The captured frame's size in pixels, from the part the encoder actually produced.
   *
   * Needed by `outputToSource`: the source is contain-fitted into the output, so the
   * letterbox — the region a pointer has no source coordinate in — is a function of
   * both aspect ratios. Read from `recording.json` rather than from `edit.output.size`
   * for the reason the inspector shows the two separately: nothing sets `output.size`
   * from the recording today, so on this machine they routinely differ.
   */
  const sourceSize: readonly [number, number] = parts[0]?.size ?? [1920, 1080];

  // ---- the project, and the two derived things that follow the document -----
  const project = new EditorProject({
    id,
    recording,
    edit: opened.edit,
    api: loom.project,
    onChange: () => {
      onDocumentChanged();
    },
    onTrouble: trouble,
  });

  /**
   * The clip list, compiled — the **only** map between source and timeline time
   * (§3.1). Built with `compileClips`, the same function `compile` calls, rather
   * than read off `CompiledTimeline.clips`, which is `@internal`, or written out
   * here, which would be a second implementation of the one mapping.
   */
  let clips: CompiledClips = compileClips(project.document.clips, project.sourceDurationSec);
  let trim: Trim = readTrim(project.document, project.sourceDurationSec);

  // ---- the source, the preview -----------------------------------------------
  let host: PreviewHost;
  try {
    // `openVideoTrack` from `../media/` — the same adapter the exporter opens a
    // track with, deliberately rather than one of the editor's own. §4.5 puts
    // *"which source frame is selected for a given time"* on the list preview and
    // export may never disagree about, and two implementations of that selection is
    // that guarantee with a second answer beside it waiting to drift.
    //
    // The media URL comes from main, which proves the file is inside the bundle
    // before handing one over (`ipc.ts`); the sidecar's path comes from
    // `recording.json`'s own `VideoPart.index` (§2.3), because the document is what
    // says where a part's index actually is. `recordingUrl` escapes each segment.
    const source = await openVideoTrack({
      parts: await Promise.all(
        parts.map(async (part, partIndex) => ({
          mediaUrl: await loom.project.mediaUrl(id, 'screen', partIndex),
          indexUrl: recordingUrl(id, part.index),
          startTimeSec: part.startTimeSec,
          durationSec: part.durationSec,
        })),
      ),
    });
    host = new PreviewHost({
      canvas: el.preview,
      screen: source,
      timeline: project.compiled,
      outputSize: project.document.output.size,
      onTrouble: trouble,
      // Awaited **before** the loop is built, because `PreviewLoop` takes its atlas
      // at construction and a `text` span rendered without one is skipped and
      // counted. `../glyphs.ts` is the one place a raster is made, so the export
      // window's is the same one made the same way (§4.5).
      glyphs: await loadGlyphRaster(),
    });
  } catch (error) {
    refuse(
      'The picture could not be decoded.',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  el.refusal.hidden = true;
  el.body.hidden = false;
  el.tl.hidden = false;

  // ---- the timeline ----------------------------------------------------------
  let view: TimelineView = {
    durationSec: project.sourceDurationSec,
    zoom: 1,
    scrollSec: 0,
    widthPx: 0,
  };

  const timeline = new TimelineUi(
    {
      heads: el.heads,
      lanes: el.lanes,
      ruler: el.ruler,
      laneStack: el.laneStack,
      shadeHead: el.shadeHead,
      shadeTail: el.shadeTail,
      handleStart: el.handleStart,
      handleEnd: el.handleEnd,
      playhead: el.playhead,
    },
    {
      onScrub: (sourceSec, phase) => {
        host.loop.seek(timelineTimeFor(sourceSec), { scrubbing: phase === 'move' });
        paintPlayhead();
      },
      onTrimPreview: (next) => {
        trim = next;
        // The document the *preview* resolves against, not an edit: it never
        // reaches the history and never reaches main. `EditorProject.preview`
        // recompiles on §3.6's debounce; the handle is redrawn now.
        const op = trimOp(project.committed, next);
        if (op !== null && op.op === 'clips.set') {
          project.preview({ ...project.committed, clips: op.clips });
        }
        renderTimeline();
      },
      onTrimCommit: (next) => {
        trim = next;
        const op = trimOp(project.committed, next);
        if (op === null) {
          project.cancelPreview();
          renderTimeline();
          return;
        }
        project.commit([op], 'Trim');
      },
      onViewChange: (next) => {
        view = { ...next, zoom: clampZoom(next, next.zoom) };
        renderTimeline();
      },
      onSelect: (next) => {
        select(next);
      },
      onMoveKey: (key, toSec, phase) => {
        // A key drag is one undo step, like a trim drag: provisional while the
        // pointer is down and committed once. `moveKeyOps` clamps into the gap
        // between the key's neighbours, so a drag past one stops rather than
        // replacing it — `setKey` upserts by `t`, and a landing on a neighbour would
        // delete it and report success.
        edit(moveKeyOps(project.committed, key, toSec), phase, 'Move keyframe');
      },
      onMoveSpan: (spanId, times, phase) => {
        edit(
          retimeAnnotationOps(project.committed, spanId, times, project.sourceDurationSec),
          phase,
          'Move note',
        );
      },
    },
  );
  timeline.setTracks(recording);

  // ---- the controls -----------------------------------------------------------

  let tool: ToolId = 'select';
  let selection: Selection = null;
  /**
   * The event logs, once they have been fetched.
   *
   * `null` until then, which is a real state and not a placeholder: the generator
   * panel says *reading…* rather than *unavailable*, because those are different
   * answers and the second one would be a lie for the first few hundred milliseconds
   * of every editor.
   */
  let logs: EventLogs | null = null;

  const stage = new StageUi(el.ovl, {
    onDraw: (kind, drag, phase) => {
      // Only on `end`. A rubber band is feedback the overlay draws itself; committing
      // a span per pointer move would put a hundred of them in the history and a
      // hundred revisions on disk. The two privacy kinds make it a correctness point
      // as well — a zero-area `blur` is a span the compositor refuses to composite,
      // and a drag passes through zero area on its first pixel.
      if (phase !== 'end') return;
      const at = sourceTimeFor(host.loop.time);
      const geometry =
        kind === 'arrow'
          ? { from: drag.from, to: drag.to }
          : {
              center: [(drag.from[0] + drag.to[0]) / 2, (drag.from[1] + drag.to[1]) / 2] as Vec2,
              size: [
                Math.abs(drag.to[0] - drag.from[0]),
                Math.abs(drag.to[1] - drag.from[1]),
              ] as Vec2,
            };
      const ops = placeAnnotationOps(project.committed, {
        kind,
        startSec: at,
        endSec: Math.min(at + DEFAULT_SPAN_SEC, project.sourceDurationSec),
        ...geometry,
        ...(kind === 'text' ? { style: { text: 'Text' } } : {}),
      });
      if (ops === null) return;
      const span = ops.find((op) => op.op === 'span.set');
      const added = ops.find((op) => op.op === 'track.add');
      const spanId =
        span?.op === 'span.set'
          ? span.span.id
          : added?.op === 'track.add'
            ? (added.track.spans?.[0]?.id ?? null)
            : null;
      project.commit(ops, `Add ${kind}`);
      // Back to Select, and the new annotation selected. A tool that stayed armed
      // would make the next click on the picture draw a second one, which is what a
      // person reaching for the handles they just made least expects.
      setTool('select');
      if (spanId !== null) select({ kind: 'annotation', spanId });
    },
    onEditAnnotation: (spanId, geometry, phase) => {
      edit(moveAnnotationOps(project.committed, spanId, geometry), phase, 'Move note');
    },
    onPick: (at) => {
      if (at === null) {
        select(null);
        return;
      }
      const hit = annotationAt(project.document, sourceTimeFor(host.loop.time), at);
      select(hit === null ? null : { kind: 'annotation', spanId: hit.span.id });
    },
    onZoomTo: (at, phase) => {
      const region = regionAtPlayhead();
      if (region === null) {
        // Nothing of the user's covers this instant, so the zoom tool *places* one,
        // centred where they pointed. One press, one zoom — and only on `end`, so a
        // press that turns into a drag pans the region it just made rather than
        // leaving a trail of them.
        if (phase !== 'end') return;
        const at0 = sourceTimeFor(host.loop.time);
        const ops = placeZoomOps(
          project.committed,
          {
            startSec: at0 - ZOOM_RAMP_SEC,
            endSec: at0 + DEFAULT_HOLD_SEC + ZOOM_RAMP_SEC,
            amount: DEFAULT_ZOOM_AMOUNT,
            center: at,
          },
          project.sourceDurationSec,
        );
        if (ops === null) {
          trouble('There is no room for a zoom here — it would overlap the one beside it.');
          return;
        }
        project.commit(ops, 'Add zoom');
        selectZoomAt(at0);
        return;
      }
      edit(
        updateZoomOps(project.committed, region.index, { center: at }, project.sourceDurationSec),
        phase,
        'Move zoom',
      );
    },
  });

  const inspector = new Inspector(
    { selection: el.inspSel, zoom: el.zoomPanel, generators: el.genPanel },
    {
      onPlaceZoom: () => {
        const at = sourceTimeFor(host.loop.time);
        const ops = placeZoomOps(
          project.committed,
          {
            startSec: at - ZOOM_RAMP_SEC,
            endSec: at + DEFAULT_HOLD_SEC + ZOOM_RAMP_SEC,
            amount: DEFAULT_ZOOM_AMOUNT,
            center: [0.5, 0.5],
          },
          project.sourceDurationSec,
        );
        if (ops === null) {
          trouble('There is no room for a zoom here — it would overlap the one beside it.');
          return;
        }
        project.commit(ops, 'Add zoom');
        selectZoomAt(at);
      },
      onOverrideZoom: () => {
        // The captain's row of the capability table, in one call. The seed is what
        // `resolve` reports at this instant — read off the *compiled* timeline, so it
        // is whatever the generator is actually doing rather than a second opinion
        // about it — and the span is the generated segment's own `activeRanges`
        // entry, so "override this zoom" covers the zoom.
        const at = sourceTimeFor(host.loop.time);
        const state = resolve(project.compiled, host.loop.time);
        const generated = generatedZoomAt(at);
        const ops = overrideZoomOps(
          project.committed,
          {
            atSec: at,
            seed: {
              amount: state.zoom.amount,
              center: [state.zoom.center[0], state.zoom.center[1]],
            },
            span: generated === null ? null : generatedSegmentAt(generated, at),
          },
          project.sourceDurationSec,
        );
        if (ops === null) {
          trouble('There is no room for a zoom of your own here.');
          return;
        }
        project.commit(ops, 'Take manual control');
        selectZoomAt(at);
      },
      onUpdateZoom: (index, patch, phase) => {
        // The same two-phase path a trim handle and a stage drag take: provisional
        // while the thumb is down, one commit on release. `inspector.ts`'s `range`
        // argues why a slider that committed per `input` is a control that does not
        // work rather than one that costs too many undo steps.
        edit(
          updateZoomOps(project.committed, index, patch, project.sourceDurationSec),
          phase,
          'Adjust zoom',
        );
      },
      onRemoveZoom: (index) => {
        const ops = removeZoomOps(project.committed, index);
        if (ops === null) return;
        project.commit(ops, 'Remove zoom');
        select(null);
      },
      onSelect: select,
      onSeek: (sourceSec) => {
        host.loop.seek(timelineTimeFor(sourceSec));
        paintPlayhead();
      },
      onMoveKey: (key, toSec) => {
        const ops = moveKeyOps(project.committed, key, toSec);
        if (ops !== null) project.commit(ops, 'Move keyframe');
      },
      onSetKeyValue: (key, value) => {
        const ops = setKeyValueOps(project.committed, key, value);
        if (ops !== null) project.commit(ops, 'Change keyframe');
      },
      onRemoveKey: (key) => {
        const ops = removeKeyOps(project.committed, key);
        if (ops === null) {
          trouble(
            'A channel needs two keyframes to describe a change. Remove the whole zoom ' +
              'instead, from the panel above.',
          );
          return;
        }
        project.commit(ops, 'Delete keyframe');
        select(null);
      },
      onStyleAnnotation: (spanId, patch, phase) => {
        edit(styleAnnotationOps(project.committed, spanId, patch), phase, 'Restyle note');
      },
      onRetimeAnnotation: (spanId, times) => {
        const ops = retimeAnnotationOps(
          project.committed,
          spanId,
          times,
          project.sourceDurationSec,
        );
        if (ops !== null) project.commit(ops, 'Retime note');
      },
      onRemoveAnnotation: (spanId) => {
        const ops = removeAnnotationOps(project.committed, spanId);
        if (ops === null) return;
        project.commit(ops, 'Delete note');
        select(null);
      },
      onGenerate: (type) => {
        generate(type);
      },
      onBake: (type) => {
        bake(type);
      },
    },
  );

  buildRail(el.rail, setTool);

  function setTool(next: ToolId): void {
    tool = next;
    setPressedTool(el.rail, next);
    el.tlHint.textContent = toolSpec(next).hint;
    renderStage();
  }

  function select(next: Selection): void {
    if (sameSelection(selection, next)) return;
    selection = next;
    renderControls();
    renderTimeline();
    renderStage();
  }

  /**
   * Show a batch without committing it — the frame under a live drag.
   *
   * The ops are applied to a **copy** of the committed document, which is what
   * `EditorProject.preview` is for: it is not in the history, it is never sent, and
   * `commit` or `cancelPreview` replaces it. `applyOps` is `@loom/format`'s own, so
   * what is previewed is exactly what the batch will do rather than an approximation
   * of it drawn by a control.
   */
  function provisional(ops: readonly EditOp[]): void {
    try {
      project.preview(applyOps(structuredClone(project.committed), [...ops]));
    } catch {
      // A batch that will not apply is a batch that will not be committed either;
      // the drag's next event recomputes it from the committed document, so there is
      // nothing to report and nothing to undo.
    }
  }

  /**
   * One step of a two-phase gesture — the shared boundary every drag ends at.
   *
   * Each op builder answers `null` for "this would change nothing", and every gesture
   * can reach that: a slider dragged away and back, a keyframe returned to where it
   * was, an annotation dropped where it was picked up. Returning early there is the
   * bug, because the *previous* move already left a provisional document on
   * `EditorProject` and nothing else clears it — the preview then shows a value that
   * is not in `edit.json` and `renderControls`, which reads `project.document`, shows
   * it too, until the next commit or undo happens by. `onTrimCommit` has always
   * cancelled the preview in that case; this is the same answer for the other five,
   * in one place so a sixth cannot be written without it.
   *
   * `cancelPreview` is a no-op when nothing is provisional, so a `move` that changes
   * nothing costs nothing and repeated ones cost nothing after the first.
   */
  function edit(ops: readonly EditOp[] | null, phase: 'move' | 'end', label: string): void {
    if (ops === null) {
      project.cancelPreview();
      return;
    }
    if (phase === 'move') provisional(ops);
    else project.commit(ops, label);
  }

  /** The generated zoom track whose window covers `atSec`, or `null`. */
  function generatedZoomAt(atSec: Seconds): Track | null {
    for (const track of project.committed.tracks) {
      if (track.target !== 'zoom' || track.origin !== 'generated' || !track.enabled) continue;
      if (generatedSegmentAt(track, atSec) !== null) return track;
    }
    return null;
  }

  function regionAtPlayhead(): ZoomRegion | null {
    return zoomRegionAt(project.committed, sourceTimeFor(host.loop.time));
  }

  /**
   * Select the region that covers an instant — the one a *place* or an *override*
   * just made.
   *
   * By what it covers, never by `zoomRegionsOf(...).length - 1`. `ZoomRegion.index` is
   * a position in `activeRanges` and `placeZoomOps` keeps those sorted by start time,
   * so the newest region is the last element only when it also happens to be the
   * latest one in the recording: placing a zoom at 2 s after one at 10 s makes the new
   * region index 0 and would have selected the 10 s one, leaving every field in the
   * panel tuning a zoom nobody was looking at. `length - 1` is not the largest index
   * either, since `zoomRegionsOf` skips a window whose keys it cannot read.
   */
  function selectZoomAt(atSec: Seconds): void {
    const region = zoomRegionAt(project.committed, atSec);
    select(region === null ? null : { kind: 'zoom', index: region.index });
  }

  function generate(type: RunnableGenerator): void {
    if (logs === null) {
      trouble('The event logs have not finished loading yet.');
      return;
    }
    const result = runGenerator(type, project.committed, logs, {
      durationSec: project.sourceDurationSec,
      recording,
    });
    if ('error' in result) {
      trouble(result.error);
      return;
    }
    project.commit(result.ops, 'Generate');
    if (result.warning !== null) trouble(result.warning);
  }

  function bake(type: RunnableGenerator): void {
    const track = project.committed.tracks.find(
      (candidate) => candidate.id === GENERATOR_TRACK_ID[type],
    );
    if (track === undefined) return;
    const ops = bakeOps(track);
    if (ops.length === 0) return;
    project.commit(ops, 'Bake');
  }

  // ---- keeping everything in step --------------------------------------------

  /** Source time for a timeline time, through the clip list and nothing else. */
  function sourceTimeFor(timelineSec: Seconds): Seconds {
    return resolve(project.compiled, timelineSec).sourceTime;
  }

  /**
   * Timeline time for a source instant, clamped into the trimmed region.
   *
   * `timelineTimeAt` answers `null` for material the trim removed, and the caller
   * has to mean something by that (its docstring says so). Here it means: the
   * output does not contain that instant, so the playhead goes to whichever end of
   * the output is nearer — never to a position that would show a frame the export
   * will not contain.
   */
  function timelineTimeFor(sourceSec: Seconds): Seconds {
    const at = timelineTimeAt(clips, sourceSec);
    if (at !== null) return at;
    return sourceSec <= trim.startSec ? 0 : project.compiled.durationSec;
  }

  function onDocumentChanged(): void {
    clips = compileClips(project.document.clips, project.sourceDurationSec);
    trim = readTrim(project.document, project.sourceDurationSec);
    host.timeline = project.compiled;
    el.undo.disabled = !project.canUndo;
    el.redo.disabled = !project.canRedo;
    el.saveState.textContent =
      project.saveState === 'saving'
        ? 'Saving…'
        : project.saveState === 'failed'
          ? 'Not saved'
          : 'Saved';
    el.saveState.className =
      project.saveState === 'failed' ? 'chip chip-accent' : 'chip chip-muted';
    // A selection can be invalidated by the edit that just landed, by an undo, or by
    // another window winning a conflict — and an inspector describing a keyframe that
    // is no longer in the document is worse than an empty one. Dropped here, once,
    // rather than guarded at every read.
    if (!selectionExists()) selection = null;
    renderTimeline();
    renderControls();
    renderStage();
    renderFacts();
  }

  /**
   * Is what is selected still in the document — the **committed** one?
   *
   * Committed and not `project.document`, which is the provisional document while a
   * drag is live. A keyframe drag selects its key on pointerdown and then previews the
   * key at its *new* `t` on every pointermove, so asking the provisional document
   * would find no key at the selected `t` and drop the selection on the first move —
   * the panel and the lane's marker vanishing for the rest of the drag. The three
   * things this guard is for — an edit that landed, an undo, a conflict reload — are
   * all committed state.
   */
  function selectionExists(): boolean {
    const doc = project.committed;
    const current = selection;
    if (current === null) return true;
    if (current.kind === 'zoom') {
      return zoomRegionsOf(doc).some((region) => region.index === current.index);
    }
    if (current.kind === 'annotation') {
      return annotationsOf(doc).some((view_) => view_.span.id === current.spanId);
    }
    const ref = current.ref;
    return zoomKeysOf(doc).some(
      (key) => key.trackId === ref.trackId && key.channel === ref.channel && key.t === ref.t,
    );
  }

  function renderTimeline(): void {
    view = { ...view, durationSec: project.sourceDurationSec, widthPx: timeline.widthPx };
    timeline.render({
      view,
      trim,
      playheadSourceSec: sourceTimeFor(host.loop.time),
      document: project.document,
      selection,
    });
    el.tlZoom.textContent = `${String(Math.round(view.zoom * 100))}%`;
  }

  /** The three inspector panels, rebuilt from the document and the selection. */
  function renderControls(): void {
    const doc = project.document;
    const sourceSec = sourceTimeFor(host.loop.time);
    const state = resolve(project.compiled, host.loop.time);
    inspector.render({
      selection,
      regions: zoomRegionsOf(doc),
      keys: zoomKeysOf(doc),
      annotations: annotationsOf(doc),
      generators: generatorStates(doc, logs ?? EMPTY_LOGS),
      playheadSourceSec: sourceSec,
      // Cloned, because `resolve` hands back the compiled timeline's **own** state
      // object and overwrites it in place — a panel that kept the reference would be
      // describing next frame's zoom.
      resolvedZoom: {
        amount: state.zoom.amount,
        center: [state.zoom.center[0], state.zoom.center[1]],
      },
      generatedAt: generatedZoomAt(sourceSec),
      sourceDurationSec: project.sourceDurationSec,
    });
  }

  /** The handles over the picture. */
  function renderStage(): void {
    const doc = project.document;
    const sourceSec = sourceTimeFor(host.loop.time);
    const state = resolve(project.compiled, host.loop.time);
    const current = selection;
    const selected: AnnotationView | null =
      current?.kind === 'annotation'
        ? (annotationsOf(doc).find((view_) => view_.span.id === current.spanId) ?? null)
        : null;
    stage.render({
      tool,
      mapping: {
        outputSize: doc.output.size,
        sourceSize: sourceSize,
        zoom: {
          amount: state.zoom.amount,
          center: [state.zoom.center[0], state.zoom.center[1]],
        },
      },
      selected,
      selectedVisible:
        selected !== null && sourceSec >= selected.startSec && sourceSec <= selected.endSec,
    });
  }

  /** What {@link paintPlayhead} last wrote, so that it can write only changes. */
  let paintedTimelineSec = Number.NaN;
  let paintedDurationSec = Number.NaN;
  let paintedPlaying: boolean | null = null;
  /** `[amount, cx, cy]` the overlay's handles were last placed for. */
  let paintedZoom: [number, number, number] = [Number.NaN, Number.NaN, Number.NaN];

  /**
   * The cheap per-frame half: one style write, and text only when it changed.
   *
   * The playhead's own write is unconditional — it is a single style assignment and
   * it has to land on the frame the pointer is on. Everything else is guarded,
   * because this runs on its own `requestAnimationFrame` whether or not anything is
   * moving. The play/pause glyph is the one that matters: `icon()` returns SVG
   * *markup*, so assigning it tears down a subtree and re-runs the HTML parser, and
   * doing that sixty times a second at rest is both the allocation §4.3 forbids in
   * the loop and work no budget instrument sees, since this frame is deliberately
   * not `PreviewLoop`'s.
   */
  function paintPlayhead(): void {
    const timelineSec = host.loop.time;
    timeline.setPlayhead(view, sourceTimeFor(timelineSec));

    const durationSec = project.compiled.durationSec;
    if (timelineSec !== paintedTimelineSec || durationSec !== paintedDurationSec) {
      paintedTimelineSec = timelineSec;
      paintedDurationSec = durationSec;
      const out = `${formatTimecodeCentis(timelineSec)} / ${formatTimecodeCentis(durationSec)}`;
      el.tcode.textContent = out;
      el.tlTc.textContent = out;
    }

    const playing = host.loop.playing;
    if (playing !== paintedPlaying) {
      paintedPlaying = playing;
      el.playpause.innerHTML = icon(playing ? 'pause' : 'play', 15);
      el.playpause.title = playing ? 'Pause' : 'Play';
    }

    // The stage is re-placed whenever the zoom moves, and **not** only when something
    // is selected. Two things ride on `StageState.mapping`: the handles over a
    // selected annotation, and `outputToSource` — the map every pointer on the picture
    // crosses. Nothing is selected for most of this window's life, so guarding on a
    // selection left the map holding whatever zoom was resolved at the last document,
    // selection or tool change; scrubbing into a 2.2× segment and then dragging a blur
    // wrote the redaction at the coordinates it would have had at 1×, which is the
    // privacy defect `annotations.ts` anchors geometry in source space to prevent. The
    // per-frame cost is unchanged in shape: `resolve` is 0.08 µs and three number
    // comparisons guard the only thing that allocates.
    const zoom = resolve(project.compiled, timelineSec).zoom;
    if (
      zoom.amount !== paintedZoom[0] ||
      zoom.center[0] !== paintedZoom[1] ||
      zoom.center[1] !== paintedZoom[2]
    ) {
      paintedZoom = [zoom.amount, zoom.center[0], zoom.center[1]];
      renderStage();
    }
  }

  function renderFacts(): void {
    const part = parts[0];
    facts(el.facts, [
      ['Length', formatTimecodeCentis(project.sourceDurationSec)],
      ['Captured', part === undefined ? '—' : `${String(part.size[0])}×${String(part.size[1])}`],
      ['Frame rate', part === undefined ? '—' : `${part.rate.observedFps.toFixed(1)} fps`],
      ['Frames', String(parts.reduce((sum, p) => sum + p.frameCount, 0))],
      [
        'Output',
        `${String(project.document.output.size[0])}×${String(project.document.output.size[1])}`,
      ],
    ]);
    facts(el.trimFacts, [
      ['Starts at', formatTimecodeCentis(trim.startSec)],
      ['Ends at', formatTimecodeCentis(trim.endSec)],
      ['Keeps', formatTimecodeCentis(project.compiled.durationSec)],
      [
        'Removes',
        formatTimecodeCentis(
          Math.max(0, project.sourceDurationSec - (trim.endSec - trim.startSec)),
        ),
      ],
    ]);
    el.inspNote.textContent =
      'Trimming changes where the output starts and ends. Nothing is removed from the ' +
      'recording on disk — the material outside the handles is still there, and dragging ' +
      'them back brings it back. There is no sound in this preview yet.';
    // The hint line belongs to the armed tool (`setTool` writes it), not to this
    // function — it used to say one fixed sentence about trimming, and a tool rail
    // whose instructions are somewhere else is a rail nobody reads.

    // Every number here is measured: the length from the parts on the recording
    // clock, the size from the part the encoder actually produced, the bytes from
    // `project.json`'s own walk of the bundle.
    const meta = [formatTimecode(project.sourceDurationSec)];
    if (part !== undefined)
      meta.push(`${String(part.size[0])}×${String(part.size[1])}`, part.codec);
    if (opened.project !== null) meta.push(formatBytes(opened.project.sizeBytes));
    el.meta.textContent = meta.join(' · ');
  }

  // ---- transport --------------------------------------------------------------
  el.playpause.addEventListener('click', () => {
    if (host.loop.playing) host.loop.pause();
    else host.loop.play();
    paintPlayhead();
  });
  el.restart.addEventListener('click', () => {
    host.loop.seek(0);
    paintPlayhead();
  });
  el.undo.addEventListener('click', () => {
    project.undo();
  });
  el.redo.addEventListener('click', () => {
    project.redo();
  });
  el.zoomIn.addEventListener('click', () => {
    view = zoomAbout(view, view.zoom * 1.6, sourceTimeFor(host.loop.time));
    renderTimeline();
  });
  el.zoomOut.addEventListener('click', () => {
    view = zoomAbout(view, view.zoom / 1.6, sourceTimeFor(host.loop.time));
    renderTimeline();
  });
  el.zoomFit.addEventListener('click', () => {
    view = { ...view, zoom: 1, scrollSec: 0 };
    renderTimeline();
  });

  window.addEventListener('keydown', (event) => {
    // A key pressed inside a control belongs to that control — the trim handles
    // read arrows themselves, and stealing them here would make a focused handle
    // scrub instead of nudge. The inspector's fields are the same rule one panel
    // over: space in a text field is a space, and Delete is a character.
    if (event.target instanceof HTMLElement && event.target.closest('.handle') !== null) return;
    if (event.target instanceof HTMLInputElement) return;
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) project.redo();
      else project.undo();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setTool('select');
      select(null);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelection();
      return;
    }
    const step = event.shiftKey ? 1 : 0.1;
    switch (event.key) {
      case ' ':
        event.preventDefault();
        if (host.loop.playing) host.loop.pause();
        else host.loop.play();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        host.loop.seek(host.loop.time - step, { scrubbing: true });
        break;
      case 'ArrowRight':
        event.preventDefault();
        host.loop.seek(host.loop.time + step, { scrubbing: true });
        break;
      case 'Home':
        event.preventDefault();
        host.loop.seek(0);
        break;
      case 'End':
        event.preventDefault();
        host.loop.seek(project.compiled.durationSec);
        break;
      default:
        return;
    }
    paintPlayhead();
  });

  /**
   * Size the picture to the room the mat has, keeping `edit.output.size`'s ratio.
   *
   * In JS rather than CSS because a `<canvas>` is a replaced element with an
   * intrinsic size, and every CSS way of saying "contain this ratio in that box"
   * goes circular through it: the wrapper's size comes from the canvas, and the
   * canvas's percentage `max-*` resolve against the wrapper. The result was a full
   * width black box with a small picture in the middle of it — visible in a
   * screenshot and in nothing else, which is why this window got looked at.
   *
   * `getBoundingClientRect` on the mat is the measurement; the padding is read
   * back out of the computed style rather than repeated from the stylesheet.
   */
  function fitStage(): void {
    const box = el.mat.getBoundingClientRect();
    const style = getComputedStyle(el.mat);
    const availableW = box.width - Number.parseFloat(style.paddingLeft) * 2;
    const availableH = box.height - Number.parseFloat(style.paddingTop) * 2;
    const [outW, outH] = project.document.output.size;
    if (!(availableW > 0) || !(availableH > 0) || !(outW > 0) || !(outH > 0)) return;
    const width = Math.max(1, Math.min(availableW, (availableH * outW) / outH));
    el.film.style.width = `${String(Math.floor(width))}px`;
    el.film.style.height = `${String(Math.floor((width * outH) / outW))}px`;
  }

  // The lane area's width decides every x in the timeline and the stage's decides
  // how big the picture is; both are measured and neither is assumed. A window
  // resize is the only thing that changes either.
  new ResizeObserver(() => {
    renderTimeline();
  }).observe(el.lanes);
  new ResizeObserver(fitStage).observe(el.mat);
  fitStage();

  /**
   * Delete whatever is selected, through the same op the panel's button sends.
   *
   * A keyframe is the one case that can be refused — a channel needs two keys to
   * describe a change — and the refusal says what to do instead rather than doing
   * nothing, which is how a key that will not delete becomes a bug report.
   */
  function deleteSelection(): void {
    if (selection === null) return;
    if (selection.kind === 'annotation') {
      const ops = removeAnnotationOps(project.committed, selection.spanId);
      if (ops === null) return;
      project.commit(ops, 'Delete note');
      select(null);
      return;
    }
    if (selection.kind === 'zoom') {
      const ops = removeZoomOps(project.committed, selection.index);
      if (ops === null) return;
      project.commit(ops, 'Remove zoom');
      select(null);
      return;
    }
    const ops = removeKeyOps(project.committed, selection.ref);
    if (ops === null) {
      trouble(
        'A channel needs two keyframes to describe a change. Remove the whole zoom ' +
          'instead, from the panel on the right.',
      );
      return;
    }
    project.commit(ops, 'Delete keyframe');
    select(null);
  }

  // ---- go ---------------------------------------------------------------------
  setTool('select');
  onDocumentChanged();
  host.start();

  /**
   * The event logs, read once, in the background.
   *
   * Deliberately **not** awaited before the editor opens. Reading two NDJSON files
   * over `loom://` is fast, but it is I/O on a path that has nothing to do with
   * showing somebody their recording, and §10.2's rule is that a clear state beats a
   * spinner: the window opens, the generator panel says what it knows, and it says
   * more a moment later. A failure to read is a sentence in that panel and never a
   * refusal to open the editor.
   */
  void readEventLogs(id, recording, { fetchText, digest: sha256 })
    .then((read) => {
      logs = read;
      if (read.trouble !== null) trouble(read.trouble);
      renderControls();
    })
    .catch((error: unknown) => {
      logs = EMPTY_LOGS;
      trouble(
        `This recording’s event logs could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      renderControls();
    });

  // The read-only view `test/editor-gate.test.ts` measures this window through.
  // `probe.ts` argues why it exists and why it is not a capability.
  window.__loomEditor = {
    readPixels: () => host.readPixels(),
    get outputSize() {
      return project.document.output.size;
    },
    get timelineSec() {
      return host.loop.time;
    },
    get sourceSec() {
      return sourceTimeFor(host.loop.time);
    },
    get durationSec() {
      return project.compiled.durationSec;
    },
    get playing() {
      return host.loop.playing;
    },
    get trim() {
      return trim;
    },
    get clips() {
      return project.document.clips;
    },
    get tool() {
      return tool;
    },
    get selection() {
      return selection;
    },
    // The resolved zoom, cloned. `resolve` hands back the compiled timeline's own
    // state object and overwrites it in place, so a probe returning the live one
    // would report whatever the next frame did.
    get zoom() {
      const state = resolve(project.compiled, host.loop.time);
      return {
        amount: state.zoom.amount,
        center: [state.zoom.center[0], state.zoom.center[1]] as [number, number],
      };
    },
    get regions() {
      return zoomRegionsOf(project.document);
    },
    get annotations() {
      return annotationsOf(project.document).map((view_) => ({
        id: view_.span.id,
        kind: view_.kind,
        startSec: view_.startSec,
        endSec: view_.endSec,
      }));
    },
    get tracks() {
      return project.document.tracks.map((track) => ({
        id: track.id,
        target: track.target,
        origin: track.origin,
        generated: track.generator !== undefined,
        baked: track.origin === 'manual' && track.generatedFrom !== undefined,
        activeRanges: track.activeRanges.map((range) => [range[0], range[1]] as [number, number]),
        keyCount: Object.values(track.channels).reduce((sum, c) => sum + c.keys.length, 0),
        spanCount: track.spans?.length ?? 0,
      }));
    },
    get logsRead() {
      return logs !== null;
    },
  };

  // The playhead's own frame. Separate from `PreviewLoop`'s callback on purpose:
  // §4.3 measures the preview frame on the single worst one with no allowance, and
  // a caller's DOM writes must not be charged to it.
  const paint = (): void => {
    paintPlayhead();
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);

  window.addEventListener('beforeunload', () => {
    host.dispose();
  });
}

void start().catch((error: unknown) => {
  refuse('The editor could not start.', error instanceof Error ? error.message : String(error));
});
