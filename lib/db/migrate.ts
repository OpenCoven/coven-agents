import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (process.env.COVEN_HERMETIC_RUNNER !== "1") {
  config({ path: ".env.local" });
}

const runMigrate = async () => {
  if (!process.env.POSTGRES_URL?.trim()) {
    if (process.argv.includes("--strict")) {
      throw new Error("POSTGRES_URL is required for strict migrations.");
    }
    console.warn(
      "POSTGRES_URL not defined, skipping migrations; use --strict to require a database."
    );
    return;
  }

  const connection = postgres(process.env.POSTGRES_URL, { max: 1 });
  const db = drizzle(connection);

  console.log("Running migrations...");

  const start = Date.now();
  try {
    await migrate(db, { migrationsFolder: "./lib/db/migrations" });
    console.log("Migrations completed in", Date.now() - start, "ms");
  } finally {
    await connection.end();
  }
};

runMigrate().catch((err) => {
  console.error("Migration failed");
  console.error(err);
  process.exitCode = 1;
});
