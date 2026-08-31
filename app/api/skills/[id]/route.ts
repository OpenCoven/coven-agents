import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 300;

type SkillRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: SkillRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().getSkill(request, id);
}

export async function PUT(
  request: Request,
  context: SkillRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().updateSkill(request, id);
}

export async function DELETE(
  request: Request,
  context: SkillRouteContext
): Promise<Response> {
  const { id } = await context.params;
  return productionTeamHttpHandlers().deleteSkill(request, id);
}
