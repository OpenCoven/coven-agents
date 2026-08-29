import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().getHarnesses(request);
}
