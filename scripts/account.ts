#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createUser, db } from "@/lib/db/queries";
import { user } from "@/lib/db/schema";
import { generateHashedPassword } from "@/lib/db/utils";

/**
 * Creates an account or resets its password from the command line.
 *
 * The web form is the normal path. This exists for the two cases the form
 * cannot serve: standing up the first account on a fresh deployment, and
 * recovering one whose password is lost — there is no email delivery here, so
 * a forgotten password is otherwise unrecoverable.
 *
 *   pnpm account create you@example.com               # generates a password
 *   pnpm account create you@example.com hunter2000
 *   pnpm account password you@example.com             # generates a new one
 *   pnpm account password you@example.com hunter2000
 *   pnpm account show you@example.com
 *
 * Point it at whichever database you mean:
 *
 *   POSTGRES_URL='postgres://...' pnpm account create you@example.com
 *
 * An inline variable wins over `.env.local`, which is what makes it safe to
 * run against production from a checkout configured for local development.
 */

const GENERATED_BYTES = 12;

function generatePassword(): string {
  return `coven-${randomBytes(GENERATED_BYTES).toString("base64url")}`;
}

async function findUser(email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email));

  return row ?? null;
}

function describeTarget(): string {
  const raw = process.env.POSTGRES_URL;

  if (!raw) {
    // An empty connection string makes the driver silently fall back to
    // localhost, which is how a "production" command quietly edits a dev
    // database — or fails with ECONNREFUSED and no explanation.
    return "(POSTGRES_URL is unset — the driver will default to localhost)";
  }

  try {
    const url = new URL(raw);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(unparseable POSTGRES_URL)";
  }
}

async function create(email: string, supplied?: string) {
  if (await findUser(email)) {
    process.stdout.write(`${email} already exists. Use: account password\n`);
    process.exitCode = 1;
    return;
  }

  const password = supplied ?? generatePassword();
  await createUser(email, password);

  process.stdout.write(`Created ${email}\n  password: ${password}\n`);
}

async function setPassword(email: string, supplied?: string) {
  if (!(await findUser(email))) {
    process.stdout.write(`No user with email ${email}.\n`);
    process.exitCode = 1;
    return;
  }

  const password = supplied ?? generatePassword();
  await db
    .update(user)
    .set({ password: generateHashedPassword(password) })
    .where(eq(user.email, email));

  process.stdout.write(`Updated ${email}\n  password: ${password}\n`);
}

async function show(email: string) {
  const row = await findUser(email);

  if (!row) {
    process.stdout.write(`No user with email ${email}.\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${row.email}\n  id: ${row.id}\n  subscribedUntil: ${
      row.subscribedUntil?.toISOString() ?? "none"
    }\n`
  );
}

async function main() {
  const [command, email, password] = process.argv.slice(2);

  if (!(command && email)) {
    process.stdout.write(
      "Usage:\n" +
        "  pnpm account create <email> [password]\n" +
        "  pnpm account password <email> [password]\n" +
        "  pnpm account show <email>\n"
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`database: ${describeTarget()}\n`);

  switch (command) {
    case "create":
      await create(email, password);
      break;
    case "password":
      await setPassword(email, password);
      break;
    case "show":
      await show(email);
      break;
    default:
      process.stdout.write(`Unknown command: ${command}\n`);
      process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
