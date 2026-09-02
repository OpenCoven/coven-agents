import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("completed GitHub callback state can only advance its own durable response", async () => {
  const source = await readFile(
    new URL("./queries.ts", import.meta.url),
    "utf8"
  );
  const storeStart = source.indexOf(
    "export const databaseIdempotencyStore: IdempotencyStore"
  );
  assert.ok(storeStart >= 0, "database idempotency store must exist");
  const start = source.indexOf("async replaceCompleted(", storeStart);
  assert.ok(start >= 0, "database idempotency store must replace completion");
  const block = source.slice(start, source.indexOf("\n  },", start) + 5);

  assert.match(block, /\.update\(idempotencyRecord\)/u);
  assert.match(block, /eq\(idempotencyRecord\.id,\s*input\.claim\.recordId\)/u);
  assert.match(
    block,
    /eq\(idempotencyRecord\.ownerId,\s*input\.claim\.ownerId\)/u
  );
  assert.match(
    block,
    /eq\(idempotencyRecord\.operation,\s*input\.claim\.operation\)/u
  );
  assert.match(
    block,
    /eq\(idempotencyRecord\.keyHash,\s*input\.claim\.keyHash\)/u
  );
  assert.match(block, /eq\(idempotencyRecord\.state,\s*"completed"\)/u);
  assert.match(block, /storedIdempotencyClaimHash\(input\.claim\)/u);
});
