import { getSandbox } from "@cloudflare/sandbox";
import { getAgentByName } from "agents";
import type { AgentDirectory, YoloAgent } from "./agents";
import { createCloudRunner } from "./routes";

export { Sandbox } from "@cloudflare/sandbox";
export { AgentDirectory, YoloAgent } from "./agents";

/**
 * The entry point is now only a wiring layer. Routing, authorization, tenancy
 * and error shaping all live in `createCloudRunner`, which is testable without
 * a Worker runtime because every dependency is injected — the route tests
 * exercise it with plain objects.
 *
 * Keeping a second hand-written route table here was what let the two drift:
 * the runner had run, event and cancellation routes this file never exposed,
 * and this file had a harness-runtime check the runner never made.
 */
const runner = createCloudRunner<Env>({
  async diagnoseSandbox(environment) {
    const sandbox = getSandbox(environment.Sandbox, "deployment-diagnostic", {
      enableDefaultSession: false,
      sleepAfter: "30s",
    });
    const result = await sandbox.exec("printf coven-agents");
    return {
      exitCode: result.exitCode,
      ok: result.success && result.stdout === "coven-agents",
      output: result.stdout,
    };
  },
  getDirectory: (environment) =>
    getAgentByName<Env, AgentDirectory>(environment.AgentDirectory, "default"),
  getYoloAgent: (environment, agentId) =>
    getAgentByName<Env, YoloAgent>(environment.YoloAgent, agentId),
});

export default {
  fetch: (request: Request, environment: Env): Promise<Response> =>
    runner.fetch(request, environment),
} satisfies ExportedHandler<Env>;
