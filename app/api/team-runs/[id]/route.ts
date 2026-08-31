import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 300;

type TeamRunRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: TeamRunRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().getTeamRun(request, id);
}
