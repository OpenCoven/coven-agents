import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;

function inventory(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().inventoryResources(request);
}

/**
 * Read-only, bounded operator inventory. GET uses the reconciliation cron
 * credential and POST uses the manual reconciliation credential.
 */
export function GET(request: Request): Promise<Response> {
  return inventory(request);
}

export function POST(request: Request): Promise<Response> {
  return inventory(request);
}
