/**
 * `@loom/design` — the Pressroom design system.
 *
 * ```ts
 * import '@loom/design/css';          // type.css + tokens.css + components.css
 * import { icon, mountIcons } from '@loom/design';
 * ```
 *
 * The CSS is imported by the bundler, which inlines the three stylesheets and
 * emits the five woff2 files as assets. **The fonts are self-hosted and there is
 * no network request at runtime** — a recorder that phones a font CDN on launch
 * would be both slow and a lie about being local-only.
 */

export { ICONS, icon, isIconName, mountIcons, type IconName } from './icons.ts';

/** Formatting helpers for the values this design language sets in Martian Mono. */
export {
  formatBytes,
  formatDuration,
  formatTimecode,
  formatTimecodeCentis,
  formatRelativeDate,
} from './format.ts';
