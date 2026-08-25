import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  MemoryAbuseStore,
  RedisAbuseStore,
  type RedisEvalExecutor,
  requireAbuseKeySecret,
} from "./store";

const FIXED_SECRET = "fixed-test-abuse-key-secret";
const KEY_PREFIX = "coven:abuse:v1:";

test("memory budgets deny the first request over the limit and reset at the exact window", async () => {
  const store = new MemoryAbuseStore();

  assert.deepEqual(await store.consume("chat:ip:a", 3, 60, 1000), {
    allowed: true,
    remaining: 2,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(await store.consume("chat:ip:a", 3, 60, 1000), {
    allowed: true,
    remaining: 1,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(await store.consume("chat:ip:a", 3, 60, 1000), {
    allowed: true,
    remaining: 0,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(await store.consume("chat:ip:a", 3, 60, 1000), {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(await store.consume("chat:ip:a", 3, 60, 61_000), {
    allowed: true,
    remaining: 2,
    retryAfterSeconds: 60,
  });
});

test("memory budgets keep subjects independent", async () => {
  const store = new MemoryAbuseStore();

  assert.equal(
    (await store.consume("chat:ip:first", 1, 60, 1000)).allowed,
    true
  );
  assert.equal(
    (await store.consume("chat:ip:first", 1, 60, 1000)).allowed,
    false
  );
  assert.deepEqual(await store.consume("chat:ip:second", 1, 60, 1000), {
    allowed: true,
    remaining: 0,
    retryAfterSeconds: 60,
  });
});

test("memory budgets preserve the first request TTL instead of extending it", async () => {
  const store = new MemoryAbuseStore();

  await store.consume("chat:ip:a", 10, 60, 1000);

  assert.deepEqual(await store.consume("chat:ip:a", 10, 60, 31_000), {
    allowed: true,
    remaining: 8,
    retryAfterSeconds: 30,
  });
  assert.deepEqual(await store.consume("chat:ip:a", 10, 60, 61_000), {
    allowed: true,
    remaining: 9,
    retryAfterSeconds: 60,
  });
});

test("100 parallel memory calls allow exactly the configured limit", async () => {
  const store = new MemoryAbuseStore();
  const results = await Promise.all(
    Array.from({ length: 100 }, () =>
      store.consume("chat:ip:parallel", 17, 60, 1000)
    )
  );

  assert.equal(results.filter((result) => result.allowed).length, 17);
  assert.equal(results.filter((result) => !result.allowed).length, 83);
});

test("Redis consumption uses one atomic script call and returns count plus TTL metadata", async () => {
  const executor = new RecordingExecutor([4, 42]);
  const store = new RedisAbuseStore(executor, FIXED_SECRET);

  assert.deepEqual(await store.consume("chat:ip:203.0.113.8", 10, 60), {
    allowed: true,
    remaining: 6,
    retryAfterSeconds: 42,
  });

  assert.equal(executor.calls.length, 1);
  const [call] = executor.calls;
  assert.deepEqual(call.options.arguments, ["60"]);
  assert.match(call.script, /redis\.call\("INCR", KEYS\[1\]\)/);
  assert.match(call.script, /if count == 1 then/);
  assert.match(call.script, /redis\.call\("EXPIRE", KEYS\[1\], ARGV\[1\]\)/);
  assert.match(call.script, /redis\.call\("TTL", KEYS\[1\]\)/);
  assert.match(call.script, /return \{ count, ttl \}/);
});

test("Redis keys are deterministic fixed-width pseudonyms without raw subjects", async () => {
  const executor = new RecordingExecutor([1, 60]);
  const store = new RedisAbuseStore(executor, FIXED_SECRET);
  const rawSubject = "chat:ip:203.0.113.8";

  await store.consume(rawSubject, 10, 60);
  await store.consume(rawSubject, 10, 60);
  await store.consume("chat:ip:203.0.113.9", 10, 60);

  const expectedDigest = createHmac("sha256", FIXED_SECRET)
    .update(rawSubject)
    .digest("hex");
  const keys = executor.calls.map((call) => call.options.keys[0]);

  assert.equal(keys[0], `${KEY_PREFIX}${expectedDigest}`);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.match(keys[0], /^coven:abuse:v1:[a-f0-9]{64}$/);
  assert.equal(keys[0].includes(rawSubject), false);
});

test("Redis consumption denies counts above the configured limit", async () => {
  const store = new RedisAbuseStore(
    new RecordingExecutor([11, 37]),
    FIXED_SECRET
  );

  assert.deepEqual(await store.consume("chat:ip:a", 10, 60), {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 37,
  });
});

test("invalid arguments fail before Redis evaluation", async () => {
  const executor = new RecordingExecutor([1, 60]);
  const store = new RedisAbuseStore(executor, FIXED_SECRET);
  const calls = [
    () => store.consume("", 1, 1),
    () => store.consume("   ", 1, 1),
    () => store.consume("key", 0, 1),
    () => store.consume("key", -1, 1),
    () => store.consume("key", 1.5, 1),
    () => store.consume("key", Number.POSITIVE_INFINITY, 1),
    () => store.consume("key", Number.NaN, 1),
    () => store.consume("key", 1, 0),
    () => store.consume("key", 1, -1),
    () => store.consume("key", 1, 1.5),
    () => store.consume("key", 1, Number.POSITIVE_INFINITY),
    () => store.consume("key", 1, Number.NaN),
  ];

  await Promise.all(
    calls.map((consume) => assert.rejects(consume, /positive integer|nonempty/))
  );

  assert.equal(executor.calls.length, 0);
});

test("invalid Redis count and TTL replies fail explicitly", async () => {
  const replies = [
    null,
    [],
    [1],
    [1, 60, 3],
    [0, 60],
    [-1, 60],
    [1.5, 60],
    [Number.NaN, 60],
    ["1", 60],
    [1, -1],
    [1, -2],
    [1, 1.5],
    [1, Number.NaN],
    [1, "60"],
  ];

  await Promise.all(
    replies.map((reply) => {
      const store = new RedisAbuseStore(
        new RecordingExecutor(reply),
        FIXED_SECRET
      );

      return assert.rejects(
        () => store.consume("chat:ip:a", 10, 60),
        /Invalid Redis abuse budget reply/
      );
    })
  );
});

test("a configured Redis URL requires a nonempty production HMAC secret", () => {
  assert.equal(requireAbuseKeySecret(undefined, undefined), undefined);
  assert.equal(
    requireAbuseKeySecret("redis://localhost:6379", FIXED_SECRET),
    FIXED_SECRET
  );

  for (const secret of [undefined, "", "   "]) {
    assert.throws(
      () => requireAbuseKeySecret("redis://localhost:6379", secret),
      /ABUSE_KEY_SECRET/
    );
  }
});

class RecordingExecutor implements RedisEvalExecutor {
  private readonly reply: unknown;

  readonly calls: {
    options: { arguments: string[]; keys: string[] };
    script: string;
  }[] = [];

  constructor(reply: unknown) {
    this.reply = reply;
  }

  eval(
    script: string,
    options: { arguments: string[]; keys: string[] }
  ): Promise<unknown> {
    this.calls.push({ options, script });
    return Promise.resolve(this.reply);
  }
}
