import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;
export const runtime = "nodejs";

type AgentRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: AgentRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().getAgent(request, id);
}

export async function PUT(
  request: Request,
  context: AgentRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().updateAgent(request, id);
}

export async function DELETE(
  request: Request,
  context: AgentRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().deleteAgent(request, id);
}
