"use client";

import { useEffect, useMemo, useState } from "react";
import { browserApplicationPath } from "@/lib/application-path";
import { MONTHLY_MINUTE_CAP } from "@/lib/billing/limits";

/**
 * The one usage ledger, shared by the billing card, the account Usage tab and
 * the console Usage tab. It reads `/api/usage`, the same endpoint admission
 * counts against, so the number a person sees is the number the runner
 * enforces. Three surfaces, one component: they cannot drift from each other.
 */

export type UsageSnapshot = {
  allowance: number;
  cap: number;
  globalAdmissionClosed: boolean;
  packMinutes: number;
  remaining: number;
  resetsAt: Date | null;
  /**
   * Which entitlement these minutes come from. It changes the words, not just
   * the numbers: a subscription bucket renews every month, a beta grant
   * expires once and never comes back. Telling a participant their minutes
   * "renew" would be a promise nothing in the system intends to keep.
   */
  source: "campaign" | "subscription";
  used: number;
};

export type UsageStatus = "loading" | "locked" | "ready" | "unavailable";

/** Fraction of the allowance at which the ledger starts warning. */
export const USAGE_WARNING_RATIO = 0.8;
const PACK_CREDIT_POLL_MS = 5000;
const PACK_CREDIT_POLL_LIMIT = 24;
const MS_PER_DAY = 86_400_000;

function parseUsage(value: unknown): UsageSnapshot | null {
  if (!(value && typeof value === "object")) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const cap = typeof body.cap === "number" ? body.cap : null;
  const used = typeof body.used === "number" ? body.used : null;
  if (cap === null || used === null || cap <= 0 || used < 0) {
    return null;
  }
  const packMinutes =
    typeof body.packMinutes === "number" && body.packMinutes > 0
      ? body.packMinutes
      : 0;
  const allowance =
    typeof body.allowance === "number" && body.allowance >= cap
      ? body.allowance
      : cap + packMinutes;
  const resetsAt =
    typeof body.resetsAt === "string" ? new Date(body.resetsAt) : null;
  return {
    allowance,
    cap,
    globalAdmissionClosed: body.globalAdmissionClosed === true,
    packMinutes,
    remaining: Math.max(0, allowance - used),
    resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null,
    source: body.source === "campaign" ? "campaign" : "subscription",
    used,
  };
}

/**
 * Loads usage once, and, while a top-up credit is expected, keeps polling
 * until the pack minutes grow or a bounded number of tries runs out. A
 * Stripe webhook usually lands within seconds; two minutes covers a slow one
 * without leaving a poll running forever.
 */
export function useUsage(input: {
  enabled: boolean;
  watchPackCredit?: boolean;
}): {
  packCredited: boolean;
  status: UsageStatus;
  usage: UsageSnapshot | null;
} {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [status, setStatus] = useState<UsageStatus>(
    input.enabled ? "loading" : "locked"
  );
  const [packCredited, setPackCredited] = useState(false);

  useEffect(() => {
    if (!input.enabled) {
      setStatus("locked");
      setUsage(null);
      return;
    }
    const controller = new AbortController();
    let baselinePacks: number | null = null;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      let response: Response;
      try {
        response = await fetch(browserApplicationPath("/api/usage"), {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
      } catch {
        if (!controller.signal.aborted) {
          setStatus("unavailable");
        }
        return;
      }
      if (controller.signal.aborted) {
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setStatus("locked");
        return;
      }
      let decoded: unknown = null;
      try {
        decoded = response.ok ? await response.json() : null;
      } catch {
        decoded = null;
      }
      const next = parseUsage(decoded);
      if (!next) {
        setStatus("unavailable");
        return;
      }
      setUsage(next);
      setStatus("ready");
      if (!input.watchPackCredit) {
        return;
      }
      if (baselinePacks === null) {
        baselinePacks = next.packMinutes;
      } else if (next.packMinutes > baselinePacks) {
        setPackCredited(true);
        return;
      }
      polls += 1;
      if (polls < PACK_CREDIT_POLL_LIMIT) {
        timer = setTimeout(() => {
          load().catch(() => undefined);
        }, PACK_CREDIT_POLL_MS);
      }
    };
    load().catch(() => undefined);

    return () => {
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [input.enabled, input.watchPackCredit]);

  return { packCredited, status, usage };
}

export function daysUntil(date: Date | null, now = new Date()): number | null {
  if (!date) {
    return null;
  }
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / MS_PER_DAY));
}

export function longDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(date);
}

export type UsageLedgerProps = {
  /** Whether this session may read usage. Guests see the plan, not a meter. */
  enabled: boolean;
  /** `card` sits beside the plan copy; `panel` is the full Usage tab. */
  variant: "card" | "panel";
  /** Set while a top-up payment is expected to land. */
  watchPackCredit?: boolean;
  onPackCredited?: () => void;
};

/**
 * Minutes used against the allowance, with the renewal date and the state
 * a person needs to act on: nearly out, out, or paused platform-wide.
 */
