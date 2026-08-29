import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;

type StopRunRouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: StopRunRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().stopRun(request, id);
}
