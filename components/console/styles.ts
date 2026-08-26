import type { CSSProperties } from "react";

/**
 * The console's typographic and surface vocabulary.
 *
 * Written as style objects against the CSS custom properties in
 * `app/console.css` rather than as utility classes. The design specifies type
 * as whole `font` shorthands at 10, 11, 12 and 13 pixels with specific tracking
 * — expressing that as arbitrary-value utilities would restate the same four
 * numbers at every call site and make a drift impossible to spot.
 */

const MONO = "var(--font-mono)";
const UI = "var(--font-ui)";

export const type = {
  /** 13px prose. Anything a person or an agent wrote in sentences. */
  body: {
    color: "var(--text-secondary)",
    font: `400 13px/1.6 ${UI}`,
    margin: 0,
    textWrap: "pretty",
  },
  /** Machine output, paths, ids, counts. */
  code: {
    color: "var(--text-secondary)",
    font: `400 11px/1.65 ${MONO}`,
  },
  /** The one serif in the system: the question a composer asks. */
  display: {
    color: "var(--text-primary)",
    font: "400 26px/1.2 var(--font-serif)",
    letterSpacing: "-0.01em",
    margin: 0,
  },
  /** Uppercase mono section marker. The console's quietest voice. */
  eyebrow: {
    color: "var(--text-secondary)",
    font: `500 10px/1 ${MONO}`,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  /** Interface labels on rows and controls. */
  label: {
    color: "var(--text-primary)",
    font: `500 12px/1.3 ${UI}`,
  },
  /** Secondary mono detail hung off a label. */
  meta: {
    color: "var(--text-muted)",
    font: `400 10px/1 ${MONO}`,
  },
  /** Names: agents, runs, headings inside chrome. */
  title: {
    color: "var(--text-primary)",
    font: `500 13px/1.2 ${UI}`,
    letterSpacing: "-0.01em",
  },
} satisfies Record<string, CSSProperties>;

/** Figures that sit in a column and must not jitter as they count. */
export const tabular: CSSProperties = { fontVariantNumeric: "tabular-nums" };

export const truncate: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const card: CSSProperties = {
  background: "var(--bg-raised)",
  border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  overflow: "hidden",
};

export const hairline = "1px solid var(--border-hairline)";

export type Tone = "accent" | "danger" | "muted" | "success" | "warning";

const TONE_INK: Record<Tone, string> = {
  accent: "var(--accent-presence)",
  danger: "var(--color-danger)",
  muted: "var(--text-faint)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
};

export function toneInk(tone: Tone): string {
  return TONE_INK[tone];
}

/**
 * A status dot with a halo.
 *
 * The halo is what makes a 6px dot legible against the elevation ramp; without
 * it the running and idle states are the same smudge at a glance.
 */
export function dot(tone: Tone, size = 7): CSSProperties {
  const ink = toneInk(tone);
  return {
    background: ink,
    borderRadius: 999,
    boxShadow: `0 0 0 3px color-mix(in oklch, ${ink} 22%, transparent)`,
    flex: "none",
    height: size,
    width: size,
  };
}

/**
 * The tinted pill a status wears.
 *
 * Fill, border and ink are all mixed from one hue so a badge reads as one
 * object rather than a coloured word inside a grey chip.
 */
export function pill(tone: Tone): CSSProperties {
  const ink = toneInk(tone);
  return {
    alignItems: "center",
    background: `color-mix(in oklch, ${ink} 12%, transparent)`,
    border: `1px solid color-mix(in oklch, ${ink} 34%, var(--border-hairline))`,
    borderRadius: "var(--radius-pill)",
    color: ink,
    display: "inline-flex",
    font: `500 10px/1 ${MONO}`,
    gap: 6,
    height: 22,
    letterSpacing: "0.1em",
    padding: "0 9px",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
}

/**
 * The well an agent's initial sits in.
 *
 * Selected wells take the accent as a tint rather than a fill: a solid accent
 * under near-white ink measures about 2.6:1, which fails AA at this size.
 */
export function well(selected: boolean, size = 26): CSSProperties {
  return {
    alignItems: "center",
    background: selected
      ? "color-mix(in oklch, var(--accent-presence) 20%, transparent)"
      : "var(--bg-elevated)",
    border: `1px solid ${
      selected
        ? "color-mix(in oklch, var(--accent-presence) 45%, transparent)"
        : "var(--border-hairline)"
    }`,
    borderRadius: "var(--radius-control)",
    color: selected ? "var(--accent-presence)" : "var(--text-secondary)",
    display: "grid",
    flex: "none",
    font: `500 ${Math.round(size * 0.42)}px/1 ${MONO}`,
    height: size,
    justifyContent: "center",
    placeItems: "center",
    width: size,
  };
}
