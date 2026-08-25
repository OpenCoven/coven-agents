"use client";

import { useSearchParams } from "next/navigation";

/**
 * The "Closed beta" line, shown when the proxy turned someone away.
 *
 * Its own component, and mounted inside a Suspense boundary, because
 * `useSearchParams` opts the whole route out of prerendering otherwise — the
 * login page is otherwise static.
 *
 * Without the marker the redirect would read as "your credentials were wrong"
 * rather than "you are not invited yet".
 */
export function BetaNotice() {
  if (useSearchParams().get("beta") !== "1") {
    return null;
  }

  return (
    <p className="mb-1 font-medium text-[11px] text-[var(--oc-accent)] uppercase tracking-[0.14em]">
      Closed beta
    </p>
  );
}
