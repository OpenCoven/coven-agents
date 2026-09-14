import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import postgres from "postgres";
import { HERMETIC_USERS, seedHermeticUsers } from "../tests/e2e/hermetic-db";
import {
  createDisposableDatabase,
  hermeticDatabaseUrl,
  migrateDisposableDatabase,
  withDisposableDatabase,
} from "./disposable-postgres";

const execute = promisify(execFile);

test("disposable URLs reject database startup overrides including duplicates and encoded keys", () => {
  for (const query of [
    "database=other",
    "database=",
    "database=expected&database=other",
    "database=other&database=",
    "%64atabase=other",
    "DATABASE=other",
    "dbname=other",
    "db=other",
    "application_name=coven%00database%00other",
    "application_name%00database=other",
  ]) {
    assert.throws(
      () => hermeticDatabaseUrl(`postgresql://localhost/expected?${query}`),
      /database selection|startup delimiter/u,
      query
    );
  }
  assert.throws(
    () =>
      hermeticDatabaseUrl(
        "postgresql://coven%00database%00other%00%00@localhost/expected"
      ),
    /startup delimiter/u
  );
});

test("ambiguous URLs cannot enter a supplied or sibling database callback or leak owned databases", {
  skip: !process.env.E2E_POSTGRES_URL,
}, async () => {
  const environment = { ...process.env, E2E_POSTGRES_DISPOSABLE: "1" };
  await withDisposableDatabase(environment, async (suppliedUrl) => {
    await withDisposableDatabase(environment, async (siblingUrl) => {
      const supplied = postgres(suppliedUrl, { max: 1 });
      const sibling = postgres(siblingUrl, { max: 1 });
      const siblingName = new URL(siblingUrl).pathname.slice(1);
      try {
        await supplied`CREATE TABLE ownership_probe (id integer PRIMARY KEY)`;
        await supplied`INSERT INTO ownership_probe VALUES (1)`;
        await sibling`CREATE TABLE ownership_probe (id integer PRIMARY KEY)`;
        await sibling`INSERT INTO ownership_probe VALUES (2)`;
        const before = await supplied<{ datname: string }[]>`
          SELECT datname FROM pg_database
          WHERE starts_with(datname, ${`coven_test_${process.pid}_`})
          ORDER BY datname
        `;
        for (const duplicate of [false, true]) {
          const ambiguous = new URL(suppliedUrl);
          if (duplicate) {
            ambiguous.searchParams.append(
              "database",
              new URL(suppliedUrl).pathname.slice(1)
            );
          }
          ambiguous.searchParams.append("database", siblingName);
          let called = false;
          // biome-ignore lint/performance/noAwaitInLoops: each URL shape must fail before its read-only callback can connect.
          await assert.rejects(
            withDisposableDatabase(
              { ...environment, E2E_POSTGRES_URL: ambiguous.toString() },
              async (url) => {
                called = true;
                const connection = postgres(url, { max: 1 });
                try {
                  const [row] = await connection<{ name: string }[]>`
                    SELECT current_database() AS name
                  `;
                  assert.equal(row.name, new URL(url).pathname.slice(1));
                } finally {
                  await connection.end();
                }
              }
            ),
            /database selection/u
          );
          assert.equal(called, false);
        }
        assert.deepEqual(
          [...(await supplied`SELECT id FROM ownership_probe`)],
          [{ id: 1 }]
        );
        assert.deepEqual(
          [...(await sibling`SELECT id FROM ownership_probe`)],
          [{ id: 2 }]
        );
        const after = await supplied`
          SELECT datname FROM pg_database
          WHERE starts_with(datname, ${`coven_test_${process.pid}_`})
          ORDER BY datname
        `;
        assert.deepEqual([...after], [...before]);
      } finally {
        await Promise.all([supplied.end(), sibling.end()]);
      }
    });
  });
});

test("disposable cleanup preserves both callback and cleanup failures", {
  skip: !process.env.E2E_POSTGRES_URL,
}, async () => {
  const external = process.env.E2E_POSTGRES_URL;
  assert.ok(external);
  const admin = postgres(external, { max: 1 });
  const callbackFailure = new Error("intentional callback failure");
  let ownedName = "";
  try {
    await assert.rejects(
      withDisposableDatabase(
        { ...process.env, E2E_POSTGRES_DISPOSABLE: "1" },
        async (url) => {
          ownedName = new URL(url).pathname.slice(1);
          assert.match(ownedName, /^coven_test_\d+_[a-f0-9]+$/u);
          // Removing our exact child makes the helper's subsequent DROP fail.
          await admin`DROP DATABASE ${admin(ownedName)} WITH (FORCE)`;
          throw callbackFailure;
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, callbackFailure);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0], callbackFailure);
        assert.ok(error.errors[1] instanceof postgres.PostgresError);
        assert.equal(error.errors[1].code, "3D000");
        return true;
      }
    );
    const remaining =
      await admin`SELECT datname FROM pg_database WHERE datname = ${ownedName}`;
    assert.equal(remaining.length, 0);
  } finally {
    await admin.end();
  }
});

test("migration gate refuses a missing URL in strict mode and warns otherwise", async () => {
  const env = { ...process.env, COVEN_HERMETIC_RUNNER: "1", POSTGRES_URL: "" };
  const warning = await execute("pnpm", ["exec", "tsx", "lib/db/migrate.ts"], {
    env,
  });
  assert.match(warning.stderr, /POSTGRES_URL.*skipping/u);
  await assert.rejects(
    execute("pnpm", ["exec", "tsx", "lib/db/migrate.ts", "--strict"], { env }),
    /POSTGRES_URL/u
  );
});

