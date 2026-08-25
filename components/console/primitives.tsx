// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import type { RunStatus } from "@opencoven/agent-contracts";
import type { CSSProperties, ReactNode } from "react";
import {
  dot,
  pill,
  type Tone,
  type as type_,
} from "@/components/console/styles";

type ButtonVariant = "danger-ghost" | "ghost" | "primary" | "secondary";
type ButtonSize = "md" | "sm" | "xs";

const HEIGHTS: Record<ButtonSize, number> = { md: 34, sm: 30, xs: 24 };
const PADDING: Record<ButtonSize, number> = { md: 14, sm: 11, xs: 8 };
const FONT_SIZE: Record<ButtonSize, number> = { md: 13, sm: 12, xs: 11 };

function variantStyle(variant: ButtonVariant): CSSProperties {
  switch (variant) {
    case "primary":
      // Dark ink on the accent rather than the near-white the rest of the
      // console uses: white on this lavender measures ~2.6:1, the dark ink 5.7:1.
      return {
        background: "var(--accent-presence)",
        border: "1px solid var(--accent-presence)",
        color: "var(--accent-ink)",
        fontWeight: 600,
      };
    case "secondary":
      return {
        background: "var(--bg-raised)",
        border: "1px solid var(--border-hairline)",
        color: "var(--text-primary)",
      };
    case "danger-ghost":
      return {
        background: "transparent",
        border: "1px solid var(--danger-border)",
        color: "var(--danger-text)",
      };
    default:
      return {
        background: "transparent",
        border: "1px solid transparent",
        color: "var(--text-secondary)",
      };
  }
}

export function Btn({
  children,
  disabled,
  fullWidth,
  onClick,
  size = "sm",
  title,
  variant = "secondary",
}: {
  children: ReactNode;
  disabled?: boolean;
  fullWidth?: boolean;
  onClick?: () => void;
  size?: ButtonSize;
  title?: string;
  variant?: ButtonVariant;
}) {
  return (
    <button
      className="oc-tint"
      disabled={disabled}
      onClick={onClick}
      style={{
        alignItems: "center",
        borderRadius: "var(--radius-control)",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "inline-flex",
        flex: "none",
        font: `500 ${FONT_SIZE[size]}px/1 var(--font-ui)`,
        gap: 7,
        height: HEIGHTS[size],
        justifyContent: "center",
        opacity: disabled ? 0.45 : 1,
        padding: `0 ${PADDING[size]}px`,
        whiteSpace: "nowrap",
        width: fullWidth ? "100%" : undefined,
        ...variantStyle(variant),
      }}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

/** Uppercase mono section marker. */
export function Eyebrow({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return <span style={{ ...type_.eyebrow, ...style }}>{children}</span>;
}

const RUN_TONES: Record<RunStatus, Tone> = {
  cancelled: "muted",
  completed: "success",
  failed: "danger",
  queued: "muted",
  running: "warning",
};

const RUN_LABELS: Record<RunStatus, string> = {
  cancelled: "cancelled",
  completed: "closed",
  failed: "stopped",
  queued: "queued",
  running: "running",
};

export function statusTone(status: RunStatus): Tone {
  return RUN_TONES[status];
}

/** The pill that names where a run got to. */
export function LifecycleBadge({ status }: { status: RunStatus }) {
  return <span style={pill(RUN_TONES[status])}>{RUN_LABELS[status]}</span>;
}

export function StatusDot({
  label,
  size,
  tone,
}: {
  label: string;
  size?: number;
  tone: Tone;
}) {
  return (
    <span aria-label={label} role="img" style={dot(tone, size)} title={label} />
  );
}

/**
 * A disclosure chevron that rotates rather than swapping glyphs.
 *
 * Rotation is what tells a reader the closed and open states are the same
 * control; two different arrows read as two different buttons.
 */
export function Caret({
  open,
  size = 11,
  style,
}: {
  open: boolean;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        color: "var(--text-muted)",
        display: "grid",
        flex: "none",
        placeItems: "center",
        transform: open ? "none" : "rotate(-90deg)",
        transition: "transform var(--duration-fast) var(--ease-standard)",
        width: size + 3,
        ...style,
      }}
    >
      <svg fill="none" height={size} viewBox="0 0 12 12" width={size}>
        <path
          d="M2.5 4.5 6 8l3.5-3.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.4"
        />
      </svg>
    </span>
  );
}

/**
 * The account's picture.
 *
 * `avatarFor` returns the stored image when there is one and a seeded
 * identicon otherwise, so a signed-in account always has a face rather than an
 * initial derived from its email. Signed out there is no account to depict, so
 * the brand mark stands in — an initial taken from a fallback sentence is how
 * the rail ended up labelled "N" for "not signed in".
 */
export function AccountAvatar({
  size = 26,
  src,
}: {
  size?: number;
  src: string | null;
}) {
  if (!src) {
    return (
      <span
        aria-hidden="true"
        style={{
          alignItems: "center",
          color: "var(--text-muted)",
          display: "grid",
          fontSize: Math.round(size * 0.45),
          height: size,
          justifyContent: "center",
          placeItems: "center",
          width: size,
        }}
      >
        ◆
      </span>
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: a generated avatar is a data URI, which the image optimizer cannot process.
    <img
      alt=""
      height={size}
      src={src}
      style={{
        borderRadius: "inherit",
        display: "block",
        height: size,
        objectFit: "cover",
        width: size,
      }}
      width={size}
    />
  );
}

/** The spinner the console uses wherever something is genuinely in flight. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="oc-spin"
      style={{
        border:
          "2px solid color-mix(in oklch, var(--color-warning) 30%, transparent)",
        borderRadius: 999,
        borderTopColor: "var(--color-warning)",
        flex: "none",
        height: size,
        width: size,
      }}
    />
  );
}
