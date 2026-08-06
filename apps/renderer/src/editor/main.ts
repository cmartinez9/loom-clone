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
 *    a playhead — are a WebGL draw and two style writes. Neither is a rendering a
 *    virtual DOM can help with, and the design language's own rule is that nothing
 *    on the input path animates or defers (`--t-instant`). A reconciler between a
 *    pointer and a playhead is latency spent for nothing.
 *  - §4.3's first anti-stutter rule is that nothing allocates in the loop. Every
 *    framework's answer to state is allocation.
 *  - The preview loop, the compositor and the timeline model are already the hard
 *    parts and are already framework-free by §1.3. What is left here is a few
 *    hundred lines of DOM.
 *
 * `loom-p15` inherits this choice. If it ever stops paying — the inspector growing
 * a dozen interdependent controls is the plausible way — that is a decision to
 * re-take with the same reasoning written down, not a thing to drift into.
 *
 * ## What this window does not do
 *
 * No audio: §5.4 mechanism 4 requires playback time to come from the audio output's
 * played-sample count and `PreviewLoop` accumulates `requestAnimationFrame` deltas,
 * so sound would drift against the scrub bar by design. `align.ts` records where
 * that work belongs. No keyframe editing, no manual zoom control, no annotation
 * tools, no generator regenerate/bake — those are `loom-p15`'s, and the seams they
 * need are the zoom lane in `timeline.ts`, the inspector's empty second half, and
 * the tool rail.
 */

import '@loom/design/css';
import './editor.css';
import { formatBytes, formatTimecode, formatTimecodeCentis, icon } from '@loom/design';
import { compileClips, resolve, timelineTimeAt, type CompiledClips } from '@loom/edl';
import { recordingUrl, SUBJECT_PARAM, type OpenedProject } from '@loom/ipc';
import type { Seconds, VideoTrackDoc } from '@loom/format';
import { EditorProject } from './project.ts';
import { PreviewHost } from './preview-host.ts';
import { ScreenSource } from './screen-source.ts';
import { TimelineUi } from './timeline.ts';
import { clampZoom, zoomAbout, type TimelineView } from './timeline-geometry.ts';
import { readTrim, trimOp, type Trim } from './trim.ts';

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
  toolSelect: must('tool-select'),
  mat: must('mat'),
  film: must('film'),
  preview: must('preview') as HTMLCanvasElement,
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
  set(el.toolSelect, 'cursor', 17);
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
    const source = await ScreenSource.open({
      parts,
      mediaUrl: (_part, partIndex) => loom.project.mediaUrl(id, 'screen', partIndex),
      // The sidecar's path comes from `recording.json`'s own `VideoPart.index`
      // (§2.3) rather than from the layout function, because the document is what
      // says where a part's index actually is. `recordingUrl` escapes each segment.
      indexUrl: (part) => recordingUrl(id, part.index),
    });
    host = new PreviewHost({
      canvas: el.preview,
      screen: source,
      timeline: project.compiled,
      outputSize: project.document.output.size,
      onTrouble: trouble,
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
    },
  );
  timeline.setTracks(recording);

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
    renderTimeline();
    renderFacts();
  }

  function renderTimeline(): void {
    view = { ...view, durationSec: project.sourceDurationSec, widthPx: timeline.widthPx };
    timeline.render({
      view,
      trim,
      playheadSourceSec: sourceTimeFor(host.loop.time),
      document: project.document,
    });
    el.tlZoom.textContent = `${String(Math.round(view.zoom * 100))}%`;
  }

  /** The cheap per-frame half: two style writes and two text nodes. */
  function paintPlayhead(): void {
    const timelineSec = host.loop.time;
    timeline.setPlayhead(view, sourceTimeFor(timelineSec));
    const out = `${formatTimecodeCentis(timelineSec)} / ${formatTimecodeCentis(
      project.compiled.durationSec,
    )}`;
    el.tcode.textContent = out;
    el.tlTc.textContent = out;
    el.playpause.innerHTML = icon(host.loop.playing ? 'pause' : 'play', 15);
    el.playpause.title = host.loop.playing ? 'Pause' : 'Play';
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
    el.tlHint.textContent = 'Drag the handles to trim · space to play';

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
    // scrub instead of nudge.
    if (event.target instanceof HTMLElement && event.target.closest('.handle') !== null) return;
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) project.redo();
      else project.undo();
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

  // ---- go ---------------------------------------------------------------------
  onDocumentChanged();
  host.start();

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