test("hermetic reseeding removes only fixture subscription audits before replacing users", {
  skip: !process.env.E2E_POSTGRES_URL,
}, async () => {
  await withDisposableDatabase(
    { ...process.env, E2E_POSTGRES_DISPOSABLE: "1" },
    async (url) => {
      await migrateDisposableDatabase(url, process.env);
      await seedHermeticUsers(url);
      const sql = postgres(url, { max: 1 });
      const foreignUser = "00000000-0000-4000-8000-000000000099";
      try {
        await sql`
            INSERT INTO "User" ("id", "email")
            VALUES (${foreignUser}, 'non-fixture@example.invalid')
          `;
        await sql`
            INSERT INTO "SubscriptionOverrideAudit"
              ("userId", "action", "previousAuthVersion", "newAuthVersion", "referenceDigest")
            VALUES
              (${HERMETIC_USERS.subscriberA.id}, 'revoke', 0, 1, ${"a".repeat(64)}),
              (${foreignUser}, 'revoke', 0, 1, ${"b".repeat(64)})
          `;
        await seedHermeticUsers(url);
        await seedHermeticUsers(url);
        const audits = await sql<{ userId: string }[]>`
            SELECT "userId" FROM "SubscriptionOverrideAudit"
          `;
        assert.deepEqual([...audits], [{ userId: foreignUser }]);
        const users = await sql`SELECT "id" FROM "User"`;
        assert.equal(users.length, 4);
      } finally {
        await sql.end();
      }
    }
  );
});
test("db:verify is a standalone browser-free gate", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.equal(
    manifest.scripts["db:verify"],
    "tsx --conditions=react-server scripts/db-verify.ts"
  );
});

test("required lifecycle execution cannot silently skip without a database", async () => {
  const env = { ...process.env };
  env.NODE_TEST_CONTEXT = undefined;
  await assert.rejects(
    execute(
      "pnpm",
      [
        "exec",
        "tsx",
        "--conditions=react-server",
        "--test",
        "lib/github/postgres-lifecycle.test.ts",
      ],
      {
        env: {
          ...env,
          GITHUB_TOOL_POSTGRES_TEST_REQUIRED: "1",
          GITHUB_TOOL_POSTGRES_TEST_URL: "",
        },
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error);
      assert.match(String(error.stdout), /GITHUB_TOOL_POSTGRES_TEST_URL/u);
      return true;
    }
  );
});

test("shared disposable database refuses an unconfirmed URL", async () => {
  assert.equal(typeof createDisposableDatabase, "function");
  await assert.rejects(
    createDisposableDatabase({
      E2E_POSTGRES_URL: "postgres://example.invalid/foreign",
      NODE_ENV: "test",
    }),
    /refusing an unconfirmed database/u
  );
});

test("db:verify executes real assertions even when invoked from another test runner", {
  skip: !process.env.E2E_POSTGRES_URL,
}, async () => {
  const { stdout } = await execute(
    "pnpm",
    ["exec", "tsx", "--conditions=react-server", "scripts/db-verify.ts"],
    {
      env: {
        ...process.env,
        E2E_POSTGRES_DISPOSABLE: "1",
        NODE_TEST_CONTEXT: "child-v8",
      },
    }
  );
  assert.match(stdout, /disconnect advances generation/u);
  assert.match(stdout, /an owner mismatch leaves the Stripe event unclaimed/u);
  assert.match(stdout, /Stripe reconciliation redelivery against PostgreSQL/u);
  const count = Number(/^# tests (\d+)$/mu.exec(stdout)?.[1]);
  assert.ok(count >= 3);
  assert.equal(Number(/^# pass (\d+)$/mu.exec(stdout)?.[1]), count);
  assert.match(stdout, /skipped 0/u);
});

test("local database lifecycle owns only a unique child and cleans success and failure", {
  skip: !process.env.E2E_POSTGRES_URL,
}, async () => {
  assert.equal(typeof withDisposableDatabase, "function");
  const external = process.env.E2E_POSTGRES_URL;
  assert.ok(external);
  const env: NodeJS.ProcessEnv = {
    E2E_POSTGRES_DISPOSABLE: "1",
    E2E_POSTGRES_URL: external,
    NODE_ENV: "test",
  };
  const admin = postgres(external, { max: 1 });
  const names: string[] = [];
  const exercise = async (fail: boolean) =>
    withDisposableDatabase(env, async (url: string) => {
      const name = new URL(url).pathname.slice(1);
      assert.match(name, /^coven_test_\d+_[a-f0-9]+$/u);
      assert.notEqual(name, new URL(external).pathname.slice(1));
      names.push(name);
      const child = postgres(url, { max: 1 });
      try {
        const [identity] = await child<
          { name: string }[]
        >`SELECT current_database() AS name`;
        assert.equal(identity.name, name);
        await child`CREATE TABLE owned_probe (id integer)`;
      } finally {
        await child.end();
      }
      if (fail) {
        throw new Error("intentional callback failure");
      }
    });
  try {
    await exercise(false);
    await assert.rejects(exercise(true), /intentional callback failure/u);
    assert.equal(new Set(names).size, 2);
    const rows =
      await admin`SELECT datname FROM pg_database WHERE datname IN ${admin(names)}`;
    assert.equal(rows.length, 0, "owned databases must be removed");
    await admin`SELECT 1`;
  } finally {
    await admin.end();
  }
});
