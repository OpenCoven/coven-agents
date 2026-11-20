import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

// Starting a sandbox desktop can take a few seconds; the same ceiling as the
// other runner routes keeps the metadata contract uniform.
export const maxDuration = 300;

type RunLiveViewRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RunLiveViewRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().getRunLiveView(request, id);
}
