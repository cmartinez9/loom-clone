/**
 * Formatting for the values the Pressroom language sets in Martian Mono.
 *
 * These live in the design package rather than in a window because the *shape* of
 * a number is part of the design: timecode is `M:SS` / `H:MM:SS` with no leading
 * zero on the leading unit, sizes are three significant figures, and everything is
 * tabular so a column of them lines up.
 */

/** `4:12`, `1:02:33`. Rounds down, because a timecode names a frame you can seek to. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

/** `4:12` for a duration; an em dash when there is not one yet. */
export function formatDuration(seconds: number | null): string {
  return seconds === null ? '—' : formatTimecode(seconds);
}

/**
 * `1:47.20`, `1:02:33.05` — a timecode with hundredths, the form the editor mockup
 * sets a playhead readout in.
 *
 * The editor is the one surface where whole seconds are too coarse to be useful: a
 * trim handle and a scrub bar are both positioned to a fraction of a second, and a
 * readout that cannot express the difference makes two distinct positions look
 * identical. Everywhere else — the library, the recorder's timer — reads
 * {@link formatTimecode}, because there a jittering hundredths column is noise.
 *
 * Rounds **down**, like {@link formatTimecode} and for the same reason: a timecode
 * names an instant you can seek to, and rounding up names one past it.
 */
export function formatTimecodeCentis(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const centis = Math.floor(seconds * 100) % 100;
  return `${formatTimecode(seconds)}.${String(centis).padStart(2, '0')}`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * `2.7 GB`, `184 MB`, `912 KB`.
 *
 * Decimal units, because that is what Finder shows and this app sits next to
 * Finder in the user's head.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${String(Math.round(bytes))} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit] as string}`;
}

/**
 * `Today 14:32`, `Yesterday 09:04`, `4 Aug 14:32`, `4 Aug 2025`.
 *
 * A recorder's library is read as "what did I make, and when" — the relative form
 * is the one that answers that without arithmetic.
 */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
    return `${day} ${time}`;
  }
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
