"use client";

import { UsageLedger } from "@/components/billing/usage-ledger";
import { RUN_MINUTE_RESERVATION } from "@/lib/billing/limits";

/**
 * The account Usage tab. It renders the same ledger as the billing card and
 * the console, read from the endpoint admission counts against, so what a
 * person sees here is what the runner enforces.
 */
export function UsageMeter() {
  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-[15px]">Usage</h2>
        <p className="text-[13px] text-muted-foreground">
          Each run counts the minutes it actually runs, rounded up to the next
          minute. While a run is in progress, up to {RUN_MINUTE_RESERVATION}{" "}
          minutes are set aside and released when it ends.
        </p>
      </div>
      <UsageLedger enabled variant="panel" />
    </div>
  );
}
