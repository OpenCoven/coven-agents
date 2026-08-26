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
    ["request.json(", "getMessageCountByUserId("],
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
    ["request.formData(", "put("],
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
    ["request.json(", "exchangeDeviceCode("],
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
    ["request.json(", "checkCopilotToken(", "putCredential("],
    "credential_write"
  ),
  route(
    "app/api/credentials/route.ts",
    "DELETE",
    "authorizeSubscriberAccess(",
    ["request.json(", "deleteCredential("],
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
      ["request.json(", "getDocumentsById(", "saveDocument("],
      "document_write"
    ),
    implementation: "writeDocument",
  },
  {
    ...route(
      "app/(chat)/api/document/route.ts",
      "PATCH",
      "authorizeSubscriberAccess(",
      ["request.json(", "getDocumentsById(", "saveDocument("],
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
    ["request.json(", "getChatById(", "voteMessage("],
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
  "app/(auth)/api/auth/[...nextauth]/route.ts",
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

test("deferred auth, webhook, and internal lending routes stay untouched", () => {
  for (const file of excludedRoutes) {
    assert.doesNotMatch(read(file), /enforceAbusePolicy/);
  }
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
