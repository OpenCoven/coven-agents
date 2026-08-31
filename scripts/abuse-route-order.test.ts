import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
/**
 * The TS5 alias, not the toolchain's TypeScript.
 *
 * This guard parses route files with the compiler API, and typescript@7 — the
 * native port the repo compiles with — ships no JS API at all:
 * `createSourceFile` is undefined at runtime, and the package's types resolve
 * to a stub that exports nothing the old API had. The test was written against
 * 5.x and landed after the 7.0.2 bump, which broke both `pnpm typecheck` and
 * `pnpm test:unit` on main.
 *
 * `typescript5` is `npm:typescript@5.8.2`, pinned as a devDependency purely as
 * a parser library. The compiler the build uses stays 7; nothing but this file
 * imports the alias.
 */
import ts from "typescript5";

const repositoryRoot = new URL("../", import.meta.url);

type RouteExpectation = {
  admissionMarker?: string;
  file: string;
  handler: string;
  identityMarker: string;
  implementation?: string;
  implementationFile?: string;
  markers: string[];
  policy: string;
};

const protectedHandlers: RouteExpectation[] = [
  route(
    "app/(chat)/api/chat/route.ts",
    "POST",
    "authorizeSubscriberAccess(",
    ["readBoundedJson(", "getMessageCountByUserId("],
    "chat"
  ),
  route(
    "app/(chat)/api/chat/route.ts",
    "DELETE",
    "authorizeSubscriberAccess(",
    ["getChatById("],
    "chat_delete"
  ),
  route(
    "app/(chat)/api/files/upload/route.ts",
    "POST",
    "authorizeSubscriberAccess(",
    ["readBoundedFormData(", "put("],
    "upload"
  ),
  {
    ...route(
      "app/api/checkout/route.ts",
      "POST",
      "dependencies.authenticate(",
      ["dependencies.findUser(", "dependencies.createProvider("],
      "checkout"
    ),
    admissionMarker: "dependencies.enforceAbuse({",
    implementation: "checkoutResponse",
    implementationFile: "lib/billing/checkout-response.ts",
  },
  route(
    "app/api/credentials/device/route.ts",
    "POST",
    "authorizeSubscriberAccess(",
    ["startDeviceFlow("],
    "credential_device_start"
  ),
  route(
    "app/api/credentials/device/route.ts",
    "PUT",
    "authorizeSubscriberAccess(",
    ["readBoundedJson(", "exchangeDeviceCode("],
    "credential_device_poll"
  ),
  route(
    "app/api/credentials/route.ts",
    "GET",
    "authorizeSubscriberAccess(",
    ["listCredentialHarnesses("],
    "credential_list"
  ),
  route(
    "app/api/credentials/route.ts",
    "POST",
    "authorizeSubscriberAccess(",
    ["readBoundedJson(", "checkCopilotToken(", "putCredential("],
    "credential_write"
  ),
  route(
    "app/api/credentials/route.ts",
    "DELETE",
    "authorizeSubscriberAccess(",
    ["readBoundedJson(", "deleteCredential("],
    "credential_delete"
  ),
  route(
    "app/(chat)/api/document/route.ts",
    "GET",
    "authorizeSubscriberAccess(",
    ["getDocumentsById("],
    "document_read"
  ),
  {
    ...route(
      "app/(chat)/api/document/route.ts",
      "POST",
      "authorizeSubscriberAccess(",
      ["readBoundedJson(", "getDocumentsById(", "saveDocument("],
      "document_write"
    ),
    implementation: "writeDocument",
  },
  {
    ...route(
      "app/(chat)/api/document/route.ts",
      "PATCH",
      "authorizeSubscriberAccess(",
      ["readBoundedJson(", "getDocumentsById(", "saveDocument("],
      "document_write"
    ),
    implementation: "writeDocument",
  },
  route(
    "app/(chat)/api/document/route.ts",
    "DELETE",
    "authorizeSubscriberAccess(",
    ["getDocumentsById(", "deleteDocumentsByIdAfterTimestamp("],
    "document_delete"
  ),
  route(
    "app/(chat)/api/history/route.ts",
    "GET",
    "authorizeSubscriberAccess(",
    ["getChatsByUserId("],
    "history_read"
  ),
  route(
    "app/(chat)/api/history/route.ts",
    "DELETE",
    "authorizeSubscriberAccess(",
    ["deleteAllChatsByUserId("],
    "history_delete"
  ),
  route(
    "app/(chat)/api/messages/route.ts",
    "GET",
    "authorizeSubscriberAccess(",
    ["getChatById(", "getMessagesByChatId("],
    "messages_read"
  ),
  route(
    "app/(chat)/api/suggestions/route.ts",
    "GET",
    "authorizeSubscriberAccess(",
    ["getSuggestionsByDocumentId("],
    "suggestions_read"
  ),
  route(
    "app/(chat)/api/vote/route.ts",
    "GET",
    "authorizeSubscriberAccess(",
    ["getChatById(", "getVotesByChatId("],
    "vote_read"
  ),
  route(
    "app/(chat)/api/vote/route.ts",
    "PATCH",
    "authorizeSubscriberAccess(",
    ["readBoundedJson(", "getChatById(", "voteMessage("],
    "vote_write"
  ),
  route(
    "app/api/account/avatar/route.ts",
    "GET",
    "resolveAccount(",
    ["avatarFor(", "databaseFor("],
    "avatar_read"
  ),
  route(
    "app/api/account/avatar/route.ts",
    "PUT",
    "authorizeSubscriberAccess(",
    ["request.json(", "databaseFor("],
    "avatar_write"
  ),
  route(
    "app/api/usage/route.ts",
    "GET",
    "auth(",
    ["findUserById(", "runReservationUsageForTenant("],
    "usage_read"
  ),
  route(
    "app/(chat)/api/models/route.ts",
    "GET",
    "GET(request",
    ["getCapabilities(", "getAllGatewayModels("],
    "model_list"
  ),
];

