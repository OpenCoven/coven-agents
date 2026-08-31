import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 300;

type TeamRunApproveRouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: TeamRunApproveRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().approveTeamRun(request, id);
}
