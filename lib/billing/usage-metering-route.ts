import { readBoundedBytes } from "@/lib/abuse/body";
import {
  type AbuseAdmission,
  type AbuseEnforcementInput,
  abuseAdmissionResponse,
} from "@/lib/abuse/enforce";
import {
  UsageMeteringProviderUnauthorizedError,
  type UsageMeteringResult,
} from "./usage-metering";

export type UsageMeteringRouteDependencies<Provider = unknown> = {
  authorize: (request: Request) => "allowed" | "unavailable" | "unauthorized";
  createProvider: (apiKey: string) => Provider;
  enforceAbuse: (
    input: Pick<AbuseEnforcementInput, "ip" | "route">
  ) => Promise<AbuseAdmission>;
  getConfig: () => { apiKey: string; eventName: string } | null;
  meter: (input: {
    eventName: string;
    provider: Provider;
  }) => Promise<UsageMeteringResult>;
};

/**
 * The scheduled usage-reporting endpoint accepts neither a subscriber session
 * nor a body. Its response deliberately contains only aggregate counts: no
 * run ids, tenants, or Stripe identifiers leave the server.
 */
export async function usageMeteringResponse<Provider>(
  request: Request,
  dependencies: UsageMeteringRouteDependencies<Provider>,
  sourceIp: string | null
): Promise<Response> {
  let admission: AbuseAdmission;
  try {
    admission = await dependencies.enforceAbuse({
      ip: sourceIp,
      route: "stripe_usage",
    });
  } catch {
    return unavailableResponse();
  }
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  let authorization: ReturnType<
    UsageMeteringRouteDependencies<Provider>["authorize"]
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
            ? "usage_unavailable"
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

  let config: { apiKey: string; eventName: string } | null;
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
    const aggregate = meteringAggregate(
      await dependencies.meter({ eventName: config.eventName, provider })
    );
    return aggregate ? Response.json(aggregate) : unavailableResponse();
  } catch (error) {
    if (error instanceof UsageMeteringProviderUnauthorizedError) {
      return Response.json(
        { error: "billing_provider_unauthorized" },
        { status: 503 }
      );
    }
    return unavailableResponse();
  }
}

function meteringAggregate(
  result: UsageMeteringResult
): UsageMeteringResult | null {
  if (
    !["batch_limit", "drained", "provider_failure"].includes(result.stopped) ||
    ![
      result.batches,
      result.noCustomer,
      result.notBillable,
      result.reported,
      result.scanned,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    return null;
  }
  return {
    batches: result.batches,
    noCustomer: result.noCustomer,
    notBillable: result.notBillable,
    reported: result.reported,
    scanned: result.scanned,
    stopped: result.stopped,
  };
}

function unavailableResponse(): Response {
  return Response.json({ error: "usage_unavailable" }, { status: 503 });
}
