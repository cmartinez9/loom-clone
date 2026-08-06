/**
 * Finding and probing the native helper.
 *
 * `probeInput()` is the API phase 2 drives: one call, no side effects, no prompt, and
 * a complete answer about what input capture can do right now. It is safe to call on
 * every launch and after the user comes back from System Settings.
 *
 * It deliberately cannot *request* anything. `AXIsProcessTrustedWithOptions` with the
 * prompt option is the only programmatic nudge macOS offers for Accessibility, and it
 * is a phase-2 decision when — and whether — to spend it.
 */

import { execFile } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseHelperLine,
  type ClickTapState,
  type HelperDisplayInfo,
  HELPER_PROTOCOL_VERSION,
} from './protocol.ts';

export const HELPER_BASENAME = 'loom-input-sampler';

/**
 * Overrides where the helper is found.
 *
 * The acceptance test uses this to point at a freshly built binary, and it is the
 * escape hatch if a packaged layout ever differs from `dist/`.
 */
export const HELPER_PATH_ENV = 'LOOM_INPUT_SAMPLER';

/**
 * Rewrite a path that points *into* the asar archive to the unpacked copy beside it.
 *
 * Electron patches `fs` so a read of `…/app.asar/x` transparently finds the file
 * inside the archive. `child_process.spawn` gets no such courtesy: it hands the
 * literal string to `uv_spawn`, which knows nothing about asar. So the helper that
 * `electron-builder.yml`'s `asarUnpack` puts in `app.asar.unpacked/` has to be *named*
 * where it actually sits, or every packaged install reports `helper-missing` about a
 * binary that shipped correctly.
 *
 * A no-op in development and in tests, where the segment is absent.
 */
export function unpackedHelperPath(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

/**
 * `dist/native/loom-input-sampler`, beside the JavaScript bundles.
 *
 * Main is bundled to `dist/main/index.cjs`, so at runtime this resolves the same way
 * in development and in a packaged app — which is the same reason there is no dev
 * server (CLAUDE.md, sharp edges). The one difference a package makes is the asar
 * archive, which {@link unpackedHelperPath} takes off the end.
 */
export function defaultHelperPath(): string {
  const override = process.env[HELPER_PATH_ENV];
  if (override !== undefined && override.length > 0) return override;
  // This module is bundled into `dist/main/index.cjs`, so `__dirname` is `dist/main`
  // and its sibling is `dist/native`. Running it unbundled — only tests do — has no
  // meaningful default, which is what the environment override is for.
  const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
  return unpackedHelperPath(resolve(here, '..', 'native', HELPER_BASENAME));
}

export interface InputProbe {
  /** False when the helper could not be run at all. */
  helperAvailable: boolean;
  helperPath: string;
  /** The protocol version the helper speaks, or 0 if it never answered. */
  protocolVersion: number;
  os: string;
  clicks: ClickTapState;
  display: HelperDisplayInfo | null;
  /**
   * The helper's own `CLOCK_UPTIME_RAW` microsecond, as it answered — the clock
   * every `tUs` on the wire is measured on, and therefore the clock an
   * `InputSampler`'s `t0Us` has to be expressed in.
   *
   * `null` when the helper did not answer at all. A helper that *did* answer but
   * carried no timestamp reads back as `0` instead: `parseHelperLine` coerces a
   * missing or non-finite `tUs` to `0`, and that coercion is shared by every line
   * kind on the wire, so narrowing it here would be a protocol change rather than a
   * tightening. **A caller must therefore refuse `0` as well as `null`** — a
   * recording that placed its cursor log at absolute uptime zero would carry
   * timestamps a month into the future, and `MAX_SOURCE_TIME_SEC` in `@loom/edl`
   * would silently drop every sample. With no usable reading, decline to sample
   * rather than guess one.
   *
   * A reading is only meaningful with the instant it was taken at on the caller's
   * own clock; `readHelperClock` in `apps/main/src/input-sampler.ts` is the pairing
   * this exists for, and it is where both refusals live.
   */
  tUs: number | null;
  /** Populated when the helper failed; empty otherwise. */
  problem: string;
}

export interface ProbeOptions {
  helperPath?: string;
  timeoutMs?: number;
}

function unavailable(
  helperPath: string,
  problem: string,
  reason: 'helper-missing' | 'helper-failed',
): InputProbe {
  return {
    helperAvailable: false,
    helperPath,
    protocolVersion: 0,
    os: '',
    clicks: {
      available: false,
      reason,
      requested: true,
      axTrusted: false,
      tapCreated: false,
      tapEnabled: false,
    },
    display: null,
    tUs: null,
    problem,
  };
}

/**
 * Ask macOS what input capture can do, without changing anything.
 *
 * A helper that is missing, hangs, or speaks a protocol this build does not know is
 * reported as `helperAvailable: false` with a `problem` — never as "clicks are
 * unavailable", which would send phase 2 to prompt for a permission that was not the
 * issue.
 */
export async function probeInput(options: ProbeOptions = {}): Promise<InputProbe> {
  const helperPath = options.helperPath ?? defaultHelperPath();
  const timeout = options.timeoutMs ?? 5000;

  let stdout: string;
  try {
    stdout = await new Promise<string>((fulfil, reject) => {
      execFile(helperPath, ['probe'], { timeout, encoding: 'utf8' }, (error: Error | null, out) => {
        if (error) reject(error);
        else fulfil(out);
      });
    });
  } catch (error) {
    return unavailable(helperPath, describe(error), 'helper-missing');
  }

  const line = stdout.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const parsed = parseHelperLine(line);
  if (parsed?.k !== 'probe') {
    return unavailable(
      helperPath,
      `unreadable probe output: ${line.slice(0, 200)}`,
      'helper-failed',
    );
  }
  if (parsed.version !== HELPER_PROTOCOL_VERSION) {
    return unavailable(
      helperPath,
      `helper speaks protocol ${parsed.version}, this build speaks ${HELPER_PROTOCOL_VERSION}`,
      'helper-failed',
    );
  }

  return {
    helperAvailable: true,
    helperPath,
    protocolVersion: parsed.version,
    os: parsed.os,
    clicks: parsed.clicks,
    display: parsed.display,
    tUs: parsed.tUs,
    problem: '',
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
