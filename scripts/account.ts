#!/usr/bin/env tsx
import { sql } from "drizzle-orm";
import {
  db,
  findOrCreateFederatedUser,
  revokeSessionsByEmail,
} from "@/lib/db/queries";
import { user } from "@/lib/db/schema";
import { formatRevocationOutput } from "./account-output";

/**
 * Creates an account or resets its password from the command line.
 *
 * The web form is the normal path. This exists for the two cases the form
 * cannot serve: standing up the first account on a fresh deployment, and
 * recovering one whose password is lost — there is no email delivery here, so
 * a forgotten password is otherwise unrecoverable.
 *
 *   pnpm account create you@example.com
 *   pnpm account show you@example.com
 *
 * Point it at whichever database you mean:
 *
 *   POSTGRES_URL='postgres://...' pnpm account create you@example.com
 *
 * An inline variable wins over `.env.local`, which is what makes it safe to
 * run against production from a checkout configured for local development.
 */

async function findUser(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const [row] = await db
    .select()
    .from(user)
    .where(sql`lower(${user.email}) = lower(${normalizedEmail})`)
    .limit(1);

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

async function create(email: string) {
  if (await findUser(email)) {
    process.stdout.write(`${email} already exists.\n`);
    process.exitCode = 1;
    return;
  }

  // Passwordless: sign-in is GitHub-only, so a password on a new row could
  // never be used. The row is created the same way a first GitHub sign-in
  // creates one, and that sign-in will adopt it by email.
  await findOrCreateFederatedUser(email);

  process.stdout.write(
    `Created ${email}\n  Sign in with GitHub using this address.\n`
  );
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

async function revokeSessions(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const row = normalizedEmail
    ? await revokeSessionsByEmail(normalizedEmail)
    : null;
  if (!row) {
    process.stderr.write("No matching account.\n");
    process.exitCode = 1;
    return;
  }

  // Deliberately no email, database target, or other account data.
  process.stdout.write(formatRevocationOutput(row));
}

async function main() {
  const [command, email] = process.argv.slice(2);

  if (!(command && email)) {
    process.stdout.write(
      "Usage:\n" +
        "  pnpm account create <email>\n" +
        "  pnpm account show <email>\n" +
        "  pnpm account revoke-sessions <email>\n"
    );
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "create":
      process.stdout.write(`database: ${describeTarget()}\n`);
      await create(email);
      break;
    case "show":
      process.stdout.write(`database: ${describeTarget()}\n`);
      await show(email);
      break;
    case "revoke-sessions":
      await revokeSessions(email);
      break;
    default:
      process.stdout.write(`Unknown command: ${command}\n`);
      process.exitCode = 1;
  }
}

main()
  .catch(() => {
    process.stderr.write("Account command failed.\n");
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
