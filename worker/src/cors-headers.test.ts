import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CLIENT_HEADERS, corsHeaders } from "./http.js";

const clientSource = readFileSync(
  new URL("../../lib/agents/browser-transport.ts", import.meta.url),
  "utf8"
);

function allowed(origin: string) {
  const headers = corsHeaders(
    new Request("https://runner.test/api/agents", { headers: { origin } }),
    origin
  );

  return (headers.get("access-control-allow-headers") ?? "")
    .split(",")
    .map((entry) => entry.trim());
}

test("every header the client sends is allowed by CORS", () => {
  // The browser now uses same-origin routes, but the retained rollback Worker
  // must still accept every protocol header the dedicated transport uses.
  const sent = [...clientSource.matchAll(/"(x-[a-z-]+|last-event-id)":/g)].map(
    (match) => match[1]
  );

  assert.ok(sent.length > 0, "expected to find headers set by the client");

  const permitted = allowed("https://app.test");

  for (const header of sent) {
    assert.ok(
      permitted.includes(header),
      `client sends ${header} but CORS does not allow it`
    );
  }
});

test("the two-token pair is allowed together", () => {
  // Identity and the deployment gate travel on different headers, so allowing
  // one without the other blocks every authenticated request.
  const permitted = allowed("https://app.test");

  assert.ok(permitted.includes("authorization"));
  assert.ok(permitted.includes("x-runner-token"));
});

test("CLIENT_HEADERS is what gets advertised", () => {
  assert.deepEqual(allowed("https://app.test"), [...CLIENT_HEADERS]);
});
