import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const admissionPath = fileURLToPath(new URL("./admission.ts", import.meta.url));

test("core admission cannot import Daytona process or sandbox modules", () => {
  const admission = readFileSync(admissionPath, "utf8");

  assert.doesNotMatch(
    admission,
    /from\s+["']\.\/daytona\/(?:process|sandbox)["']/u
  );
  assert.doesNotMatch(
    admission,
    /\b(?:DaytonaProcessSandbox|DaytonaStartedProcess|DaytonaProcessError|startDaytonaProcess|inspectRestrictedWorkspace|ensureDaytonaSandboxForDispatch)\b/u
  );
});
