import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export function GET(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().listAgents(request);
}

export function POST(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().createAgent(request);
}
