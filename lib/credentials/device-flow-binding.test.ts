import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeviceFlowBinding,
  verifyDeviceFlowBinding,
} from "./device-flow-binding";

const SECRET = "device-flow-binding-test-secret";
const USER_A = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const USER_B = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";
const DEVICE_CODE = "github-device-code";

test("device flow bindings authorize only the initiating user and code", async () => {
  const binding = await createDeviceFlowBinding(SECRET, USER_A, DEVICE_CODE);

  assert.equal(
    await verifyDeviceFlowBinding(SECRET, USER_A, DEVICE_CODE, binding),
    true
  );
  assert.equal(
    await verifyDeviceFlowBinding(SECRET, USER_B, DEVICE_CODE, binding),
    false
  );
  assert.equal(
    await verifyDeviceFlowBinding(SECRET, USER_A, "other-code", binding),
    false
  );
  assert.equal(
    await verifyDeviceFlowBinding(SECRET, USER_A, DEVICE_CODE, `${binding}x`),
    false
  );
});
