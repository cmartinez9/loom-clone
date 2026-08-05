# @loom/design — "Pressroom"

The approved visual language. Direction A, decided by the captain on 2026-08-04
(`data/loom-scope/decision-visual-direction.md`), with the reasoning and the
measured evidence in `data/loom-design/report.md`.

## What is here, and where it came from

| File                 | Provenance                                                               |
| -------------------- | ------------------------------------------------------------------------ |
| `css/tokens.css`     | **verbatim** from `data/loom-design/tokens.css` — the authoritative file |
| `css/type.css`       | verbatim, except `url("fonts/…")` → `url("../fonts/…")` for this layout  |
| `css/components.css` | the mockups' primitives, rebuilt on the semantic token names             |
| `fonts/*.woff2`      | verbatim; SIL OFL 1.1, self-hosted, **no CDN call at runtime**           |
| `src/icons.ts`       | `data/loom-design/icons.js`, typed; paths byte-identical                 |
| `src/format.ts`      | new — number formatting, because the shape of a number is design here    |

Working mockups of every surface live in `data/loom-design/*.html` and open in a
browser with no build step. They are the reference for how a surface should look.

## Using it

```ts
import '@loom/design/css'; // type.css + tokens.css + components.css
import { icon, mountIcons, formatBytes } from '@loom/design';
```

Theme follows the OS. Force one with `<html data-theme="light">` or `"dark"`.

## The rules that are not preferences

- **The stage is always dark.** `--stage-*` never flips with the theme. Footage is
  judged against a constant ground in both modes.
- **A shadow means "this floats above your desktop", and nothing else.** The
  recording bar, the draw palette and popovers get `--lift`. Nothing inside a
  window ever does; panels are defined by keylines.
- **Nothing on the input path animates.** Press, toggle, scrub, playhead and
  waveform redraw are `--t-instant`.
- **Vermilion is the record light.** It is spent on record and on destroy, nowhere
  else. Audio is ochre so a loud passage never looks like an error.
- **Selection is ink inverted** — not a sixth hue.

## Banned, as a review criterion

No violet/indigo gradients, no colour-blend gradients at all, no `backdrop-filter`,
no blurred shadows, no blue-black neutrals, no Inter, no emoji as iconography.
`packages/design/test/no-generic-look.test.ts` fails the build on the mechanical
ones. The rationale is `data/loom-design/report.md` §2 and §8: Wispr Flow — the
captain's own reference — ships zero gradients, zero backdrop-filters, and exactly
one shadow, with no blur, across its entire homepage.
