/**
 * The app's identity on macOS.
 *
 * ## The bundle identifier is chosen once, here, and never changed
 *
 * Research report §7, trap 7: *"Give the app a stable bundle identifier
 * immediately. TCC keys on identity; a churning identity means repeated permission
 * prompts and mysterious black frames."*
 *
 * macOS's privacy database (TCC) records "the user granted Screen Recording to
 * `com.github.cmartinez9.loom-clone`". Change that string and every grant the user
 * has given evaporates: Screen Recording, Camera, Microphone and Accessibility all
 * re-prompt, and — worse, because it looks like a bug in our code rather than a
 * permission problem — screen capture returns black frames until they are granted
 * again. Accessibility does not even re-prompt; it requires a manual trip to
 * System Settings and a relaunch.
 *
 * So this value is frozen. `apps/main/test/identity.test.ts` fails if it changes,
 * and `electron-builder.yml` reads it rather than repeating it. If a future phase
 * genuinely needs a different identifier, that is a captain decision with a
 * migration story, not an edit to this line.
 *
 * The reverse-DNS prefix is the GitHub namespace that actually owns the source
 * (`github.com/cmartinez9/loom-clone`), rather than a domain we do not control.
 */
export const LOOM_BUNDLE_ID = 'com.github.cmartinez9.loom-clone';

/** The name shown in the menu bar, the About box and `~/Library/Application Support`. */
export const LOOM_PRODUCT_NAME = 'Loom Clone';

/**
 * The minimum macOS this app supports, as `LSMinimumSystemVersion`.
 *
 * Captain decision 7 (`data/loom-scope/decision-macos-floor.md`): **macOS 14+**.
 * Below 14 the app would have to ship a CoreAudio HAL plug-in, an admin password
 * prompt and a `coreaudiod` restart to capture system audio — exactly what Loom
 * itself still does, and exactly what the decision buys its way out of. There is
 * no cross-platform hedging in this codebase and no compatibility shim that would
 * reintroduce that path.
 */
export const MINIMUM_MACOS_VERSION = '14.0';

/** The default recordings root, relative to the user's home directory. */
export const DEFAULT_RECORDINGS_SUBPATH = ['Movies', LOOM_PRODUCT_NAME] as const;
