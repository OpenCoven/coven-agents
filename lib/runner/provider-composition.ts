import "server-only";

import type {
  ProductionDatabasePrincipal,
  ProductionRunnerRuntimeDependencies,
} from "./runtime";
import type { RunnerService } from "./service";

/**
 * Provider selection remains server-only. The product runtime uses this seam
 * so it never imports a hosted-provider SDK or adapter implementation.
 */
export async function createHostedRunnerService(
  principal: ProductionDatabasePrincipal,
  dependencies: ProductionRunnerRuntimeDependencies
): Promise<RunnerService> {
  const provider = await import("./daytona/composition");
  return provider.createDaytonaRunnerServiceForPrincipal(
    principal,
    dependencies
  );
}
