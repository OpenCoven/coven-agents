import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export function POST(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().prewarmTenant(request);
}
