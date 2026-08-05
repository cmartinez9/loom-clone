/**
 * The wire protocol between `loom-input-sampler` and this process.
 *
 * NDJSON on the helper's stdout, one object per line, discriminated on `k`. Nothing
 * here touches a filesystem or a child process; it is the part that can be tested
 * against a string.
 *
 * Timestamps on the wire are `tUs` — **absolute microseconds on the helper's
 * monotonic uptime clock**, not seconds into the recording. The helper has no idea a
 * recording exists; converting to the §2.5 `t` is `sampler.ts`'s job, against the
 * `t0Us` of `recording.json`'s clock. Keeping the conversion in one place is what
 * stops a ×1000 or an off-by-an-epoch from being spread across two languages.
 */

/** Bumped when a line shape changes incompatibly. Checked on `hello`. */
export const HELPER_PROTOCOL_VERSION = 1;

/**
 * Why clicks are not being captured.
 *
 * The first six come from the helper and are facts about macOS. The last three are
 * produced on this side, for the cases where the helper never got far enough to have
 * an opinion. Every one of them is a distinct thing to tell the user, which is the
 * point: phase 2 prompts for `accessibility-denied`, and would be wrong to prompt
 * for `helper-missing`.
 */
export const CLICK_UNAVAILABLE_REASONS = [
  /** Clicks were not asked for — the user declined Accessibility, or a caller opted out. */
  'not-requested',
  /** `AXIsProcessTrusted()` is false. The grant is manual and cannot be requested. */
  'accessibility-denied',
  /** Trusted, but `CGEventTapCreate` returned NULL. */
  'tap-create-failed',
  /**
   * Trusted, and `CGEventTapCreate` returned a port — which then reported itself
   * disabled. This is the silent failure the whole phase is built around: a tap that
   * looks created and never fires.
   */
  'tap-dead',
  /** The kernel disabled the tap because a callback took too long. */
  'tap-disabled-by-timeout',
  /** The tap was disabled by user input. */
  'tap-disabled-by-user-input',
  /** The helper binary is not where it should be. A build or packaging fault. */
  'helper-missing',
  /** The helper exited, crashed, or spoke a protocol this build does not know. */
  'helper-failed',
  /** The helper said something this build cannot map. Never inferred as "fine". */
  'unknown',
] as const;

export type ClickUnavailableReason = (typeof CLICK_UNAVAILABLE_REASONS)[number];

