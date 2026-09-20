/**
 * Duration and clock formatting for the run console.
 *
 * The console prints durations in three places that must agree — the thread's
 * per-step badge, the steps timeline, and the wall clock — so the rule lives
 * here rather than being re-guessed at each call site.
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/**
 * Formats a span in milliseconds the way the record reads it.
 *
 * Under a minute keeps one decimal, because the difference between a 0.4s read
 * and a 2.4s read is the interesting part of a fast step. Past a minute the
 * decimal is noise, so it becomes `2m 24s` with the seconds zero-padded to keep
 * the column from shifting as it counts.
 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "—";
  }

  const totalSeconds = milliseconds / MS_PER_SECOND;

  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const whole = Math.floor(totalSeconds);

  if (whole < SECONDS_PER_HOUR) {
    const minutes = Math.floor(whole / SECONDS_PER_MINUTE);
    const seconds = whole % SECONDS_PER_MINUTE;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * Formats a position on the run's clock as `+m:ss`, the way a flight recorder
 * stamps a tape.
 *
 * Whole seconds only, and the seconds always zero-padded, because this reads
 * as a column down the left of the record and a shifting column stops being
 * a column. Past an hour it becomes `+h:mm:ss`.
 */
export function formatOffset(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "—";
  }
  const whole = Math.floor(milliseconds / MS_PER_SECOND);
  const seconds = String(whole % SECONDS_PER_MINUTE).padStart(2, "0");
  if (whole < SECONDS_PER_HOUR) {
    return `+${Math.floor(whole / SECONDS_PER_MINUTE)}:${seconds}`;
  }
  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = String(
    Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  ).padStart(2, "0");
  return `+${hours}:${minutes}:${seconds}`;
}

/** The span between two ISO timestamps, or null when either is missing. */
export function spanBetween(
  from: string | null | undefined,
  to: string | null | undefined
): number | null {
  if (!(from && to)) {
    return null;
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  return end - start;
}

/**
 * A relative age for the rail — "just now", "4m ago", "3d ago".
 *
 * Deliberately coarse. The rail is a place to find a run, not to measure one,
 * and a ticking second counter there would redraw the whole list every second.
 */
export function formatAge(iso: string | null, now: number): string {
  // `now` is required, and zero means the browser has not supplied a clock
  // yet. A default of `Date.now()` here would be read during render, which a
  // prerender evaluates once and bakes into the static output — every visitor
  // would then measure against whenever the page was built.
  if (!now) {
    return "—";
  }
  if (!iso) {
    return "never run";
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return "never run";
  }

  const seconds = Math.max(0, Math.round((now - at) / MS_PER_SECOND));
  if (seconds < 45) {
    return "just now";
  }

  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  if (minutes < SECONDS_PER_MINUTE) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / SECONDS_PER_MINUTE);
  const HOURS_PER_DAY = 24;
  if (hours < HOURS_PER_DAY) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / HOURS_PER_DAY)}d ago`;
}

/**
 * The initial the console draws in an agent's glyph well.
 *
 * Falls back to a diamond rather than an empty well, so a profile named with
 * punctuation alone still reads as an agent instead of a hole in the rail.
 */
export function glyphFor(name: string): string {
  const letter = /\p{L}|\p{N}/u.exec(name ?? "");
  return letter ? letter[0].toUpperCase() : "◆";
}

/**
 * Splits a path into its parent and leaf so the leaf can be inked brighter.
 *
 * The console shows a lot of paths and they are mostly prefix. Dimming the
 * directory is what makes a column of them scannable.
 */
export function splitPath(path: string): { dir: string; leaf: string } {
  const trimmed = (path ?? "").replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) {
    return { dir: "", leaf: trimmed };
  }
  return { dir: trimmed.slice(0, cut + 1), leaf: trimmed.slice(cut + 1) };
}
