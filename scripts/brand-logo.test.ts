import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandMark } from "@/components/brand/brand-mark";

const repositoryRoot = new URL("../", import.meta.url);

const brandedSurfaces = [
  "app/(auth)/layout.tsx",
  "app/(chat)/layout.tsx",
  "app/security/page.tsx",
  "components/account/account-settings.tsx",
  "components/admin/warden.tsx",
  "components/chat/app-sidebar.tsx",
  "components/chat/message.tsx",
  "components/console/agent-rail.tsx",
  "components/console/primitives.tsx",
  "components/console/run-console.tsx",
  "components/console/run-thread.tsx",
  "components/demo/demo-root.tsx",
] as const;

test("the supplied OpenCoven mark has reusable web and device assets", () => {
  for (const path of [
    "public/brand/opencoven-mark.svg",
    "app/icon.png",
    "app/apple-icon.png",
    "app/favicon.ico",
  ]) {
    assert.equal(
      existsSync(new URL(path, repositoryRoot)),
      true,
      `${path} missing`
    );
  }
});

test("primary product chrome uses the shared brand mark", () => {
  const component = readFileSync(
    new URL("components/brand/brand-mark.tsx", repositoryRoot),
    "utf8"
  );

  assert.match(component, /export function BrandMark/);
  assert.match(component, /\/brand\/opencoven-mark\.svg/);

  for (const path of brandedSurfaces) {
    const source = readFileSync(new URL(path, repositoryRoot), "utf8");
    assert.match(source, /BrandMark/, `${path} does not render BrandMark`);
    assert.doesNotMatch(
      source,
      /◆/,
      `${path} still uses the placeholder glyph`
    );
  }
});

test("the shared brand mark resolves beneath the demo base path", () => {
  const previousBasePath = process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.NEXT_PUBLIC_BASE_PATH = "/demo";

  try {
    const markup = renderToStaticMarkup(createElement(BrandMark));

    assert.match(markup, /url\(\/demo\/brand\/opencoven-mark\.svg\)/);
    assert.doesNotMatch(markup, /url\(\/brand\/opencoven-mark\.svg\)/);
  } finally {
    if (previousBasePath === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_BASE_PATH = previousBasePath;
    }
  }
});

test("root metadata identifies the installed application", () => {
  const layout = readFileSync(
    new URL("app/layout.tsx", repositoryRoot),
    "utf8"
  );

  assert.match(layout, /applicationName:\s*"OpenCoven Agents"/);
  assert.match(layout, /default:\s*"OpenCoven Agents"/);
  assert.match(layout, /template:\s*"%s · OpenCoven"/);
});
