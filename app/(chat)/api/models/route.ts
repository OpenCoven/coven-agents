import { ipAddress } from "@vercel/functions";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { getAllGatewayModels, getCapabilities, isDemo } from "@/lib/ai/models";

export async function GET(request: Request) {
  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "model_list",
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const headers = {
    "Cache-Control": "public, max-age=86400, s-maxage=86400",
  };

  const curatedCapabilities = await getCapabilities();

  if (isDemo) {
    const models = await getAllGatewayModels();
    const capabilities = Object.fromEntries(
      models.map((m) => [m.id, curatedCapabilities[m.id] ?? m.capabilities])
    );

    return Response.json({ capabilities, models }, { headers });
  }

  return Response.json(curatedCapabilities, { headers });
}