const excludedRoutes = ["app/api/stripe/webhook/route.ts"];

test("resource-bearing handlers admit after identity and before expensive work", () => {
  for (const expectation of protectedHandlers) {
    const source = read(expectation.file);
    const implementation = expectation.implementation ?? expectation.handler;
    const implementationSource = expectation.implementationFile
      ? read(expectation.implementationFile)
      : source;
    const handlerBlock = exportedFunctionBlock(source, expectation.handler);
    const block = functionBlock(implementationSource, implementation);
    const admissionIndex = block.indexOf(
      expectation.admissionMarker ?? "enforceAbusePolicy({"
    );

    assert.match(
      source,
      /from "@\/lib\/abuse\/enforce"/,
      `${expectation.file} must import abuse admission`
    );
    assert.match(
      source,
      /from "@vercel\/functions"/,
      `${expectation.file} must use the platform IP helper`
    );
    assert.ok(
      exportedHandlerUses(handlerBlock, expectation.handler, implementation),
      `${expectation.file} ${expectation.handler} must use ${implementation}`
    );
    assert.ok(
      admissionIndex >= 0,
      `${expectation.file} ${expectation.handler} must enforce admission`
    );
    assert.ok(
      block.includes(`route: "${expectation.policy}"`),
      `${expectation.file} ${expectation.handler} must use ${expectation.policy}`
    );
    assert.ok(
      block.indexOf(expectation.identityMarker) >= 0,
      `${expectation.file} ${expectation.handler} must establish identity`
    );
    assert.ok(
      block.indexOf(expectation.identityMarker) < admissionIndex,
      `${expectation.file} ${expectation.handler} must establish identity first`
    );

    for (const marker of expectation.markers) {
      const markerIndex = block.indexOf(marker);
      assert.ok(
        markerIndex >= 0,
        `${expectation.file} ${expectation.handler} must include ${marker}`
      );
      assert.ok(
        markerIndex > admissionIndex,
        `${expectation.file} ${expectation.handler} must admit before ${marker}`
      );
    }
  }
});

test("deferred webhook routes stay untouched", () => {
  for (const file of excludedRoutes) {
    assert.doesNotMatch(read(file), /enforceAbusePolicy/);
  }
});

test("analytics revalidates subscriber authority before reading history", () => {
  const source = read("lib/analytics/response.ts");
  const authorityIndex = source.indexOf("dependencies.authorize(");
  const historyIndex = source.indexOf("dependencies.readHistory(");

  assert.ok(authorityIndex >= 0);
  assert.ok(historyIndex > authorityIndex);
  assert.match(read("app/api/analytics/route.ts"), /ipAddress\(request\)/);
});

