import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;

function reconcile(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().reconcile(request);
}

/**
 * Vercel cron can overlap or skip invocations and does not retry failures.
 * The production service uses a database lease; POST is the separate manual
 * recovery channel.
 */
export function GET(request: Request): Promise<Response> {
  return reconcile(request);
}

export function POST(request: Request): Promise<Response> {
  return reconcile(request);
}
