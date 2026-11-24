import { spawnSync } from "node:child_process";
import { expect, type Page, type Request, test } from "@playwright/test";
import postgres from "postgres";
import {
  HERMETIC_USERS,
  incrementHermeticAuthVersion,
  seedHermeticUsers,
} from "./hermetic-db";
import { sessionCookies } from "./session";

const CHAT_PATH = "/chat/30000000-0000-4000-8000-000000000001";

function credentialField(page: Page) {
  return page.getByLabel(/^GitHub Copilot CLI(?: credential)?$/);
}

function database() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("A disposable database is required.");
  }
  return postgres(url, { max: 1 });
}

function isAuthJsSessionRead(request: Request): boolean {
  return request.headers()["content-type"] === "application/json";
}

async function controlSessionReads(page: Page) {
  const network = {
    authJsFailures: 0,
    blockAuthJsReads: false,
    successfulReadsRemaining: Number.POSITIVE_INFINITY,
  };
  await page.route("**/api/auth/session", async (route) => {
    const authJsRead = isAuthJsSessionRead(route.request());
    const unavailable = () =>
      network.successfulReadsRemaining <= 0 ||
      (network.blockAuthJsReads && authJsRead);
    const refuse = () => {
      if (network.blockAuthJsReads && authJsRead) {
        network.authJsFailures += 1;
      }
      return route.abort("failed");
    };
    if (unavailable()) {
      return refuse();
    }
    const response = await route.fetch();
    // Drop an in-flight initial read too when the network fails. Otherwise its
    // late success can undo the deliberately failed refocus in this test.
    if (unavailable()) {
      return refuse();
    }
    network.successfulReadsRemaining -= 1;
    return route.fulfill({ response });
  });
  return network;
}

async function interruptSessionReads(
  page: Page,
  network: { successfulReadsRemaining: number }
) {
  network.successfulReadsRemaining = 0;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange"))
  );
  await expect(
    page.getByRole("button", { name: "Retry session verification" })
  ).toBeVisible();
  await expect(credentialField(page)).toHaveCount(0);
}

async function expectRecovered(page: Page) {
  await expect(page).toHaveURL(/\/login\?.*reason=session-expired/);
  await expect(page.getByRole("status")).toContainText(
    "Your session has expired. Sign in again to continue."
  );
  await expect
    .poll(async () =>
      (await page.context().cookies()).some((cookie) =>
        cookie.name.includes("authjs.session-token")
      )
    )
    .toBe(false);
  expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  expect((await page.request.get("/api/credentials")).status()).toBe(401);
}

