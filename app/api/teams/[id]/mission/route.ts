import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 60;

type TeamMissionRouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: TeamMissionRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().draftTeamMission(request, id);
}
