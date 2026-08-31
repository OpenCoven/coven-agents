import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 300;

type TeamRunsRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: TeamRunsRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().listTeamRuns(request, id);
}

export async function POST(
  request: Request,
  context: TeamRunsRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().createTeamRun(request, id);
}
