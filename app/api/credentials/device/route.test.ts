import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const postHandler = source.slice(
  source.indexOf("export async function POST"),
  source.indexOf("export async function PUT")
);
const putHandler = source.slice(source.indexOf("export async function PUT"));

test("authorized device polls prepare encryption then use the atomic credential commit store", () => {
  assert.match(source, /prepareCredentialWrite/);
  assert.match(source, /databaseCredentialDevicePollStore/);
  assert.doesNotMatch(source, /\bputCredential\b/);
  assert.doesNotMatch(putHandler, /\bdatabaseIdempotencyStore\b/);
});

test("device polls prove the authenticated owner started the flow before exchange", () => {
  const verificationIndex = putHandler.indexOf("verifyDeviceFlowBinding(");
  const pollIndex = putHandler.indexOf("runCredentialDevicePoll({");
  const exchangeIndex = putHandler.indexOf("exchangeDeviceCode(");

  assert.match(source, /binding:\s*z\.string\(\)\.min\(1\)\.max\(128\)/);
  assert.ok(verificationIndex >= 0);
  assert.ok(pollIndex > verificationIndex);
  assert.ok(exchangeIndex > pollIndex);
});

test("device start and poll revalidate the original session authority before publishing", () => {
  const startIndex = postHandler.indexOf("startDeviceFlow(");
  const startRevalidationIndex = postHandler.lastIndexOf(
    "authorizeSubscriberAccess(session)"
  );

  assert.match(postHandler, /const session = await auth\(\)/);
  assert.ok(startIndex >= 0);
  assert.ok(startRevalidationIndex > startIndex);
  assert.match(putHandler, /revalidateAuthority:/);
  assert.match(putHandler, /authVersion:\s*access\.authVersion/);
});
