import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

config({
  path: ".env.local",
});

// TEMPORARY: Remove after the Git-integrated preview records final migration 0014.
const OLD_0014_CREATED_AT = "1787932866820";
const OLD_0014_HASH =
  "15a8b5155d35e315639bf868595458f3674e91c0055520f46ae938f1e5b4cfe1";
const FINAL_0014_CREATED_AT = "1787938619066";
const FINAL_0014_HASH =
  "059bf9e778a4ede0835908609af43adefabaea0a2858bbd7d719dcf2fbee7965";

async function repairPreviewMigrationState(
  connection: ReturnType<typeof postgres>
): Promise<void> {
  await connection.begin(async (transaction) => {
    const [ledger] = await transaction<{ migration_table: string | null }[]>`
      SELECT to_regclass('drizzle.__drizzle_migrations')::text AS migration_table
    `;
    if (!ledger?.migration_table) {
      return;
    }

    await transaction.unsafe(
      "LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE"
    );

    const [latest] = await transaction<
      { created_at: bigint | number | string; hash: string }[]
    >`
      SELECT hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (
      !latest ||
      latest.hash !== OLD_0014_HASH ||
      String(latest.created_at) !== OLD_0014_CREATED_AT
    ) {
      return;
    }

    const columns = await transaction<
      { column_name: string; data_type: string; is_nullable: "NO" | "YES" }[]
    >`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'RunnerRun'
        AND column_name IN ('cancellationRequestedAt', 'daytonaLogCursor')
      ORDER BY column_name
    `;
    const expectedColumns = new Map([
      [
        "cancellationRequestedAt",
        { dataType: "timestamp without time zone", nullable: "YES" },
      ],
      ["daytonaLogCursor", { dataType: "integer", nullable: "NO" }],
    ]);
    if (
      columns.length !== expectedColumns.size ||
      columns.some((column) => {
        const expected = expectedColumns.get(column.column_name);
        return (
          !expected ||
          column.data_type !== expected.dataType ||
          column.is_nullable !== expected.nullable
        );
      })
    ) {
      throw new Error(
        "Legacy 0014 repair aborted: RunnerRun columns do not match the exact expected schema."
      );
    }

    const constraints = await transaction<{ conname: string }[]>`
      SELECT constraint_record.conname
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation
        ON relation.oid = constraint_record.conrelid
      JOIN pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND (
          (
            relation.relname = 'RunnerAgent'
            AND constraint_record.conname = 'RunnerAgent_sandboxLifecycle_valid'
          )
          OR (
            relation.relname = 'RunnerRun'
            AND constraint_record.conname IN (
              'RunnerRun_daytonaLogCursor_nonnegative',
              'RunnerRun_daytonaSession_requires_attempt'
            )
          )
        )
    `;
    const constraintNames = new Set(
      constraints.map((constraint) => constraint.conname)
    );
    if (
      constraintNames.size !== 3 ||
      !constraintNames.has("RunnerAgent_sandboxLifecycle_valid") ||
      !constraintNames.has("RunnerRun_daytonaLogCursor_nonnegative") ||
      !constraintNames.has("RunnerRun_daytonaSession_requires_attempt")
    ) {
      throw new Error(
        "Legacy 0014 repair aborted: expected constraints are missing."
      );
    }

    const [objects] = await transaction<
      {
        agent_index: string | null;
        redaction_table: string | null;
        run_index: string | null;
      }[]
    >`
      SELECT
        to_regclass('public."RunnerAttemptRedaction"')::text AS redaction_table,
        to_regclass('public."RunnerAgent_sandbox_recovery_idx"')::text AS agent_index,
        to_regclass('public."RunnerRun_terminal_attempt_cleanup_idx"')::text AS run_index
    `;
    if (
      !objects ||
      objects.redaction_table !== null ||
      objects.agent_index !== null ||
      objects.run_index !== null
    ) {
      throw new Error(
        "Legacy 0014 repair aborted: final 0014 objects already exist."
      );
    }

    await transaction.unsafe(`
      CREATE TABLE "RunnerAttemptRedaction" (
        "aadVersion" integer NOT NULL,
        "attemptId" varchar(36) NOT NULL,
        "ciphertext" text NOT NULL,
        "createdAt" timestamp DEFAULT now() NOT NULL,
        "iv" varchar(64) NOT NULL,
        "kekVersion" varchar(32) NOT NULL,
        "runId" uuid PRIMARY KEY NOT NULL,
        "wrappedKey" varchar(128) NOT NULL,
        CONSTRAINT "RunnerAttemptRedaction_attemptId_unique" UNIQUE("attemptId"),
        CONSTRAINT "RunnerAttemptRedaction_aadVersion_valid" CHECK ("RunnerAttemptRedaction"."aadVersion" = 1),
        CONSTRAINT "RunnerAttemptRedaction_attemptId_valid" CHECK ("RunnerAttemptRedaction"."attemptId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
        CONSTRAINT "RunnerAttemptRedaction_envelope_nonempty" CHECK (char_length("RunnerAttemptRedaction"."ciphertext") > 0 and char_length("RunnerAttemptRedaction"."iv") > 0 and char_length("RunnerAttemptRedaction"."kekVersion") > 0 and char_length("RunnerAttemptRedaction"."wrappedKey") > 0)
      )
    `);
    await transaction.unsafe(`
      ALTER TABLE "RunnerAttemptRedaction"
      ADD CONSTRAINT "RunnerAttemptRedaction_runId_RunnerRun_id_fk"
      FOREIGN KEY ("runId") REFERENCES "public"."RunnerRun"("id")
      ON DELETE cascade ON UPDATE no action
    `);
    await transaction.unsafe(`
      CREATE INDEX "RunnerAgent_sandbox_recovery_idx"
      ON "RunnerAgent" USING btree ("sandboxLifecycle", "sandboxUpdatedAt")
      WHERE "RunnerAgent"."sandboxLifecycle" in ('provisioning', 'provisioning_ambiguous', 'resetting', 'decommissioning')
    `);
    await transaction.unsafe(`
      CREATE INDEX "RunnerRun_terminal_attempt_cleanup_idx"
      ON "RunnerRun" USING btree ("dispatchLeaseExpiresAt")
      WHERE "RunnerRun"."dispatchState" = 'terminal'
        and "RunnerRun"."daytonaAttemptId" is not null
        and "RunnerRun"."dispatchLeaseToken" is not null
    `);
    await transaction`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${FINAL_0014_HASH}, ${FINAL_0014_CREATED_AT})
    `;

    console.log("Repaired exact legacy preview migration state");
  });
}

const runMigrate = async () => {
  if (!process.env.POSTGRES_URL) {
    console.log("POSTGRES_URL not defined, skipping migrations");
    process.exit(0);
  }

  const connection = postgres(process.env.POSTGRES_URL, { max: 1 });
  const db = drizzle(connection);

  console.log("Running migrations...");

  const start = Date.now();
  await repairPreviewMigrationState(connection);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  const end = Date.now();

  console.log("Migrations completed in", end - start, "ms");
  process.exit(0);
};

runMigrate().catch((err) => {
  console.error("Migration failed");
  console.error(err);
  process.exit(1);
});