test("runner credential acquisition reserves and leases before decryption", () => {
  const source = read("lib/credentials/runner-credential.ts");
  const acquisition = functionBlock(source, "acquireRunnerCredential");
  const reserveIndex = acquisition.indexOf("dependencies.reserveRun({");
  const issueIndex = acquisition.indexOf("dependencies.issueLease(leaseInput)");
  const leaseIndex = acquisition.indexOf("dependencies.leaseCredential(");
  const prepareIndex = acquisition.indexOf("dependencies.prepareCredential(");
  const readIndex = acquisition.indexOf("dependencies.readCredential(");

  assert.ok(reserveIndex >= 0, "credential acquisition must reserve capacity");
  assert.ok(
    issueIndex > reserveIndex,
    "reservation must precede lease issuance"
  );
  assert.ok(leaseIndex > issueIndex, "lease issuance must precede consumption");
  assert.ok(
    prepareIndex > leaseIndex,
    "lease consumption must enclose credential preparation"
  );
  assert.ok(
    readIndex > prepareIndex,
    "credential preparation must precede the side-effect-free read"
  );
  assert.match(acquisition, /releasePreLaunchResources/);
});

test("costly creates claim idempotency before calling their provider", () => {
  for (const [file, handler, providerMarker] of [
    [
      "lib/billing/checkout-response.ts",
      "checkoutResponse",
      "dependencies.createProvider(",
    ],
    ["app/api/credentials/device/route.ts", "POST", "startDeviceFlow("],
  ] as const) {
    const source = read(file);
    const block = exportedFunctionBlock(source, handler);
    const claimIndex = block.indexOf("runIdempotentOperation({");
    const providerIndex = block.indexOf(providerMarker);

    assert.ok(claimIndex >= 0, `${file} must claim idempotency`);
    assert.ok(providerIndex >= 0, `${file} must call ${providerMarker}`);
    assert.ok(
      claimIndex < providerIndex,
      `${file} must claim before ${providerMarker}`
    );
  }
});

test("device starts encrypt replay payloads while checkout uses tagged plaintext", () => {
  const deviceSource = read("app/api/credentials/device/route.ts");
  const checkoutSource = read("lib/billing/checkout-response.ts");

  assert.match(deviceSource, /encryptedIdempotencyResponseStorage\(/);
  assert.match(deviceSource, /credentialKekVersion/);
  assert.match(
    functionBlock(deviceSource, "POST"),
    /responseStorage:\s*deviceStartResponseStorage/
  );
  assert.match(
    functionBlock(checkoutSource, "checkoutResponse"),
    /responseStorage:\s*plaintextIdempotencyResponseStorage/
  );
});

test("bounded readers enforce limits before native body parsing", () => {
  const source = read("lib/abuse/body.ts");
  const declaredLengthIndex = source.indexOf("declaredContentLength(");
  const boundedReadIndex = source.indexOf("readBoundedBytes(");
  const jsonParseIndex = source.indexOf("JSON.parse(");
  const reconstructedRequestIndex = source.indexOf("new Request(");
  const formDataIndex = source.indexOf(".formData()");

  assert.ok(declaredLengthIndex >= 0);
  assert.ok(boundedReadIndex > declaredLengthIndex);
  assert.ok(jsonParseIndex > boundedReadIndex);
  assert.ok(reconstructedRequestIndex > boundedReadIndex);
  assert.ok(formDataIndex > reconstructedRequestIndex);
  assert.doesNotMatch(source, /request\.json\(\)|request\.formData\(\)/);
});

test("idempotency migration creates the scoped state machine and expiry index", () => {
  const migration = read("lib/db/migrations/0005_idempotency_records.sql");

  assert.match(migration, /CREATE TABLE "IdempotencyRecord"/);
  assert.match(
    migration,
    /"IdempotencyRecord_owner_operation_key_idx".*"ownerId".*"operation".*"keyHash"/s
  );
  assert.match(migration, /"IdempotencyRecord_expiresAt_idx"/);
  assert.match(migration, /IdempotencyRecord_state_check/);
  assert.match(migration, /IdempotencyRecord_response_state_check/);
});

test("idempotency envelope migration uses tagged responses", () => {
  const migration = read(
    "lib/db/migrations/0006_idempotency_response_envelopes.sql"
  );
  assert.match(
    migration,
    /DELETE FROM "IdempotencyRecord"\s+WHERE "operation" = 'credential_device_start'/
  );
  assert.match(
    migration,
    /DELETE FROM "IdempotencyRecord"\s+WHERE "state" = 'completed'\s+AND \("responseJson" IS NULL OR "responseStatus" IS NULL\)/i
  );
  assert.match(
    migration,
    /jsonb_build_object\('kind', 'plain_json', 'body', "responseJson"\)/
  );
  assert.match(migration, /"responseJson" is not null/i);
  assert.match(migration, /jsonb_typeof\([^)]*"responseJson"\) = 'object'/i);
  assert.match(migration, /"responseStatus" is not null/i);

  const snapshot = read("lib/db/migrations/meta/0006_snapshot.json");
  assert.match(snapshot, /responseJson.*is not null/is);
  assert.match(snapshot, /jsonb_typeof.*responseJson.*object/is);
  assert.match(snapshot, /responseStatus.*is not null/is);
});

