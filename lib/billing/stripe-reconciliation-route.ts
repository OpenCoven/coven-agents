import { readBoundedBytes } from "@/lib/abuse/body";
import {
  type AbuseAdmission,
  type AbuseEnforcementInput,
  abuseAdmissionResponse,
} from "@/lib/abuse/enforce";
import type { StripeReconciliationResult } from "./stripe-reconciliation";

export type StripeReconciliationRouteDependencies<Provider = unknown> = {
  authorize: (request: Request) => "allowed" | "unavailable" | "unauthorized";
  createProvider: (apiKey: string) => Provider;
  enforceAbuse: (
    input: Pick<AbuseEnforcementInput, "ip" | "route">
  ) => Promise<AbuseAdmission>;
  getConfig: () => { apiKey: string; priceId: string } | null;
  reconcile: (input: {
    priceId: string;
    provider: Provider;
  }) => Promise<StripeReconciliationResult>;
};

/**
 * The scheduled-machine endpoint accepts neither a subscriber session nor a
 * body. Its response deliberately contains only aggregate work counts.
 */
export async function stripeReconciliationResponse<Provider>(
  request: Request,
  dependencies: StripeReconciliationRouteDependencies<Provider>,
  sourceIp: string | null
): Promise<Response> {
  let admission: AbuseAdmission;
  try {
    admission = await dependencies.enforceAbuse({
      ip: sourceIp,
      route: "stripe_reconcile",
    });
  } catch {
    return unavailableResponse();
  }
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  let authorization: ReturnType<
    StripeReconciliationRouteDependencies<Provider>["authorize"]
  >;
  try {
    authorization = dependencies.authorize(request);
  } catch {
    return unavailableResponse();
  }
  if (authorization !== "allowed") {
    return Response.json(
      {
        error:
          authorization === "unavailable"
            ? "reconcile_unavailable"
            : "unauthorized",
      },
      { status: authorization === "unavailable" ? 503 : 401 }
    );
  }

  const body = await readBoundedBytes(request, 0);
  if (body.kind !== "ok" || body.value.byteLength !== 0) {
    return Response.json(
      {
        error:
          body.kind === "too_large" ? "empty_body_required" : "invalid_body",
      },
      { status: 400 }
    );
  }

  let config: { apiKey: string; priceId: string } | null;
  try {
    config = dependencies.getConfig();
  } catch {
    return unavailableResponse();
  }
  if (!config) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  let provider: Provider;
  try {
    provider = dependencies.createProvider(config.apiKey);
  } catch {
    return unavailableResponse();
  }
  try {
    const aggregate = reconciliationAggregate(
      await dependencies.reconcile({ priceId: config.priceId, provider })
    );
    return aggregate ? Response.json(aggregate) : unavailableResponse();
  } catch {
    return unavailableResponse();
  }
}

function reconciliationAggregate(
  result: StripeReconciliationResult
): StripeReconciliationResult | null {
  if (
    (result.execution !== "executed" && result.execution !== "skipped") ||
    ![
      result.applied,
      result.conflicts,
      result.deferred,
      result.failures,
      result.scanned,
      result.unchanged,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    return null;
  }
  return {
    applied: result.applied,
    conflicts: result.conflicts,
    deferred: result.deferred,
    execution: result.execution,
    failures: result.failures,
    scanned: result.scanned,
    unchanged: result.unchanged,
  };
}

function unavailableResponse(): Response {
  return Response.json({ error: "reconcile_unavailable" }, { status: 503 });
}
