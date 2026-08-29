import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().reconcile(request);
}