test("run reservation migration creates pseudonymous atomic budgets", () => {
  const migration = read("lib/db/migrations/0007_run_reservations.sql");

  // IF NOT EXISTS on purpose: the table reached production without its
  // journal row, and an unguarded CREATE re-ran on every deploy and died on
  // 42P07 — no build shipped for hours. The guard makes the migration
  // converge from either starting state.
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "RunReservation"/);
  assert.match(migration, /"runId" varchar\(64\) PRIMARY KEY/);
  assert.match(migration, /"tenantHash" varchar\(64\) NOT NULL/);
  assert.doesNotMatch(migration, /"tenant" varchar/);
  assert.match(
    migration,
    /"RunReservation_tenant_day_state_idx".*"tenantHash".*"periodDay".*"state"/s
  );
  assert.match(
    migration,
    /"RunReservation_day_state_idx".*"periodDay".*"state"/s
  );
  assert.match(
    migration,
    /"RunReservation_reserved_expiry_idx".*"expiresAt".*WHERE (?:"RunReservation"\.)?"state" = 'reserved'/s
  );
  assert.match(migration, /"RunUsage_countedAt_idx".*"countedAt"/s);
  assert.match(
    migration,
    /"RunUsage_tenant_countedAt_idx".*"tenant".*"countedAt"/s
  );
  assert.match(migration, /RunReservation_costUnits_positive/);
  assert.match(migration, /RunReservation_state_timestamps_valid/);

  const snapshot = read("lib/db/migrations/meta/0007_snapshot.json");
  assert.match(snapshot, /RunReservation_reserved_expiry_idx/);
  assert.match(snapshot, /RunUsage_countedAt_idx/);
  assert.match(snapshot, /RunUsage_tenant_countedAt_idx/);
  assert.match(snapshot, /billingPeriodStart/);
});

test("identity version migration adds a non-null zero default", () => {
  const migration = read("lib/db/migrations/0008_identity_versions.sql");
  assert.match(
    migration,
    /ALTER TABLE "User" ADD COLUMN "authVersion" integer DEFAULT 0 NOT NULL/i
  );

  const snapshot = read("lib/db/migrations/meta/0008_snapshot.json");
  assert.match(snapshot, /"authVersion"/);
  assert.match(snapshot, /"default": 0/);
  assert.match(snapshot, /"notNull": true/);
});

test("credential KEK migration backfills v1 before enforcing the version", () => {
  const migration = read("lib/db/migrations/0009_credential_kek_versions.sql");
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS "kekVersion" varchar\(32\) DEFAULT 'v1'/i
  );
  assert.match(
    migration,
    /UPDATE "TenantCredential"[\s\S]*SET "kekVersion" = 'v1'[\s\S]*IS NULL/i
  );
  assert.match(migration, /ALTER COLUMN "kekVersion" SET NOT NULL/i);
  assert.match(migration, /ALTER COLUMN "kekVersion" DROP DEFAULT/i);
  assert.match(migration, /TenantCredential_kekVersion_valid/);

  const snapshot = read("lib/db/migrations/meta/0009_snapshot.json");
  assert.match(snapshot, /"kekVersion"/);
  assert.match(snapshot, /"type": "varchar\(32\)"/);
  assert.match(snapshot, /"notNull": true/);
  assert.match(
    read("lib/db/migrations/meta/_journal.json"),
    /0009_credential_kek_versions/
  );
});

