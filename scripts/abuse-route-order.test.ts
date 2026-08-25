import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
      exportedHandlerUses(source, expectation.handler, implementation),
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
      block.indexOf(expectation.identityMarker) < admissionIndex,
      `${expectation.file} ${expectation.handler} must establish identity first`
    );

    for (const marker of expectation.markers) {
      const markerIndex = block.indexOf(marker);
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
  const start = source.search(
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`)
  );
  assert.ok(start >= 0, `missing function ${name}`);

  const rest = source.slice(start);
  const nextExport = rest.slice(1).search(/\nexport (?:async )?function /);
  return nextExport >= 0 ? rest.slice(0, nextExport + 1) : rest;
}

function exportedHandlerUses(
  source: string,
  handler: string,
  implementation: string
): boolean {
  if (handler === implementation) {
    return new RegExp(`export (?:async )?function ${handler}\\s*\\(`).test(
      source
    );
  }

  return new RegExp(
    `export (?:async )?function ${handler}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?${implementation}\\(request\\)`
  ).test(source);
}
