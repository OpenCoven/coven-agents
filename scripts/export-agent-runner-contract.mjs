import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exporter = resolve(
  root,
  "packages/agent-contracts/src/export-fixture.ts"
);
const result = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", exporter, ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
  }
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