test("session revocation increments in the database update", () => {
  const source = read("lib/db/queries.ts");
  const start = source.indexOf("export async function revokeSessionsByEmail");
  assert.ok(start >= 0);
  const revoke = source.slice(start, start + 1000);

  assert.match(revoke, /\.update\(user\)/);
  assert.match(source, /function emailMatches\(normalizedEmail: string\)/);
  assert.match(
    source,
    /lower\(\$\{user\.email\}\) = lower\(\$\{normalizedEmail\}\)/
  );
  assert.match(revoke, /count\(\*\).*emailMatches\(normalizedEmail\)/s);
  assert.match(revoke, /authVersion\} \+ 1/);
  assert.match(revoke, /\.returning\(\{ authVersion: user\.authVersion/);
});

test("federated account creation stores canonical lowercase email", () => {
  const source = read("lib/db/queries.ts");
  const start = source.indexOf(
    "export async function findOrCreateFederatedUser"
  );
  assert.ok(start >= 0);
  const federated = source.slice(start, start + 1200);

  assert.match(federated, /normalizeEmail\(email\)/);
  assert.match(federated, /values\(\{ email: normalizedEmail/);
});

test("database claims and reclaims idempotency records atomically", () => {
  const source = read("lib/db/queries.ts");
  const storeIndex = source.indexOf(
    "export const databaseIdempotencyStore: IdempotencyStore"
  );
  const storeSource = source.slice(storeIndex);

  assert.ok(storeIndex >= 0);
  assert.match(storeSource, /\.transaction\(/);
  assert.match(storeSource, /\.onConflictDoNothing\(/);
  assert.match(storeSource, /lte\(idempotencyRecord\.expiresAt, input\.now\)/);
  assert.equal(
    storeSource.match(
      /eq\(\s*idempotencyRecord\.expiresAt,\s*input\.claim\.claimExpiresAt\s*\)/g
    )?.length,
    3
  );
  assert.match(storeSource, /storedIdempotencyClaimHash\(input\.claim\)/);
  assert.match(storeSource, /async renew\(input\)/);
});

test("database cleanup is bounded, state-agnostic, and preserves checkout recovery leases", () => {
  const source = read("lib/db/queries.ts");
  const coreSource = read("lib/abuse/idempotency.ts");
  const storeIndex = source.indexOf(
    "export const databaseIdempotencyStore: IdempotencyStore"
  );
  const storeSource = source.slice(storeIndex);
  const cleanupIndex = storeSource.indexOf("async cleanupExpired(input)");
  const completeIndex = storeSource.indexOf("async complete(input)");
  const cleanupSource = storeSource.slice(cleanupIndex, completeIndex);
  const cleanupCallIndex = coreSource.indexOf(
    "await options.store.cleanupExpired("
  );
  const claimCallIndex = coreSource.indexOf(
    "const claimResult = await options.store.claim("
  );

  assert.ok(cleanupIndex >= 0);
  assert.ok(completeIndex > cleanupIndex);
  assert.ok(cleanupCallIndex >= 0);
  assert.ok(claimCallIndex > cleanupCallIndex);
  assert.match(cleanupSource, /\.delete\(idempotencyRecord\)/);
  assert.match(
    cleanupSource,
    /lte\(idempotencyRecord\.expiresAt, input\.before\)/
  );
  assert.match(
    cleanupSource,
    /\.where\(\s*and\(\s*inArray\(idempotencyRecord\.id, expired\),\s*lte\(idempotencyRecord\.expiresAt, input\.before\),\s*ne\(idempotencyRecord\.operation, CHECKOUT_ATTEMPT_OPERATION\)\s*\)\s*\)/
  );
  assert.match(cleanupSource, /\.limit\(input\.limit\)/);
  assert.doesNotMatch(cleanupSource, /idempotencyRecord\.state/);
  assert.equal(
    cleanupSource.match(
      /ne\(idempotencyRecord\.operation, CHECKOUT_ATTEMPT_OPERATION\)/g
    )?.length,
    2
  );
});

test("checkout leases preserve attempt identity and fence renewals and releases", () => {
  const source = read("lib/db/queries.ts");
  const start = source.indexOf(
    "export const databaseCheckoutAttemptLeaseStore"
  );
  const end = source.indexOf("export const databaseIdempotencyStore", start);
  const leaseStore = source.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(leaseStore, /\.transaction\(/);
  assert.match(leaseStore, /\.onConflictDoNothing\(/);
  assert.match(
    leaseStore,
    /returning\(\{ attemptId: idempotencyRecord\.id \}\)/
  );
  assert.match(leaseStore, /requestHash: input\.ownerToken/);
  assert.match(
    leaseStore,
    /parseCheckoutAttemptState\(existing\.requestHash\)/
  );
  assert.match(
    leaseStore,
    /serializeCheckoutAttemptState\(\s*input\.disposition\.state\s*\)/
  );
  assert.match(leaseStore, /lte\(idempotencyRecord\.expiresAt, input\.now\)/);
  assert.match(leaseStore, /gt\(idempotencyRecord\.expiresAt, input\.now\)/);
  assert.ok(
    (
      leaseStore.match(
        /eq\(idempotencyRecord\.requestHash, input\.lease\.ownerToken\)/g
      ) ?? []
    ).length >= 2
  );
  assert.ok(
    (
      leaseStore.match(
        /eq\(idempotencyRecord\.id, input\.lease\.attemptId\)/g
      ) ?? []
    ).length >= 2
  );
});

test("Auth.js handlers use method-aware abuse classification", () => {
  const routeSource = read("app/(auth)/api/auth/[...nextauth]/route.ts");
  const wrapperSource = read("lib/auth/abuse.ts");

  assert.match(
    routeSource,
    /export const GET = withAuthAbusePolicy\(authGET\)/
  );
  assert.match(
    routeSource,
    /export const POST = withAuthAbusePolicy\(authPOST\)/
  );
  assert.match(
    wrapperSource,
    /authAbuseRoute\(\s*request\.method,\s*new URL\(request\.url\)\.pathname,\s*options\.basePath \?\? process\.env\.NEXT_PUBLIC_BASE_PATH\s*\)/
  );
});

test("handler extraction does not include markers from a later handler", () => {
  const source = `
export async function POST(request: Request) {
  const admission = await enforceAbusePolicy({ route: "credential_write" });
  return Response.json(admission);
}

export const GET = async (request: Request) => {
  const access = await authorizeSubscriberAccess(await auth());
  return Response.json({ access, request });
};
`;

  assert.doesNotMatch(
    functionBlock(source, "POST"),
    /authorizeSubscriberAccess\(/
  );
});

test("handler wiring cannot be satisfied by a later handler", () => {
  const source = `
export function POST(request: Request) {
  return Response.json({ request });
}

export function PATCH(request: Request) {
  return writeDocument(request);
}
`;

  assert.equal(
    exportedHandlerUses(
      exportedFunctionBlock(source, "POST"),
      "POST",
      "writeDocument"
    ),
    false
  );
});

function route(
  file: string,
  handler: string,
  identityMarker: string,
  markers: string[],
  policy: string
): RouteExpectation {
  return { file, handler, identityMarker, markers, policy };
}

function read(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

function functionBlock(source: string, name: string): string {
  return declaredFunctionBlock(source, name, false);
}

function exportedFunctionBlock(source: string, name: string): string {
  return declaredFunctionBlock(source, name, true);
}

function declaredFunctionBlock(
  source: string,
  name: string,
  exported: boolean
): string {
  const sourceFile = ts.createSourceFile(
    "route.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      (!exported ||
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        ) === true)
  );

  assert.ok(
    declaration,
    `missing ${exported ? "exported " : ""}function ${name}`
  );
  return declaration.getText(sourceFile);
}

function exportedHandlerUses(
  handlerBlock: string,
  handler: string,
  implementation: string
): boolean {
  if (handler === implementation) {
    return true;
  }

  return handlerBlock.includes(`${implementation}(request)`);
}
