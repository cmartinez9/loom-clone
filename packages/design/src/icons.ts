/**
 * The Pressroom icon set, ported from `data/loom-design/icons.js`.
 *
 * Drawing rules, from the design scout's report §6 — these are the difference
 * between "an icon set" and "the icon set that ships with every generated UI":
 *
 *   · 24×24 box, 1.75 stroke, `currentColor`
 *   · **BUTT caps, MITER joins** — squared ends, drafting-instrument feel. This is
 *     the deliberate opposite of the round-cap Feather/Lucide look, and it is a
 *     visible, checkable difference at 16px.
 *   · geometry snapped to the half-pixel grid so 16px renders crisp
 *   · solid fills only for states that are "on" (record, keyframe, play)
 *   · **no emoji, anywhere, ever**
 *
 * Paths are byte-identical to the approved set. Adding one is fine; changing a
 * stroke rule is a design decision, not an implementation detail.
 */

export const ICONS = {
  record: '<circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none"/>',
  restart: '<path d="M4 12a8 8 0 1 1 2.6 5.9"/><path d="M4 6v5h5"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10.5 10.5v6M13.5 10.5v6"/>',
  pen: '<path d="M4 20l1.2-4.4L15.6 5.2l3.2 3.2L8.4 18.8z"/><path d="M14 6.8l3.2 3.2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
  micOff:
    '<path d="M9 6.5V6a3 3 0 0 1 6 0v5M9 10v1a3 3 0 0 0 4.6 2.5"/><path d="M5.5 11.5a6.5 6.5 0 0 0 10 5.5M18.5 11.5a6.5 6.5 0 0 1-.6 2.7"/><path d="M12 18v3"/><path d="M4 3l16 18"/>',
  cam: '<rect x="3" y="6" width="12.5" height="12" rx="2"/><path d="M15.5 11l5.5-3.2v8.4L15.5 13z" fill="currentColor" stroke="none"/>',
  camOff:
    '<path d="M3 8v8a2 2 0 0 0 2 2h8.5M15.5 14.5V8a2 2 0 0 0-2-2H7.5"/><path d="M15.5 11l5.5-3.2v8.4l-2.6-1.5"/><path d="M4 3l16 18"/>',
  speaker:
    '<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18 6.6a7.5 7.5 0 0 1 0 10.8"/>',
  speakerX: '<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  screen: '<rect x="2.5" y="4.5" width="19" height="13" rx="1.5"/><path d="M8 21h8M12 17.5V21"/>',
  window:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9h17"/><path d="M6.5 6.75h1.5"/>',
  area: '<path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4"/><path d="M8.5 8.5h7v7h-7z" stroke-dasharray="2.5 2"/>',
  zoomIn:
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/><path d="M10.5 7.5v6M7.5 10.5h6"/>',
  keyframe: '<path d="M12 3.5l6 8.5-6 8.5-6-8.5z" fill="currentColor" stroke="none"/>',
  keyframeO: '<path d="M12 3.5l6 8.5-6 8.5-6-8.5z"/>',
  arrow: '<path d="M4.5 19.5L19 5"/><path d="M11.5 5H19v7.5"/>',
  box: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  textT: '<path d="M5 5h14"/><path d="M12 5v14"/><path d="M8.5 19h7"/>',
  marker: '<path d="M4 20h5l10-10-4-4L5 16z"/><path d="M4 20h16"/>',
  blur: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16" stroke-dasharray="1.5 2.5"/><path d="M6.5 7.5l11 9M6.5 16.5l11-9" stroke-dasharray="1.5 2.5"/>',
  cut: '<circle cx="7" cy="18" r="2.6"/><circle cx="17" cy="18" r="2.6"/><path d="M8.6 16L18 4M15.4 16L6 4"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
  export: '<path d="M12 3.5v11"/><path d="M8 10.5l4 4 4-4"/><path d="M4 16v3.5h16V16"/>',
  folder: '<path d="M3 6.5h6l2 2.5h10V19H3z"/>',
  clip: '<rect x="8" y="3" width="12" height="15" rx="1.5"/><path d="M16 18v3H4V6h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  chevD: '<path d="M5 9l7 7 7-7"/>',
  chevR: '<path d="M9 5l7 7-7 7"/>',
  grip: '<path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" stroke-width="2.6"/>',
  undo: '<path d="M4 9h10a5.5 5.5 0 0 1 0 11h-6"/><path d="M8 4.5L3.5 9 8 13.5"/>',
  redo: '<path d="M20 9H10a5.5 5.5 0 0 0 0 11h6"/><path d="M16 4.5L20.5 9 16 13.5"/>',
  /* Settings reads as sliders, not a cogwheel: a 16px cog turns to mush,
     and three tracks with handles stay legible at every size we ship. */
  gear: '<path d="M3.5 7.5h17M3.5 12h17M3.5 16.5h17"/><rect x="7" y="5.4" width="4.2" height="4.2" fill="currentColor" stroke="none"/><rect x="13.5" y="9.9" width="4.2" height="4.2" fill="currentColor" stroke="none"/><rect x="6" y="14.4" width="4.2" height="4.2" fill="currentColor" stroke="none"/>',
  cursor: '<path d="M6 3.5l12.5 7.8-5.4 1.2-1.3 5.6z" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.5l3.5 2"/>',
  alert: '<path d="M12 3.5L21.5 20h-19z"/><path d="M12 9.5v5M12 17h.01" stroke-width="2.2"/>',
  bubbleC: '<circle cx="12" cy="12" r="8"/>',
  bubbleS: '<rect x="4" y="4" width="16" height="16" rx="3.5"/>',
  bubbleR: '<rect x="2.5" y="6.5" width="19" height="11" rx="3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, value);
}

/**
 * SVG markup for one icon.
 *
 * Returns markup rather than an element so it composes into template strings, the
 * way the mockups use it. The contents are compile-time constants; nothing
 * user-supplied reaches the output except `extraClass`, which the caller controls.
 */
export function icon(name: IconName, size = 16, extraClass = ''): string {
  const body = ICONS[name];
  const cls = extraClass === '' ? 'ic' : `ic ${extraClass}`;
  return (
    `<svg class="${cls}" width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" ` +
    'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="butt" ' +
    `stroke-linejoin="miter" aria-hidden="true">${body}</svg>`
  );
}

/**
 * Hydrate every `<i data-ic="name" data-sz="18"></i>` under `root`.
 *
 * An unknown name is left empty rather than throwing: a missing glyph is a visual
 * bug, not a reason to take a window down.
 */
export function mountIcons(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-ic]')) {
    const name = element.dataset['ic'];
    if (name === undefined || !isIconName(name)) continue;
    const size = Number.parseInt(element.dataset['sz'] ?? '16', 10);
    element.innerHTML = icon(name, Number.isFinite(size) ? size : 16);
    element.classList.add('ic-slot');
  }
}
