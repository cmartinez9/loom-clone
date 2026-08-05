/**
 * Validation plumbing.
 *
 * Validators collect issues with a JSON-pointer-ish path rather than throwing on
 * the first problem, so a bad file produces one actionable message listing
 * everything wrong with it instead of n round-trips.
 */

export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `tracks[2].channels.amount.keys[3].t`. */
  path: string;
  message: string;
}

export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  /** Absolute path of the file that failed, when the caller knew it. */
  readonly file: string | undefined;

  constructor(what: string, issues: readonly ValidationIssue[], file?: string) {
    const where = file === undefined ? '' : `\n  file: ${file}`;
    const list = issues.map((i) => `\n  - ${i.path}: ${i.message}`).join('');
    super(`${what} is not valid${where}${list}`);
    this.name = 'ValidationError';
    this.issues = issues;
    this.file = file;
  }
}

/** Accumulates issues while walking a document. */
export class IssueSink {
  readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Require a plain object at `path`; report and return null when it is not. */
export function requireObject(
  sink: IssueSink,
  value: unknown,
  path: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    sink.add(path, `expected an object, got ${describe(value)}`);
    return null;
  }
  return value;
}

export function requireString(sink: IssueSink, value: unknown, path: string): string | null {
  if (typeof value !== 'string') {
    sink.add(path, `expected a string, got ${describe(value)}`);
    return null;
  }
  return value;
}

export function requireNumber(sink: IssueSink, value: unknown, path: string): number | null {
  if (!isFiniteNumber(value)) {
    sink.add(path, `expected a finite number, got ${describe(value)}`);
    return null;
  }
  return value;
}

export function requireBoolean(sink: IssueSink, value: unknown, path: string): boolean | null {
  if (typeof value !== 'boolean') {
    sink.add(path, `expected a boolean, got ${describe(value)}`);
    return null;
  }
  return value;
}

export function requireArray(sink: IssueSink, value: unknown, path: string): unknown[] | null {
  if (!Array.isArray(value)) {
    sink.add(path, `expected an array, got ${describe(value)}`);
    return null;
  }
  return value as unknown[];
}

export function requireEnum<T extends string>(
  sink: IssueSink,
  value: unknown,
  path: string,
  allowed: readonly T[],
): T | null {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    sink.add(path, `expected one of ${allowed.join(' | ')}, got ${describe(value)}`);
    return null;
  }
  return value as T;
}

/** `[number, number]` — used for sizes, positions and ranges throughout. */
export function requirePair(
  sink: IssueSink,
  value: unknown,
  path: string,
): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) {
    sink.add(path, `expected a two-element array, got ${describe(value)}`);
    return null;
  }
  const [a, b] = value as unknown[];
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) {
    sink.add(path, `expected two finite numbers, got ${describe(value)}`);
    return null;
  }
  return [a, b];
}

/** ISO-8601 with milliseconds and a `Z`, which is what every writer here emits. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function requireIsoTimestamp(sink: IssueSink, value: unknown, path: string): string | null {
  const s = requireString(sink, value, path);
  if (s === null) return null;
  if (!ISO.test(s) || Number.isNaN(Date.parse(s))) {
    sink.add(
      path,
      `expected an ISO-8601 UTC timestamp with milliseconds, got ${JSON.stringify(s)}`,
    );
    return null;
  }
  return s;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') return value.toString();
  // An object or a function. Its shape is what the caller wanted to know about,
  // and stringifying it would just say [object Object].
  return typeof value === 'function' ? 'a function' : 'an object';
}
