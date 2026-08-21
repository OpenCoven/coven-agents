import { getSandbox } from "@cloudflare/sandbox";
import { getAgentByName } from "agents";
import type { AgentDirectory, YoloAgent } from "./agents.js";
import { createCloudRunner } from "./routes.js";

export { Sandbox } from "@cloudflare/sandbox";
export { AgentDirectory, YoloAgent } from "./agents.js";

export default createCloudRunner<Env>({
  async diagnoseSandbox(env) {
    const sandbox = getSandbox(env.Sandbox, "deployment-diagnostic", {
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
  getDirectory: (env) =>
    getAgentByName<Env, AgentDirectory>(env.AgentDirectory, "default"),
  getYoloAgent: (env, agentId) =>
    getAgentByName<Env, YoloAgent>(env.YoloAgent, agentId),
}) satisfies ExportedHandler<Env>;
