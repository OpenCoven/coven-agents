import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export const maxDuration = 300;

/**
 * Manual-only, bounded repair for exact stopped mappings below configured
 * resource floors. The handler returns aggregate counts without identifiers.
 */
export function POST(request: Request): Promise<Response> {
  return productionRunnerHttpHandlers().repairResources(request);
}
