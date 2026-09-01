import postgres from "postgres";
import { tenantForUser } from "@/lib/session";

export const HERMETIC_USERS = {
  ineligible: {
    authVersion: 13,
    email: "hermetic-ineligible@example.invalid",
    id: "00000000-0000-4000-8000-000000000003",
    subscribedUntil: null,
  },
  subscriberA: {
    authVersion: 7,
    email: "hermetic-subscriber-a@example.invalid",
    id: "00000000-0000-4000-8000-000000000001",
    subscribedUntil: "2099-01-01T00:00:00.000Z",
  },
  subscriberB: {
    authVersion: 11,
    email: "hermetic-subscriber-b@example.invalid",
    id: "00000000-0000-4000-8000-000000000002",
    subscribedUntil: "2099-01-01T00:00:00.000Z",
  },
} as const;

export const HERMETIC_TENANTS = Object.values(HERMETIC_USERS).map(({ id }) =>
  tenantForUser(id)
);

type SqlClient = ReturnType<typeof postgres>;

function database(url = process.env.POSTGRES_URL): SqlClient {
  if (!url) {
    throw new Error("POSTGRES_URL is required for hermetic E2E assertions.");
  }
  return postgres(url, { max: 1 });
}

export type TenantCertificationCounts = Readonly<{
  agents: number;
  credentials: number;
  reservations: number;
  runs: number;
  usage: number;
}>;

export async function seedHermeticUsers(url: string): Promise<void> {
  const sql = database(url);
  try {
    const users = Object.values(HERMETIC_USERS);
    const tenants = users.map(({ id }) => tenantForUser(id));
    await sql`DELETE FROM "RunReservation" WHERE "runId" IN (
      SELECT "id"::text FROM "RunnerRun" WHERE "tenant" = ANY(${tenants})
    )`;
    await sql`DELETE FROM "RunUsage" WHERE "tenant" = ANY(${tenants})`;
    await sql`DELETE FROM "RunnerAgent" WHERE "tenant" = ANY(${tenants})`;
    await sql`DELETE FROM "TenantCredential" WHERE "tenant" = ANY(${tenants})`;
    await sql`DELETE FROM "User" WHERE "id" = ANY(${users.map(({ id }) => id)})`;
    await Promise.all(
      users.map(async (account) => {
        // These fixed, non-personal rows are intentionally the only test setup
        // mutation; every certified operation afterwards uses the application.
        await sql`
        INSERT INTO "User" (
          "id", "email", "emailVerified", "isAnonymous", "authVersion",
          "billingPeriodStart", "subscribedUntil", "createdAt", "updatedAt"
        ) VALUES (
          ${account.id}, ${account.email}, true, false, ${account.authVersion},
          ${account.subscribedUntil ? "2098-12-01T00:00:00.000Z" : null},
          ${account.subscribedUntil}, now(), now()
        )
      `;
      })
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function tenantCertificationCounts(
  tenant: string,
  url = process.env.POSTGRES_URL
): Promise<TenantCertificationCounts> {
  const sql = database(url);
  try {
    const [agents] = await sql<
      { count: string }[]
    >`SELECT count(*)::text AS "count" FROM "RunnerAgent" WHERE "tenant" = ${tenant}`;
    const [credentials] = await sql<
      { count: string }[]
    >`SELECT count(*)::text AS "count" FROM "TenantCredential" WHERE "tenant" = ${tenant}`;
    const [reservations] = await sql<
      { count: string }[]
    >`SELECT count(*)::text AS "count" FROM "RunReservation" WHERE "tenantHash" IS NOT NULL AND "runId" IN (
        SELECT "id"::text FROM "RunnerRun" WHERE "tenant" = ${tenant}
      )`;
    const [runs] = await sql<
      { count: string }[]
    >`SELECT count(*)::text AS "count" FROM "RunnerRun" WHERE "tenant" = ${tenant}`;
    const [usage] = await sql<
      { count: string }[]
    >`SELECT count(*)::text AS "count" FROM "RunUsage" WHERE "tenant" = ${tenant}`;
    return {
      agents: Number(agents?.count ?? 0),
      credentials: Number(credentials?.count ?? 0),
      reservations: Number(reservations?.count ?? 0),
      runs: Number(runs?.count ?? 0),
      usage: Number(usage?.count ?? 0),
    };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function incrementHermeticAuthVersion(
  userId: string,
  url = process.env.POSTGRES_URL
): Promise<void> {
  const sql = database(url);
  try {
    await sql`UPDATE "User"
      SET "authVersion" = "authVersion" + 1, "updatedAt" = now()
      WHERE "id" = ${userId}`;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function providerProvenanceForRun(
  runId: string,
  url = process.env.POSTGRES_URL
): Promise<Readonly<{ provider: string | null; status: string | null }>> {
  const sql = database(url);
  try {
    const [row] = await sql<
      { provider: string | null; status: string | null }[]
    >`
      SELECT "executionProvenance"->>'provider' AS "provider", "status"
      FROM "RunnerRun" WHERE "id" = ${runId}
    `;
    return row ?? { provider: null, status: null };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export type ApplicationTableFingerprint = Readonly<{
  checksum: string;
  count: number;
}>;

export async function applicationTableInventory(
  url = process.env.POSTGRES_URL
): Promise<Readonly<Record<string, ApplicationTableFingerprint>>> {
  const sql = database(url);
  try {
    const tables = await sql<{ tablename: string }[]>`
      SELECT "tablename"
      FROM pg_tables
      WHERE "schemaname" = 'public'
        AND "tablename" <> '__drizzle_migrations'
      ORDER BY "tablename"
    `;
    const counts = await Promise.all(
      tables.map(async ({ tablename }) => {
        const [row] = await sql.unsafe<{ checksum: string; count: string }[]>(
          `SELECT count(*)::text AS "count",
             md5(COALESCE(
               string_agg(
                 row_to_json("application_row")::text,
                 '' ORDER BY row_to_json("application_row")::text
               ),
               ''
             )) AS "checksum"
           FROM ${sql(tablename)} AS "application_row"`
        );
        return [
          tablename,
          {
            checksum: row?.checksum ?? "",
            count: Number(row?.count ?? 0),
          },
        ] as const;
      })
    );
    return Object.fromEntries(counts);
  } finally {
    await sql.end({ timeout: 2 });
  }
}