export function UsageLedger({
  enabled,
  onPackCredited,
  variant,
  watchPackCredit = false,
}: UsageLedgerProps) {
  const { packCredited, status, usage } = useUsage({
    enabled,
    watchPackCredit,
  });

  useEffect(() => {
    if (packCredited) {
      onPackCredited?.();
    }
  }, [onPackCredited, packCredited]);

  const state = useMemo(() => {
    if (!usage) {
      return "ok" as const;
    }
    if (usage.globalAdmissionClosed) {
      return "paused" as const;
    }
    if (usage.remaining === 0) {
      return "full" as const;
    }
    if (usage.used >= usage.allowance * USAGE_WARNING_RATIO) {
      return "warning" as const;
    }
    return "ok" as const;
  }, [usage]);

  if (status === "locked") {
    return (
      <div
        aria-label={`Monthly allowance: ${MONTHLY_MINUTE_CAP} minutes of agent run time`}
        className="oc-usage-ledger"
        data-variant={variant}
        role="img"
      >
        <div className="oc-usage-ledger__heading">
          <span>Run time included</span>
          <span>Monthly</span>
        </div>
        <div className="oc-usage-ledger__value">
          <strong>{MONTHLY_MINUTE_CAP}</strong>
          <span>minutes each month</span>
        </div>
        <div
          aria-hidden="true"
          className="oc-usage-ledger__bar"
          data-state="ok"
        />
        <p className="oc-usage-ledger__meta">
          Usage appears here once a subscription is active.
        </p>
      </div>
    );
  }

  if (status === "loading" || !usage) {
    return (
      <div
        aria-busy={status === "loading"}
        className="oc-usage-ledger"
        data-variant={variant}
      >
        <div className="oc-usage-ledger__heading">
          <span>Run time this month</span>
          <span>{status === "loading" ? "Loading" : "Unavailable"}</span>
        </div>
        <div className="oc-usage-ledger__value">
          <strong aria-hidden="true" className="oc-usage-ledger__placeholder">
            —
          </strong>
          <span>of {MONTHLY_MINUTE_CAP} minutes</span>
        </div>
        <div
          aria-hidden="true"
          className="oc-usage-ledger__bar"
          data-state="ok"
        />
        <p className="oc-usage-ledger__meta">
          {status === "loading"
            ? "Reading this month's usage."
            : "Usage could not be read right now. Runs still count against the same allowance."}
        </p>
      </div>
    );
  }

  const pct = Math.min(100, Math.round((usage.used / usage.allowance) * 100));
  const days = daysUntil(usage.resetsAt);
  const renews = usage.resetsAt ? longDate(usage.resetsAt) : null;
  const campaign = usage.source === "campaign";
  const message =
    state === "paused"
      ? "Runs are paused platform-wide right now. Your minutes are not affected."
      : state === "full"
        ? campaign
          ? "Beta minutes used up. Subscribe to keep running agents."
          : `Monthly minutes used up.${renews ? ` New runs start again on ${renews}` : " New runs start again next period"}, or right away after a top-up.`
        : state === "warning"
          ? campaign
            ? `About ${usage.remaining} beta minutes left.`
            : `About ${usage.remaining} minutes left this month.`
          : null;

  return (
    <div className="oc-usage-ledger" data-state={state} data-variant={variant}>
      <div className="oc-usage-ledger__heading">
        <span>{campaign ? "Beta run time" : "Run time this month"}</span>
        {renews ? (
          <span>
            {campaign ? "Expires" : "Renews"}{" "}
            <time dateTime={usage.resetsAt?.toISOString()}>{renews}</time>
            {days !== null && days <= 45 ? ` · ${days}d` : ""}
          </span>
        ) : (
          <span>{campaign ? "Open beta" : "Monthly"}</span>
        )}
      </div>
      <div className="oc-usage-ledger__value">
        <strong>{usage.used}</strong>
        <span>of {usage.allowance} minutes</span>
      </div>
      <div
        aria-label={campaign ? "Beta minutes used" : "Minutes used this month"}
        aria-valuemax={usage.allowance}
        aria-valuemin={0}
        aria-valuenow={usage.used}
        aria-valuetext={`${usage.used} of ${usage.allowance} minutes, ${pct} percent`}
        className="oc-usage-ledger__bar"
        data-state={state}
        role="progressbar"
      >
        <span style={{ width: `${pct}%` }} />
        {usage.packMinutes > 0 ? (
          <i
            aria-hidden="true"
            className="oc-usage-ledger__bar-divider"
            style={{
              left: `${Math.min(100, (usage.cap / usage.allowance) * 100)}%`,
            }}
            title={`Monthly ${usage.cap} ends here; top-up minutes follow`}
          />
        ) : null}
      </div>
      <p className="oc-usage-ledger__meta">
        <span>{usage.remaining} minutes left</span>
        {usage.packMinutes > 0 ? (
          <span>{usage.packMinutes} from top-ups</span>
        ) : null}
        <span>{pct}% used</span>
      </p>
      {message ? (
        <p className="oc-usage-ledger__message" role="status">
          {message}
        </p>
      ) : null}
      {variant === "panel" ? (
        <dl className="oc-usage-ledger__stats">
          <div>
            <dt>Used</dt>
            <dd>{usage.used}</dd>
          </div>
          <div>
            <dt>Left</dt>
            <dd>{usage.remaining}</dd>
          </div>
          <div>
            <dt>Monthly</dt>
            <dd>{usage.cap}</dd>
          </div>
          <div>
            <dt>Top-ups</dt>
            <dd>{usage.packMinutes}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
