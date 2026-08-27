import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:8788";
const token = execFileSync("node", [
  new URL("./mint.mjs", import.meta.url).pathname,
]).toString();
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-runner-token": "local-harness-control-token",
};
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const agentResponse = await fetch(`${BASE}/api/agents`, {
  body: JSON.stringify({
    backend: "cloud",
    instructions:
      "You are a smoke-test agent. Answer in one short sentence and stop.",
    model: "auto",
    name: "HarnessScout",
    runtime: "copilot",
  }),
  headers,
  method: "POST",
});
const agentBody = await agentResponse.json();
if (!agentResponse.ok) {
  console.log(
    stamp(),
    "agent create FAILED",
    agentResponse.status,
    JSON.stringify(agentBody)
  );
  process.exit(1);
}
const agentId = agentBody.agent.id;
console.log(stamp(), "agent created", agentId);

const runResponse = await fetch(`${BASE}/api/agents/${agentId}/runs`, {
  body: JSON.stringify({
    operationId: randomUUID(),
    task: "Say hello in one sentence, then finish.",
  }),
  headers,
  method: "POST",
});
const runBody = await runResponse.json();
if (!runResponse.ok) {
  console.log(
    stamp(),
    "run start FAILED",
    runResponse.status,
    JSON.stringify(runBody)
  );
  process.exit(1);
}
const runId = runBody.run.id;
console.log(stamp(), "run accepted", runId, runBody.run.status);

let lastStatus = runBody.run.status;
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  // biome-ignore lint/performance/noAwaitInLoops: a poll loop is sequential by definition.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const snapshotResponse = await fetch(`${BASE}/api/runs/${runId}`, {
    headers,
  });
  if (!snapshotResponse.ok) {
    console.log(stamp(), "snapshot read failed", snapshotResponse.status);
    continue;
  }
  const { run } = await snapshotResponse.json();
  if (run.status !== lastStatus) {
    console.log(stamp(), "status →", run.status);
    lastStatus = run.status;
  }
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    console.log(stamp(), "TERMINAL", run.status);
    console.log("output:", JSON.stringify(run.output).slice(0, 400));
    if (run.error) {
      console.log("error:", JSON.stringify(run.error));
    }
    console.log(
      "evidence commands:",
      run.commandEvidence.length,
      "files:",
      run.fileEvidence.length
    );
    process.exit(run.status === "completed" ? 0 : 2);
  }
}
console.log(stamp(), "DRIVER TIMEOUT — run still", lastStatus);
process.exit(3);
