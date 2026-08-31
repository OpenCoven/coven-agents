import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 300;

type TeamRunStopRouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: TeamRunStopRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().stopTeamRun(request, id);
}