function accountCommand(script: "account" | "subscription", args: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=react-server",
      `scripts/${script}.ts`,
      ...args,
    ],
    {
      encoding: "utf8",
      env: process.env,
      input:
        script === "subscription" ? "hermetic-session-recovery\n" : undefined,
      timeout: 15_000,
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

test.describe("hermetic session recovery", () => {
  test.describe.configure({ mode: "serial", timeout: 60_000 });
  test.skip(
    process.env.E2E_HERMETIC_RUNNER !== "1" || process.env.IS_DEMO === "1"
  );

  test.beforeEach(async ({ page }) => {
    const url = process.env.POSTGRES_URL;
    if (!url) {
      throw new Error("A disposable database is required.");
    }
    await seedHermeticUsers(url);
    await page.route("**/*", (route) => {
      const requestUrl = new URL(route.request().url());
      // Model catalog discovery is unrelated to auth and otherwise calls the
      // public AI Gateway catalog. All session and protected APIs stay real.
      if (requestUrl.pathname.endsWith("/api/models")) {
        return route.fulfill({ json: {} });
      }
      return requestUrl.hostname === "localhost"
        ? route.continue()
        : route.abort("blockedbyclient");
    });
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "wait" });
  });

  for (const path of ["/account", "/agents", CHAT_PATH]) {
    test(`a revoked cookie cannot render an authenticated shell on entry: ${path}`, async ({
      page,
    }) => {
      const account = HERMETIC_USERS.subscriberA;
      await page
        .context()
        .addCookies(await sessionCookies("subscriber", account));
      await incrementHermeticAuthVersion(account.id);
      await page.goto(path);
      await expectRecovered(page);
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Continue with GitHub" })
      ).toBeVisible();
    });
  }

  test("a grant invalidates the old guest JWT; a fresh login obtains new authority", async ({
    page,
  }) => {
    const account = HERMETIC_USERS.ineligible;
    const oldCookie = await sessionCookies("demo", account);
    await page.context().addCookies(oldCookie);
    await page.goto("/account");
    await expect(
      page.getByRole("heading", { name: "Harness credentials" })
    ).toBeVisible();
    accountCommand("subscription", [
      "grant",
      account.email,
      "30",
      "--reference-stdin",
    ]);
    expect((await page.request.get("/api/subscription")).status()).toBe(401);
    await page.reload();
    await expectRecovered(page);

    // The rejected JWT cannot be recycled even after the browser was cleared.
    await page.context().addCookies(oldCookie);
    await page.goto("/agents");
    await expectRecovered(page);

    // Only a newly issued, locally signed login fixture gets the new version.
    await page.context().addCookies(
      await sessionCookies("subscriber", {
        ...account,
        authVersion: account.authVersion + 1,
        subscribedUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
    );
    await page.goto("/account");
    await expect(credentialField(page)).toBeVisible();
    expect((await page.request.get("/api/credentials")).status()).toBe(200);
    const session = await (await page.request.get("/api/auth/session")).json();
    expect(session.user.authVersion).toBe(account.authVersion + 1);
    expect(session.user.type).toBe("subscriber");
  });

  for (const surface of ["account", "console"] as const) {
    test(`a mounted ${surface} credential save recovers after account revoke-sessions`, async ({
      page,
    }) => {
      const account = HERMETIC_USERS.subscriberA;
      await page
        .context()
        .addCookies(await sessionCookies("subscriber", account));
      await page.goto(surface === "account" ? "/account" : "/agents");
      if (surface === "console") {
        await page
          .getByRole("button", { name: "Account and settings" })
          .click();
      }
      await credentialField(page).fill("hermetic-never-saved-token");
      accountCommand("account", ["revoke-sessions", account.email]);
      const refusal = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/credentials") &&
          response.request().method() === "POST"
      );
      if (surface === "account") {
        await expect(
          page.getByLabel("Codex CLI", { exact: true })
        ).toBeVisible();
        await expect(
          page.getByLabel("Claude Code", { exact: true })
        ).toBeVisible();
      }
      await page
        .getByRole("button", {
          exact: true,
          name:
            surface === "account"
              ? "Save GitHub Copilot CLI credential"
              : "Save",
        })
        .click();
      expect((await refusal).status()).toBe(401);
      await expectRecovered(page);
      await expect(
        page.locator('input[value="hermetic-never-saved-token"]')
      ).toHaveCount(0);
    });
  }

  test("an already-open chat recovers when Auth.js observes revocation on refocus", async ({
    page,
  }) => {
    const account = HERMETIC_USERS.subscriberA;
    await page
      .context()
      .addCookies(await sessionCookies("subscriber", account));
    const historyLoaded = page.waitForResponse(
      (response) =>
        response.url().includes("/api/messages?") && response.status() === 200
    );
    await page.goto(CHAT_PATH);
    await historyLoaded;
    await page.getByTestId("multimodal-input").fill("Do not call any model.");
    accountCommand("account", ["revoke-sessions", account.email]);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await expectRecovered(page);
  });

  test("concurrent authentication refusals share one bounded recovery read", async ({
    page,
  }) => {
    const account = HERMETIC_USERS.subscriberA;
    await page
      .context()
      .addCookies(await sessionCookies("subscriber", account));
    await page.goto("/account");
    await expect(credentialField(page)).toBeVisible();
    accountCommand("account", ["revoke-sessions", account.email]);
    let recoveryReads = 0;
    let navigating = false;
    page.on("request", (request) => {
      if (request.isNavigationRequest()) {
        navigating = true;
      }
      // Auth.js also reads this endpoint independently of the recovery flow.
      if (
        !navigating &&
        request.url().endsWith("/api/auth/session") &&
        !isAuthJsSessionRead(request)
      ) {
        recoveryReads += 1;
      }
    });
    const refusal = await page.evaluate(async () => {
      const response = await fetch("/api/credentials");
      if (response.status === 401) {
        for (let index = 0; index < 20; index += 1) {
          window.dispatchEvent(new Event("coven:session-reauthentication"));
        }
      }
      return response.status;
    });
    expect(refusal).toBe(401);
    await expectRecovered(page);
    expect(recoveryReads).toBe(1);
  });

  test("a billing lapse is a subscription denial, never identity revocation", async ({
    page,
  }) => {
    const account = HERMETIC_USERS.subscriberA;
    await page
      .context()
      .addCookies(await sessionCookies("subscriber", account));
    await page.goto("/account");
    await credentialField(page).fill("hermetic-never-saved-token");
    await page.route("**/api/credentials", async (route) => {
      if (route.request().method() === "POST") {
        // Expire after the mounted form submits, before the real API admits it.
        const sql = database();
        try {
          await sql`UPDATE "User" SET "subscribedUntil" = now() - interval '1 day' WHERE id = ${account.id}`;
        } finally {
          await sql.end();
        }
      }
      await route.fallback();
    });
    const refusal = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/credentials") &&
        response.request().method() === "POST"
    );
    await page
      .getByRole("button", {
        exact: true,
        name: "Save GitHub Copilot CLI credential",
      })
      .click();
    expect((await refusal).status()).toBe(403);
    await expect(page).toHaveURL(/\/account$/);
    expect(
      (await (await page.request.get("/api/auth/session")).json()).user.id
    ).toBe(account.id);
    const subscription = await page.request.get("/api/subscription");
    expect(subscription.status()).toBe(200);
    expect((await subscription.json()).active).toBe(false);
    await expect(credentialField(page)).toHaveCount(0);
  });

  test("storage failure returns subscription 503 and preserves the real session cookie", async ({
    page,
  }) => {
    const account = HERMETIC_USERS.subscriberA;
    await page
      .context()
      .addCookies(await sessionCookies("subscriber", account));
    await page.goto("/account");
    await expect(credentialField(page)).toBeVisible();
    const sql = database();
    try {
      await sql`ALTER TABLE "User" RENAME TO "User_session_outage"`;
      expect((await page.request.get("/api/subscription")).status()).toBe(503);
      const session = await page.request.get("/api/auth/session");
      expect(session.status()).toBe(200);
      expect((await session.json()).user.authVersion).toBe(account.authVersion);
      await page.reload();
      await expect(page).toHaveURL(/\/account$/);
      expect(
        (await page.context().cookies()).some((cookie) =>
          cookie.name.includes("authjs.session-token")
        )
      ).toBe(true);
      await expect(
        page.getByText("Your session has expired. Sign in again to continue.")
      ).toHaveCount(0);
    } finally {
      await sql`ALTER TABLE "User_session_outage" RENAME TO "User"`;
      await sql.end();
    }
    await page.reload();
    await expect(credentialField(page)).toBeVisible();
  });

  for (const surface of ["account", "console"] as const) {
    test(`retry restores the mounted provider state: ${surface}`, async ({
      page,
    }) => {
      const account = HERMETIC_USERS.subscriberA;
      const network = await controlSessionReads(page);
      await page
        .context()
        .addCookies(await sessionCookies("subscriber", account));
      await page.goto(surface === "account" ? "/account" : "/agents");
      if (surface === "console") {
        await page
          .getByRole("button", { name: "Account and settings" })
          .click();
      }
      await expect(credentialField(page)).toBeVisible();
      let navigations = 0;
      page.on("request", (request) => {
        if (request.isNavigationRequest()) {
          navigations += 1;
        }
      });
      await interruptSessionReads(page, network);
      await expect(credentialField(page)).toHaveCount(0);
      network.successfulReadsRemaining = Number.POSITIVE_INFINITY;
      await page
        .getByRole("button", { name: "Retry session verification" })
        .click();
      if (surface === "console") {
        await expect(
          page.getByRole("button", { name: "Account and settings" })
        ).toHaveAttribute("title", account.email);
        await page
          .getByRole("button", { name: "Account and settings" })
          .click();
      }
      await expect(credentialField(page)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Retry session verification" })
      ).toHaveCount(0);
      const focusRead = page.waitForRequest((request) =>
        request.url().endsWith("/api/auth/session")
      );
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange"))
      );
      expect((await (await focusRead).response())?.status()).toBe(200);
      expect(navigations).toBe(0);
      expect(
        (await page.context().cookies()).some((cookie) =>
          cookie.name.includes("authjs.session-token")
        )
      ).toBe(true);
    });
  }

  test("a failed provider resynchronization keeps explicit retry available", async ({
    page,
  }) => {
    const network = await controlSessionReads(page);
    await page
      .context()
      .addCookies(
        await sessionCookies("subscriber", HERMETIC_USERS.subscriberA)
      );
    await page.goto("/account");
    await expect(credentialField(page)).toBeVisible();
    await interruptSessionReads(page, network);
    network.successfulReadsRemaining = Number.POSITIVE_INFINITY;
    network.blockAuthJsReads = true;
    const confirmed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/session") &&
        response.status() === 200
    );
    await page
      .getByRole("button", { name: "Retry session verification" })
      .click();
    await confirmed;
    await expect(
      page.getByRole("button", { name: "Retry session verification" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry session verification" })
    ).toBeEnabled();
    expect(network.authJsFailures).toBeGreaterThan(0);
    await expect(credentialField(page)).toHaveCount(0);
    network.blockAuthJsReads = false;
    await page
      .getByRole("button", { name: "Retry session verification" })
      .click();
    await expect(credentialField(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry session verification" })
    ).toHaveCount(0);
  });

  test("the recovery marker is not authority and cannot revoke a current cookie", async ({
    page,
  }) => {
    const login = "/login?reason=session-expired";
    await page.goto(login);
    expect(
      (
        await page.request.get("/api/credentials?reason=session-expired")
      ).status()
    ).toBe(401);

    const account = HERMETIC_USERS.subscriberA;
    await page
      .context()
      .addCookies(await sessionCookies("subscriber", account));
    await page.goto(login);
    await expect(
      page.getByRole("button", { name: "Continue with GitHub" })
    ).toBeVisible();
    const current = await page.request.get("/api/auth/session");
    expect(current.status()).toBe(200);
    expect((await current.json()).user.authVersion).toBe(account.authVersion);
    expect(
      (await page.context().cookies()).some((cookie) =>
        cookie.name.includes("authjs.session-token")
      )
    ).toBe(true);
    expect(
      (
        await page.request.get("/api/credentials?reason=session-expired")
      ).status()
    ).toBe(200);

    await incrementHermeticAuthVersion(account.id);
    expect(
      (
        await page.request.get("/api/credentials?reason=session-expired")
      ).status()
    ).toBe(401);
    await page.goto(login);
    await expectRecovered(page);
  });

  test("new visitors retain the normal sign-in gate without an expiry message", async ({
    page,
  }) => {
    await page.goto("/account");
    await expect(
      page.getByRole("heading", { name: "Sign in to manage your account" })
    ).toBeVisible();
    await expect(
      page.getByText("Your session has expired. Sign in again to continue.")
    ).toHaveCount(0);
  });
});

test("hermetic base-path recovery clears the revoked cookie without a doubled demo prefix", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_HERMETIC_RUNNER !== "1" || process.env.IS_DEMO !== "1"
  );
  const account = HERMETIC_USERS.subscriberA;
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("A disposable database is required.");
  }
  await seedHermeticUsers(url);
  await page.context().addCookies(await sessionCookies("subscriber", account));
  await incrementHermeticAuthVersion(account.id);
  await page.goto("/demo/account");
  await expect(page).toHaveURL(
    /\/demo\/login\?callbackUrl=%2Fdemo%2Faccount&reason=session-expired$/
  );
  await expect(page.getByRole("status")).toContainText(
    "Your session has expired."
  );
  await expect
    .poll(async () =>
      (await page.context().cookies()).some((cookie) =>
        cookie.name.includes("authjs.session-token")
      )
    )
    .toBe(false);
  expect(
    await (await page.request.get("/demo/api/auth/session")).json()
  ).toBeNull();
});
