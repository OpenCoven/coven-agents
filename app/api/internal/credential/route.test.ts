import assert from "node:assert/strict";
import test from "node:test";
import { authorizeInternalRequest } from "./route";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/internal/credential", {
    headers,
    method: "POST",
  });
}

test("a request without the service token is refused", () => {
  assert.equal(authorizeInternalRequest(request(), "service-secret"), false);
});

test("a browser session cannot substitute for the service token", () => {
  // The whole point: a credential must not be reachable from a browser, so a
  // valid user session must not be sufficient here.
  assert.equal(
    authorizeInternalRequest(
      request({ cookie: "authjs.session-token=a-valid-looking-session" }),
      "service-secret"
    ),
    false
  );
});

test("the matching service token is accepted", () => {
  assert.equal(
    authorizeInternalRequest(
      request({ "x-service-token": "service-secret" }),
      "service-secret"
    ),
    true
  );
});

test("an unconfigured service token never authorizes", () => {
  // A deployment that forgot to set the secret must refuse everything rather
  // than accept everything, including a request that also sends nothing.
  assert.equal(
    authorizeInternalRequest(request({ "x-service-token": "" }), ""),
    false
  );
  assert.equal(authorizeInternalRequest(request(), ""), false);
});

test("a token of the wrong length is refused without comparing content", () => {
  assert.equal(
    authorizeInternalRequest(
      request({ "x-service-token": "short" }),
      "service-secret"
    ),
    false
  );
});
