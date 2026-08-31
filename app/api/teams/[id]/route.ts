import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 300;

type TeamRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: TeamRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().getTeam(request, id);
}

export async function PUT(
  request: Request,
  context: TeamRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().updateTeam(request, id);
}

export async function DELETE(
  request: Request,
  context: TeamRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().deleteTeam(request, id);
}
