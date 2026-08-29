import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;

type RunRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RunRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().getRun(request, id);
}
