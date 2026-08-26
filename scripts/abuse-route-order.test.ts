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
  file: string;
  handler: string;
  identityMarker: string;
  implementation?: string;
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
  route(
    "app/api/checkout/route.ts",
    "POST",
    "auth(",
    ["findUserById(", "new Stripe("],
    "checkout"
  ),
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
    "app/api/runner-connection/route.ts",
    "GET",
    "authorizeSubscriberAccess(",
    ["connectionDecision("],
    "runner_connection"
  ),
  route(
    "app/api/runner-token/route.ts",
    "POST",
    "authorizeSubscriberAccess(",
    ["mintRunnerToken("],
    "runner_token"
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
    ["findUserById(", "countRunsInPeriod("],
    "usage_read"
  ),
  route(
    "app/api/analytics/route.ts",
    "GET",
    "auth(",
    ["runHistory("],
    "analytics_read"
  ),
  route(
    "app/(chat)/api/models/route.ts",
    "GET",
    "GET(request",
    ["getCapabilities(", "getAllGatewayModels("],
    "model_list"
  ),
];

const excludedRoutes = [
  "app/api/internal/credential/route.ts",
  "app/api/stripe/webhook/route.ts",
];

test("resource-bearing handlers admit after identity and before expensive work", () => {
  for (const expectation of protectedHandlers) {
    const source = read(expectation.file);
    const implementation = expectation.implementation ?? expectation.handler;
    const handlerBlock = exportedFunctionBlock(source, expectation.handler);
    const block = functionBlock(source, implementation);
    const admissionIndex = block.indexOf("enforceAbusePolicy({");

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

test("deferred webhook and internal lending routes stay untouched", () => {
  for (const file of excludedRoutes) {
    assert.doesNotMatch(read(file), /enforceAbusePolicy/);
  }
});

test("costly creates claim idempotency before calling their provider", () => {
  for (const [file, providerMarker] of [
    ["app/api/checkout/route.ts", "stripe.subscriptions.list("],
    ["app/api/credentials/device/route.ts", "startDeviceFlow("],
  ] as const) {
    const source = read(file);
    const block = exportedFunctionBlock(source, "POST");
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
  const checkoutSource = read("app/api/checkout/route.ts");

  assert.match(
    deviceSource,
    /encryptedIdempotencyResponseStorage\(credentialKek\)/
  );
  assert.match(
    functionBlock(deviceSource, "POST"),
    /responseStorage:\s*deviceStartResponseStorage/
  );
  assert.match(
    functionBlock(checkoutSource, "POST"),
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

test("latest migration replaces ambiguous responses with tagged envelopes", () => {
  const journal = JSON.parse(read("lib/db/migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const latest = journal.entries.at(-1);

  assert.ok(latest);
  assert.equal(latest.idx, journal.entries.length - 1);

  const migration = read(`lib/db/migrations/${latest.tag}.sql`);
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

  const snapshot = read(
    `lib/db/migrations/meta/${String(latest.idx).padStart(4, "0")}_snapshot.json`
  );
  assert.match(snapshot, /responseJson.*is not null/is);
  assert.match(snapshot, /jsonb_typeof.*responseJson.*object/is);
  assert.match(snapshot, /responseStatus.*is not null/is);
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
    2
  );
});

test("database cleanup is bounded, state-agnostic, and awaited before claims", () => {
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
    /\.where\(\s*and\(\s*inArray\(idempotencyRecord\.id, expired\),\s*lte\(idempotencyRecord\.expiresAt, input\.before\)\s*\)\s*\)/
  );
  assert.match(cleanupSource, /\.limit\(input\.limit\)/);
  assert.doesNotMatch(cleanupSource, /idempotencyRecord\.state/);
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
  const exportPrefix = exported ? "export\\s+" : "(?:export\\s+)?";
  const declarationPattern = new RegExp(
    `${exportPrefix}(?:async\\s+)?function\\s+${name}\\s*\\(`
  );
  const declaration = declarationPattern.exec(source);

  assert.ok(
    declaration,
    `missing ${exported ? "exported " : ""}function ${name}`
  );
  const bodyStart = source.indexOf("{", declaration.index);
  assert.notEqual(bodyStart, -1, `missing function body for ${name}`);

  const bodyEnd = matchingBrace(source, bodyStart);
  assert.notEqual(bodyEnd, -1, `unterminated function body for ${name}`);
  return source.slice(declaration.index, bodyEnd + 1);
}

function matchingBrace(source: string, openingBrace: number): number {
  let depth = 0;
  let state:
    | "block-comment"
    | "code"
    | "double-quote"
    | "line-comment"
    | "single-quote"
    | "template" = "code";

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (
      state === "single-quote" ||
      state === "double-quote" ||
      state === "template"
    ) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (
        (state === "single-quote" && character === "'") ||
        (state === "double-quote" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (character === "'") {
      state = "single-quote";
    } else if (character === '"') {
      state = "double-quote";
    } else if (character === "`") {
      state = "template";
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
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
