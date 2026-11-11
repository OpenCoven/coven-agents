import { productionSandboxInspectionHandler } from "@/lib/runner/route-dependencies";

export const maxDuration = 60;

type SandboxInspectionRouteContext = { params: Promise<{ id: string }> };

/**
 * Read-only inspection of the one sandbox recorded for the caller's agent.
 * POST carries the expected sandbox ID in the body rather than the URL; the
 * handler performs no provider or database mutation.
 */
export async function POST(
  request: Request,
  context: SandboxInspectionRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionSandboxInspectionHandler()(request, id);
}
