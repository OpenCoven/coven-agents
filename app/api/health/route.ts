import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export function GET(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().health(request);
}
