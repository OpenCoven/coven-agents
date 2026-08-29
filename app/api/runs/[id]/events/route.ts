import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;

type RunEventsRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RunEventsRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().getRunEvents(request, id);
}
