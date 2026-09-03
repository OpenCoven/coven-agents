"use client";

import { useEffect, useState } from "react";
import { browserApplicationPath } from "@/lib/application-path";

type Usage = {
  allowance?: number;
  cap: number;
  packMinutes?: number;
  resetsAt: string | null;
  used: number;
};

/**
 * Minutes spent against the cap.
 *
 * `/api/usage` existed from the moment the cap did, but nothing rendered it,
 * so the only way to see your own usage was a fetch typed into devtools. A cap
 * you cannot see is indistinguishable from a bug the first time it refuses a
 * run.
 *
 * Reads the same endpoint the enforcement point counts against, so the number
 * shown and the number enforced cannot drift.
 */
export function UsageMeter() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch(browserApplicationPath("/api/usage"))
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          return null;
        }
        return response.ok ? ((await response.json()) as Usage) : null;
      })
      .then((next) => {
        if (cancelled) {
          return;
        }
        if (next) {
          setUsage(next);
        } else {
          setLocked(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (locked || !usage) {
    return null;
  }

  const allowance = usage.allowance ?? usage.cap;
  const pct = Math.min(100, Math.round((usage.used / allowance) * 100));
  const resets = usage.resetsAt
    ? new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
      }).format(new Date(usage.resetsAt))
    : null;

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold text-[15px]">Usage</h2>
        <span className="text-[13px] text-muted-foreground">
          {usage.used} of {allowance} minutes
          {usage.packMinutes ? ` (${usage.packMinutes} from top-ups)` : ""}
        </span>
      </div>

      <div
        aria-label={`${usage.used} of ${allowance} minutes used`}
        aria-valuemax={allowance}
        aria-valuemin={0}
        aria-valuenow={usage.used}
        className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-[var(--oc-accent)] transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="text-[12px] text-muted-foreground">
        {resets
          ? `Resets ${resets}. A run holds its full time limit while it runs and settles to the minutes it used when it ends.`
          : "A run holds its full time limit while it runs and settles to the minutes it used when it ends."}
      </p>
    </div>
  );
}
