import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routes = [
  {
    file: new URL("./install/route.ts", import.meta.url),
    handlers: ["GET"],
    method: "install",
  },
  {
    file: new URL("./callback/route.ts", import.meta.url),
    handlers: ["GET"],
    method: "callback",
  },
  {
    file: new URL("./connection/route.ts", import.meta.url),
    handlers: ["GET", "DELETE"],
    method: "getConnection",
  },
] as const;

test("GitHub routes expose only their intended Next.js 16 methods", async () => {
  const sources = await Promise.all(
    routes.map(async (route) => ({
      route,
      source: await readFile(route.file, "utf8"),
    }))
  );
  for (const { route, source } of sources) {
    const exported = [
      ...source.matchAll(
        /export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gu
      ),
    ].map((match) => match[1]);
    assert.deepEqual(exported, route.handlers, route.file.pathname);
    assert.match(source, /ipAddress\(request\)/u);
    assert.match(source, /productionGitHubConnectionHandlers\(\)/u);
    assert.match(source, new RegExp(`\\.${route.method}\\(\\s*request,`, "u"));
  }
});

test("GitHub route wrappers never read or serialize secret configuration", async () => {
  const sources = await Promise.all(
    routes.map(({ file }) => readFile(file, "utf8"))
  );
  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /GITHUB_APP_PRIVATE_KEY|GITHUB_STATE_SIGNING_SECRET|authorization|token/iu
    );
  }
});

test("the connection route maps DELETE only to disconnect", async () => {
  const source = await readFile(
    new URL("./connection/route.ts", import.meta.url),
    "utf8"
  );
  const deleteBlock = source.slice(source.indexOf("function DELETE"));
  assert.match(deleteBlock, /\.disconnect\(\s*request,/u);
  assert.doesNotMatch(deleteBlock, /\.getConnection\(\s*request,/u);
});
