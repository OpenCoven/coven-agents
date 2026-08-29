import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;
export const runtime = "nodejs";

function reconcile(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().reconcile(request);
}

export function GET(request: Request): Promise<Response> {
  return reconcile(request);
}

export function POST(request: Request): Promise<Response> {
  return reconcile(request);
}