export function isClickUnavailableReason(value: unknown): value is ClickUnavailableReason {
  return (
    typeof value === 'string' && (CLICK_UNAVAILABLE_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Everything known about the click tap, right now.
 *
 * The three booleans are kept separate from `available` deliberately. `available` is
 * the summary a consumer acts on; `axTrusted`, `tapCreated` and `tapEnabled` are the
 * evidence, and phase 2 needs the evidence to decide *which* thing to say — "grant
 * Accessibility" and "you granted it, now relaunch" are different sentences and only
 * these three tell them apart.
 */
export interface ClickTapState {
  available: boolean;
  reason: ClickUnavailableReason | null;
  /** Whether clicks were asked for at all. */
  requested: boolean;
  axTrusted: boolean;
  tapCreated: boolean;
  tapEnabled: boolean;
}

export interface HelperDisplayInfo {
  display: number;
  /** Points. Cursor positions are normalized against this (§2.5). */
  logicalSize: [number, number];
  scaleFactor: number;
}

export interface HelperHelloLine {
  k: 'hello';
  version: number;
  pid: number;
  tUs: number;
  /** `CLOCK_MONOTONIC` at the same instant, so the two epochs can be related. */
  monotonicUs: number;
  hz: number;
  /** How many cursor shapes AppKit let the helper fingerprint. Zero means no names. */
  shapeNames: number;
}

export interface HelperStatusLine {
  k: 'status';
  tUs: number;
  clicks: ClickTapState;
}

export interface HelperCursorLine {
  k: 'cursor';
  tUs: number;
  x: number;
  y: number;
  /** Cursor-image id: a sha256, or `''` before the first shape sample lands. */
  c: string;
  m: number;
}

export interface HelperClickLine {
  k: 'click';
  tUs: number;
  e: 'down' | 'up';
  b: number;
  x: number;
  y: number;
  m: number;
}

export interface HelperCursorImageLine {
  k: 'cursorimg';
  /** sha256 of the bitmap and its geometry — also the `c` of every sample using it. */
  id: string;
  shape: string;
  /** Pixels within the bitmap, per `CursorImage.hotspot`. */
  hotspot: [number, number];
  size: [number, number];
  /** base64 PNG. */
  png: string;
}

export interface HelperDisplayLine extends HelperDisplayInfo {
  k: 'display';
  tUs: number;
}

export interface HelperHealthLine {
  k: 'health';
  tUs: number;
  samples: number;
  clicks: number;
  /** Lines the helper's bounded output buffer had to drop. Never silently zero. */
  dropped: number;
  axTrusted: boolean;
  tapCreated: boolean;
  tapEnabled: boolean;
}

export interface HelperByeLine {
  k: 'bye';
  tUs: number;
}

export interface HelperProbeLine {
  k: 'probe';
  version: number;
  tUs: number;
  pid: number;
  os: string;
  clicks: ClickTapState;
  display: HelperDisplayInfo;
}

export type HelperLine =
  | HelperHelloLine
  | HelperStatusLine
  | HelperCursorLine
  | HelperClickLine
  | HelperCursorImageLine
  | HelperDisplayLine
  | HelperHealthLine
  | HelperByeLine
  | HelperProbeLine;

// ---------------------------------------------------------------- parsing

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = num(value[0]);
  const b = num(value[1]);
  return a === null || b === null ? null : [a, b];
}

function parseClickTapState(value: unknown): ClickTapState | null {
  if (!isObject(value)) return null;
  const reason = value['reason'];
  return {
    available: value['available'] === true,
    // An unrecognised reason becomes `unknown`, never `null`. `null` means "clicks
    // are fine", and a build that quietly said that about a state it did not
    // understand is precisely the silent degradation this phase exists to prevent.
    reason:
      reason === null || reason === undefined
        ? value['available'] === true
          ? null
          : 'unknown'
        : isClickUnavailableReason(reason)
          ? reason
          : 'unknown',
    requested: value['requested'] === true,
    axTrusted: value['axTrusted'] === true,
    tapCreated: value['tapCreated'] === true,
    tapEnabled: value['tapEnabled'] === true,
  };
}

function parseDisplayInfo(value: unknown): HelperDisplayInfo | null {
  if (!isObject(value)) return null;
  const display = num(value['display']);
  const logicalSize = pair(value['logicalSize']);
  const scaleFactor = num(value['scaleFactor']);
  if (display === null || logicalSize === null || scaleFactor === null) return null;
  return { display, logicalSize, scaleFactor };
}

/**
 * Parse one NDJSON line, or return `null`.
 *
 * `null` means "this build does not understand the line", and every caller treats
 * that as something to count and report rather than skip — an unreadable line is
 * lost cursor data, and §2.5's whole argument for NDJSON is that loss is bounded and
 * visible rather than total and silent.
 */
export function parseHelperLine(line: string): HelperLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const tUs = num(parsed['tUs']) ?? 0;
  switch (parsed['k']) {
    case 'hello': {
      const version = num(parsed['version']);
      if (version === null) return null;
      return {
        k: 'hello',
        version,
        pid: num(parsed['pid']) ?? 0,
        tUs,
        monotonicUs: num(parsed['monotonicUs']) ?? 0,
        hz: num(parsed['hz']) ?? 0,
        shapeNames: num(parsed['shapeNames']) ?? 0,
      };
    }
    case 'status': {
      const clicks = parseClickTapState(parsed['clicks']);
      return clicks === null ? null : { k: 'status', tUs, clicks };
    }
    case 'cursor': {
      const x = num(parsed['x']);
      const y = num(parsed['y']);
      if (x === null || y === null) return null;
      const c = parsed['c'];
      return {
        k: 'cursor',
        tUs,
        x,
        y,
        c: typeof c === 'string' ? c : '',
        m: num(parsed['m']) ?? 0,
      };
    }
    case 'click': {
      const x = num(parsed['x']);
      const y = num(parsed['y']);
      const e = parsed['e'];
      if (x === null || y === null || (e !== 'down' && e !== 'up')) return null;
      return { k: 'click', tUs, e, b: num(parsed['b']) ?? 0, x, y, m: num(parsed['m']) ?? 0 };
    }
    case 'cursorimg': {
      const id = parsed['id'];
      const png = parsed['png'];
      const hotspot = pair(parsed['hotspot']);
      const size = pair(parsed['size']);
      // The id is used as a filename via `cursorImagePath`, which rejects anything
      // that is not a lowercase hex sha256. Checking it here means a malformed id is
      // a dropped line rather than a throw inside a write.
      if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return null;
      if (typeof png !== 'string' || hotspot === null || size === null) return null;
      const shape = parsed['shape'];
      return {
        k: 'cursorimg',
        id,
        shape: typeof shape === 'string' && shape.length > 0 ? shape : 'unknown',
        hotspot,
        size,
        png,
      };
    }
    case 'display': {
      const info = parseDisplayInfo(parsed);
      return info === null ? null : { k: 'display', tUs, ...info };
    }
    case 'health':
      return {
        k: 'health',
        tUs,
        samples: num(parsed['samples']) ?? 0,
        clicks: num(parsed['clicks']) ?? 0,
        dropped: num(parsed['dropped']) ?? 0,
        axTrusted: parsed['axTrusted'] === true,
        tapCreated: parsed['tapCreated'] === true,
        tapEnabled: parsed['tapEnabled'] === true,
      };
    case 'bye':
      return { k: 'bye', tUs };
    case 'probe': {
      const clicks = parseClickTapState(parsed['clicks']);
      const display = parseDisplayInfo(parsed['display']);
      if (clicks === null || display === null) return null;
      const os = parsed['os'];
      return {
        k: 'probe',
        version: num(parsed['version']) ?? 0,
        tUs,
        pid: num(parsed['pid']) ?? 0,
        os: typeof os === 'string' ? os : '',
        clicks,
        display,
      };
    }
    default:
      return null;
  }
}

/**
 * Reassemble NDJSON lines from stdout chunks.
 *
 * A pipe splits wherever it likes, and at 120 Hz a chunk boundary lands mid-line
 * constantly. Holding the tail until its newline arrives is the whole job.
 */
export class LineSplitter {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    // The last element is whatever followed the final newline — possibly ''.
    this.pending = lines.pop() ?? '';
    return lines;
  }

  /** Anything left when the stream ends. A torn final line is returned as-is. */
  flush(): string[] {
    const rest = this.pending;
    this.pending = '';
    return rest.length === 0 ? [] : [rest];
  }
}
