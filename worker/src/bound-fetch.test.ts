import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sources = [
  "agents.ts",
  "routes.ts",
  "tenant-credentials.ts",
  "tenant.ts",
].map((name) => ({
  name,
  text: readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
}));

test("no Workers built-in is passed detached from its receiver", () => {
  // `fetchImpl: fetch` throws "Illegal invocation: function called with
  // incorrect `this` reference" the moment it is called in a Worker. It
  // type-checks, it lints, and every node-based test passes -- the failure
  // only exists in the Workers runtime, where it surfaced as a run that
  // failed with zero commands and zero file operations because the credential
  // fetch died before the sandbox started.
  const detached = /(?:fetchImpl|fetchFn|doFetch)\s*[:=]\s*fetch\s*[,;)]/;

  for (const source of sources) {
    assert.doesNotMatch(
      source.text,
      detached,
      `${source.name} passes fetch detached; wrap it as (input, init) => fetch(input, init)`
    );
  }
});

test("no source carries a raw control character", () => {
  /**
   * A separator written as a literal NUL rather than an escape compiles and
   * passes its tests, and is invisible in review -- but a file containing one
   * reads as binary to `grep`, which then silently reports no matches in it
   * rather than saying why. Anything that inherits that behaviour goes quiet
   * on the file too.
   *
   * Tab and newline are the only control characters a source legitimately
   * contains.
   */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

  for (const source of sources) {
    const found = control.exec(source.text);

    assert.equal(
      found,
      null,
      `${source.name} contains a raw control character (${JSON.stringify(
        found?.[0]
      )}); write it as an escape instead`
    );
  }
});

test("the credential fetch passes a wrapper", () => {
  const agents = sources.find((source) => source.name === "agents.ts");

  assert.match(
    agents?.text ?? "",
    /fetchImpl:\s*\(input,\s*init\)\s*=>\s*fetch\(input,\s*init\)/
  );
});
