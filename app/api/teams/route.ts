import { productionTeamHttpHandlers } from "@/lib/teams/route-dependencies";

export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return productionTeamHttpHandlers().listTeams(request);
}

export function POST(request: Request): Promise<Response> {
  return productionTeamHttpHandlers().createTeam(request);
}
