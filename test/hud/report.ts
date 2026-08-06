/** What the HUD probe measures. Shared by `test/hud/main.ts` and the test. */

export interface Probe {
  /** Which state of the HUD this reading was taken in. */
  label: string;
  /** `[width, height]` of the window's content area at the moment of the reading. */
  contentSize: [number, number];
  /** The renderer's own view of that height, which is what clips the notice. */
  innerHeight: number;
  /** §7.4's banner, as the user would read it. Empty when the shelf is empty. */
  noticeText: string;
  noticeHidden: boolean;
  /**
   * Pixels of the notice inside the viewport — the number the whole gate is about.
   *
   * Not "is the element there" and not "is the class applied": the defect this
   * covers had a correct, populated, un-hidden `<p>` laid out at y=92 in a 92 px
   * window, where no part of it was ever on screen.
   */
  noticeVisiblePx: number;
  /** `elementFromPoint` at the notice's centre lands on the notice itself. */
  noticeOnTop: boolean;
  /** The error line, which shares the shelf and had the same defect. */
  errorVisiblePx: number;
  errorText: string;
  /**
   * §7.3's revoked-permission shelf, which shares the same fold.
   *
   * A notice that names a withdrawn grant is only worth anything if the user reads
   * it, and "the recording stopped and nobody was told why" is the same defect this
   * gate was built for — measured the same way, in pixels, rather than by asserting
   * that a `<p>` exists.
   */
  revokedVisiblePx: number;
  revokedText: string;
  revokedHidden: boolean;
  revokedOnTop: boolean;
  /** The label on the shelf's own button — what the user presses to re-grant. */
  revokedButtonText: string;
  revokedButtonVisiblePx: number;
  /** The button the user would press right now — `Record screen` or `Stop`. */
  controlText: string;
  controlVisiblePx: number;
  controlOnTop: boolean;
  /** Total laid-out height. Larger than `innerHeight` means something is clipped. */
  documentHeight: number;
}

export interface HudReport {
  ok: boolean;
  error: string;
  /** Whether main's fit-to-notice wiring was installed for this run. */
  fitInstalled: boolean;
  probes: Probe[];
  logs: string[];
}
