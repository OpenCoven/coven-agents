import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return productionTeamHttpHandlers().listSkills(request);
}

export function POST(request: Request): Promise<Response> {
  return productionTeamHttpHandlers().createSkill(request);
}
