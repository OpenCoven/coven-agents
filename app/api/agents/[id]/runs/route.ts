import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;
export const runtime = "nodejs";

type AgentRunsRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: AgentRunsRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().listAgentRuns(request, id);
}

export async function POST(
  request: Request,
  context: AgentRunsRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().startAgentRun(request, id);
}
