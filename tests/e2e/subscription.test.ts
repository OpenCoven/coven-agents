import {
  type BrowserContext,
  expect,
  type Page,
  type Request,
  type Route,
  test,
} from "@playwright/test";
import { E2E_USER_ID, sessionCookies } from "./session";

const CHECKOUT_ENABLED = process.env.SUBSCRIPTION_CHECKOUT_ENABLED === "on";
const SUBSCRIBED_UNTIL = "2099-01-15T12:00:00.000Z";

type SessionType = "demo" | "subscriber";

function sessionFor(
  type: SessionType,
  {
    authVersion = 1,
    email = "e2e-user@example.invalid",
    id = E2E_USER_ID,
  }: { authVersion?: number; email?: string; id?: string } = {}
) {
  return {
    expires: "2099-01-01T00:00:00.000Z",
    user: {
      authVersion,
      email,
      id,
      image: null,
      name: "E2E subscriber",
      type,
    },
  };
}

async function notifySessionChange(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const channel = new BroadcastChannel("next-auth");
    channel.postMessage({ event: "session" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.postMessage({ event: "session" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.close();
  });
}

async function mockSession(page: Page, type: SessionType): Promise<void> {
  await setServerSession(page.context(), type);
  await page.route("**/api/auth/csrf", (route) =>
    route.fulfill({ json: { csrfToken: "e2e-csrf" } })
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: sessionFor(type) })
  );
}

async function setServerSession(
  context: BrowserContext,
  type: SessionType,
  options: { authVersion?: number; email?: string; id?: string } = {}
): Promise<void> {
  await context.addCookies(await sessionCookies(type, options));
}

async function mockAccountDependencies(page: Page): Promise<void> {
  await page.route("**/api/credentials", (route) =>
    route.fulfill({ json: { harnessIds: [] } })
  );
}

async function mockSubscriberConsoleDependencies(page: Page): Promise<void> {
  await page.route("**/api/tenant/prewarm", (route) =>
    route.fulfill({ status: 204 })
  );
  await page.route("**/api/credentials", (route) =>
    route.fulfill({ json: { harnessIds: [] } })
  );
  await page.route("**/api/usage", (route) =>
    route.fulfill({
      json: {
        cap: 750,
        resetsAt: "2099-02-01T00:00:00.000Z",
        used: 0,
      },
    })
  );
  await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
    const { pathname } = new URL(route.request().url());
    return route.fulfill(
      pathname === "/api/agents"
        ? { json: { agents: [] } }
        : { json: { apiVersion: "1.0", runs: [] } }
    );
  });
}

async function openConsoleSettings(page: Page): Promise<void> {
  await page.goto("/agents");
  const accountSettings = page.getByRole("button", {
    name: "Account and settings",
  });
  await expect(accountSettings).toBeVisible();
  await accountSettings.click();
}

function subscriptionStatus(active: boolean) {
  return {
    active,
    checkoutEnabled: CHECKOUT_ENABLED,
    subscribedUntil: active ? SUBSCRIBED_UNTIL : null,
  };
}

function isServerComponentRequest(request: Request): boolean {
  const url = new URL(request.url());
  return request.headers().rsc === "1" || url.searchParams.has("_rsc");
}

function checkoutButton(page: Page) {
  return page.getByRole("button", {
    name: "Continue to secure checkout",
  });
}

function idempotencyKey(request: Request): string {
  const key = request.headers()["idempotency-key"];
  expect(key).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  return key;
}

function signOutCallback(request: Request): string | null {
  return new URLSearchParams(request.postData() ?? "").get("callbackUrl");
}

async function openEligibleAccount(page: Page): Promise<void> {
  await mockSession(page, "demo");
  await mockAccountDependencies(page);
  await page.goto("/account");
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(checkoutButton(page)).toBeVisible();
}

async function installSubscriptionBodyMock(
  page: Page,
  closeAfterMs: number | null
): Promise<void> {
  await page.addInitScript(
    ({ activeBody, delay }) => {
      const originalFetch = window.fetch;
      const state = {
        aborts: 0,
        calls: 0,
        lateBodyWrites: 0,
      };
      Object.assign(window, { __subscriptionBodyMock: state });
      window.fetch = (input, init) => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (
          new URL(rawUrl, window.location.href).pathname.endsWith(
            "/api/subscription"
          )
        ) {
          state.calls += 1;
          let bodyController: ReadableStreamDefaultController<Uint8Array>;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              controller.enqueue(
                new TextEncoder().encode(activeBody.slice(0, 12))
              );
              if (delay !== null) {
                setTimeout(() => {
                  try {
                    controller.enqueue(
                      new TextEncoder().encode(activeBody.slice(12))
                    );
                    controller.close();
                  } catch {
                    state.lateBodyWrites += 1;
                  }
                }, delay);
              }
            },
          });
          init?.signal?.addEventListener(
            "abort",
            () => {
              state.aborts += 1;
              try {
                bodyController.error(
                  new DOMException("The operation was aborted.", "AbortError")
                );
              } catch {
                // The delayed writer may already have closed the stream.
              }
            },
            { once: true }
          );
          return Promise.resolve(
            new Response(body, {
              headers: { "content-type": "application/json" },
              status: 200,
            })
          );
        }
        return originalFetch.call(window, input, init);
      };
    },
    {
      activeBody: JSON.stringify(subscriptionStatus(true)),
      delay: closeAfterMs,
    }
  );
}

function subscriptionBodyMockState(
  page: Page
): Promise<{ aborts: number; calls: number; lateBodyWrites: number }> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __subscriptionBodyMock: {
            aborts: number;
            calls: number;
            lateBodyWrites: number;
          };
        }
      ).__subscriptionBodyMock
  );
}

test.describe("Subscriber checkout", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("account and console sign-out callbacks target the application login path", async ({
    page,
  }) => {
    const callbacks: Array<string | null> = [];
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: sessionFor("subscriber") })
    );
    await page.route("**/api/auth/csrf", (route) =>
      route.fulfill({ json: { csrfToken: "e2e-csrf" } })
    );
    await page.route("**/api/auth/signout", (route) => {
      callbacks.push(signOutCallback(route.request()));
      return route.fulfill({ json: { url: "/login" } });
    });
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );

    await page.goto("/account");
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect.poll(() => callbacks).toEqual(["/login"]);

    await mockSubscriberConsoleDependencies(page);
    await page.goto("/agents");
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page.getByRole("tab", { exact: true, name: "Account" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();

    await expect.poll(() => callbacks).toEqual(["/login", "/login"]);
  });

  test("flag off hides billing from non-subscribers and ignores inexact checkout values", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account?checkout=SUCCESS");
    await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    await expect(checkoutButton(page)).toHaveCount(0);

    await openConsoleSettings(page);
    await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    await expect(checkoutButton(page)).toHaveCount(0);
  });

  test("flag on presents the same restrained 750-run offer on both account surfaces", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    const accountCard = page.locator(".oc-subscription-card");
    await expect(accountCard).toContainText("750 runs");
    await expect(accountCard).toContainText("each month");
    await expect(accountCard).toContainText(
      "Stripe shows the configured amount before purchase"
    );
    await expect(checkoutButton(page)).toBeVisible();
    const accountOffer = await accountCard.innerText();

    await openConsoleSettings(page);
    await page.getByRole("tab", { name: "Billing" }).click();
    const consoleCard = page.locator(".oc-subscription-card");
    await expect(consoleCard).toContainText("750 runs");
    await expect(checkoutButton(page)).toBeVisible();
    expect(await consoleCard.innerText()).toBe(accountOffer);
    expect(accountOffer).not.toMatch(/[$€£]|\b(?:USD|EUR|GBP)\b/);
  });

  test("subscriber billing remains visible with the flag off and never offers a duplicate purchase", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    await mockSession(page, "subscriber");
    await mockAccountDependencies(page);
    await mockSubscriberConsoleDependencies(page);
    let statusReads = 0;
    await page.route("**/api/subscription", (route) => {
      statusReads += 1;
      return route.fulfill({ json: subscriptionStatus(true) });
    });

    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(page.getByText("January 15, 2099")).toBeVisible();
    await expect(checkoutButton(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /manage|cancel/i })
    ).toHaveCount(0);

    await openConsoleSettings(page);
    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(checkoutButton(page)).toHaveCount(0);
    await expect.poll(() => statusReads).toBe(2);
  });

  test("a successful return opens billing while disabled, stays confirming while inactive, and preserves the full URL", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await mockSession(page, "demo");
    await mockAccountDependencies(page);
    let statusReads = 0;
    await page.route("**/api/subscription", (route) => {
      statusReads += 1;
      return route.fulfill({ json: subscriptionStatus(false) });
    });

    await page.goto("/account?source=ledger&checkout=success#allowance");

    await expect(page.getByRole("tab", { name: "Billing" })).toBeVisible();
    await expect(page.getByText("Confirming payment")).toBeVisible();
    await expect(page.getByText("Subscription active")).toHaveCount(0);
    await expect(checkoutButton(page)).toHaveCount(0);
    await expect(page).toHaveURL(
      "/account?source=ledger&checkout=success#allowance"
    );
    await expect.poll(() => statusReads).toBeGreaterThan(0);
  });

  test("reloading an inactive successful return resumes confirmation with the flag off and cleans only after activation", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await mockSession(page, "demo");
    let active = false;
    let statusReads = 0;
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) => {
      statusReads += 1;
      return route.fulfill({ json: subscriptionStatus(active) });
    });

    await page.goto("/account?source=ledger&checkout=success#allowance");
    await expect.poll(() => statusReads).toBeGreaterThan(0);
    const readsBeforeReload = statusReads;
    await page.reload();

    await expect(page.getByRole("tab", { name: "Billing" })).toBeVisible();
    await expect(page.getByText("Confirming payment")).toBeVisible();
    await expect(page).toHaveURL(
      "/account?source=ledger&checkout=success#allowance"
    );
    await expect.poll(() => statusReads).toBeGreaterThan(readsBeforeReload);

    await setServerSession(page.context(), "subscriber");
    active = true;

    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(page).toHaveURL("/account?source=ledger#allowance");
  });

  test("successful confirmation continues under another account tab for the same owner", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    const currentSession = sessionFor("demo");
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let reads = 0;
    await setServerSession(page.context(), "demo");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", async (route) => {
      reads += 1;
      await statusGate;
      await setServerSession(page.context(), "subscriber");
      await route
        .fulfill({ json: subscriptionStatus(true) })
        .catch(() => undefined);
    });

    await page.goto("/account?checkout=success");
    await expect.poll(() => reads).toBe(1);
    await page.getByRole("tab", { name: "Profile" }).click();
    releaseStatus();

    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(page).toHaveURL("/account");
  });

  test("a hidden successful return keeps user A as owner when the session changes to user B", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    let currentSession = sessionFor("demo");
    let reads = 0;
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) => {
      reads += 1;
      return route.fulfill({ json: subscriptionStatus(false) });
    });

    await page.goto("/account?checkout=success");
    await expect.poll(() => reads).toBe(1);
    await page.getByRole("tab", { name: "Profile" }).click();

    currentSession = sessionFor("demo", {
      email: "second@example.invalid",
      id: "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
    });
    await notifySessionChange(page);
    const readsBeforeReopen = reads;

    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(page.getByRole("status")).toContainText(
      "The signed-in account changed."
    );
    await page.waitForTimeout(1200);
    expect(reads).toBe(readsBeforeReopen);
  });

  test("a successful return never rebinds after its established owner signs out", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    let currentSession: ReturnType<typeof sessionFor> | null =
      sessionFor("demo");
    let reads = 0;
    await page.route("**/api/auth/session", (route) =>
      currentSession
        ? route.fulfill({ json: currentSession })
        : route.fulfill({ body: "null", contentType: "application/json" })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) => {
      reads += 1;
      return route.fulfill({ json: subscriptionStatus(false) });
    });

    await page.goto("/account?checkout=success");
    await expect.poll(() => reads).toBe(1);

    currentSession = null;
    await notifySessionChange(page);
    await expect(
      page.getByRole("heading", { name: "Sign in to manage your account" })
    ).toBeVisible();

    currentSession = sessionFor("demo", {
      email: "second@example.invalid",
      id: "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
    });
    await notifySessionChange(page);
    await expect(page.getByRole("status")).toContainText(
      "The signed-in account changed."
    );
    await page.waitForTimeout(1200);
    expect(reads).toBe(1);
  });

  test("database activation refreshes the server route once without an Auth.js mutation or reload", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await mockSession(page, "demo");
    let authSessionPosts = 0;
    const authSessionSetCookies: string[] = [];
    let accountDocuments = 0;
    let serverRefreshes = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/auth/session" && request.method() === "POST") {
        authSessionPosts += 1;
      }
      if (url.pathname === "/account" && isServerComponentRequest(request)) {
        serverRefreshes += 1;
      }
      if (
        request.resourceType() === "document" &&
        url.pathname === "/account"
      ) {
        accountDocuments += 1;
      }
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return;
      }
      const setCookie = response.headers()["set-cookie"];
      if (setCookie) {
        authSessionSetCookies.push(setCookie);
      }
    });
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", async (route) => {
      await setServerSession(page.context(), "subscriber");
      await route.fulfill({ json: subscriptionStatus(true) });
    });

    await page.goto("/account?source=ledger&checkout=success#allowance");
    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(page).toHaveURL("/account?source=ledger#allowance");
    expect(accountDocuments).toBe(1);
    expect(serverRefreshes).toBe(1);
    expect(authSessionPosts).toBe(0);
    expect(authSessionSetCookies).toEqual([]);
  });

  test("an unchanged server authority stops at the deadline without a refresh loop and Check again starts one new generation", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await page.clock.install({
      time: new Date("2026-08-31T14:25:01.000Z"),
    });
    await mockSession(page, "demo");
    let serverRefreshes = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/account" &&
        isServerComponentRequest(request)
      ) {
        serverRefreshes += 1;
      }
    });
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );

    await page.goto("/account?checkout=success");
    await expect(page.getByRole("status")).toContainText("Finalizing");
    await expect.poll(() => serverRefreshes).toBe(1);
    await page.clock.runFor(15_000);
    await expect(page.getByRole("status")).toContainText(
      "Payment may still be processing."
    );
    await expect(page).toHaveURL("/account?checkout=success");
    expect(serverRefreshes).toBe(1);

    await page.getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => serverRefreshes).toBe(2);
  });

  test("a delayed user-A refresh cannot activate user B or overwrite B cookies after the identity changes", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    const secondUserId = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";
    let currentSession = sessionFor("demo");
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let serverRefreshes = 0;
    await setServerSession(page.context(), "demo");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await page.route("**/account?**", async (route) => {
      if (isServerComponentRequest(route.request())) {
        serverRefreshes += 1;
        await refreshGate;
      }
      await route.continue();
    });
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", async (route) => {
      await setServerSession(page.context(), "subscriber", {
        email: "second@example.invalid",
        id: secondUserId,
      });
      await route.fulfill({ json: subscriptionStatus(true) });
    });

    await page.goto("/account?checkout=success");
    await expect.poll(() => serverRefreshes).toBe(1);
    await page.context().addCookies([
      {
        name: "activation-owner",
        url: new URL(page.url()).origin,
        value: "user-b",
      },
    ]);
    currentSession = sessionFor("demo", {
      email: "second@example.invalid",
      id: secondUserId,
    });
    await notifySessionChange(page);
    releaseRefresh();

    await expect(page.getByText("second@example.invalid")).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "The signed-in account changed."
    );
    await expect(page.getByText("Subscription active")).toHaveCount(0);
    await expect(page).toHaveURL("/account?checkout=success");
    expect(serverRefreshes).toBe(1);
    expect(
      (await page.context().cookies()).find(
        (cookie) => cookie.name === "activation-owner"
      )?.value
    ).toBe("user-b");
  });

  test("a full reload uses paid server authority despite a stale demo client session", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: sessionFor("demo") })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );

    await page.goto("/account?source=ledger&checkout=success#allowance");

    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(page.getByText("January 15, 2099")).toBeVisible();
    await expect(page).toHaveURL("/account?source=ledger#allowance");
  });

  test("the account menu plan follows effective server authority instead of a stale session type", async ({
    page,
  }) => {
    let currentSession = sessionFor("demo");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    await page.goto("/account");

    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByText("Subscriber", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "demo");
    await notifySessionChange(page);

    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByText("Guest", { exact: true })).toBeVisible();
  });

  test("agents uses same-user server authority for gating and Billing despite a stale demo client session", async ({
    page,
  }) => {
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: sessionFor("demo") })
    );
    await mockSubscriberConsoleDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );

    await openConsoleSettings(page);

    await expect(
      page.getByTitle(
        "The Daytona runner answered for this authenticated session."
      )
    ).toBeVisible();
    const billing = page.getByRole("tab", { name: "Billing" });
    await expect(billing).toBeVisible();
    await billing.click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(page.getByText("January 15, 2099")).toBeVisible();
  });

  test("console credential controls lock, clear, and re-enable with effective authority", async ({
    page,
  }) => {
    let currentSession = sessionFor("subscriber");
    let credentialStatus = 200;
    let credentialMutations = 0;
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) => {
      if (route.request().method() !== "GET") {
        credentialMutations += 1;
      }
      if (credentialStatus !== 200) {
        return route.fulfill({ status: credentialStatus });
      }
      return route.fulfill({ json: { harnessIds: [] } });
    });
    await page.route("**/api/usage", (route) =>
      route.fulfill({
        json: {
          cap: 750,
          resetsAt: "2099-02-01T00:00:00.000Z",
          used: 0,
        },
      })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/api/agents"
          ? { json: { agents: [] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });

    await openConsoleSettings(page);
    const credential = page.getByLabel("GitHub Copilot CLI credential");
    const save = page.getByRole("button", { exact: true, name: "Save" });
    await expect(credential).toBeEnabled();
    await credential.fill("must-not-survive");
    await expect(save).toBeEnabled();

    currentSession = sessionFor("demo");
    await setServerSession(page.context(), "demo");
    await notifySessionChange(page);

    await expect(page.getByText("Subscription required")).toBeVisible();
    await expect(credential).toBeDisabled();
    await expect(credential).toHaveValue("");
    await expect(save).toBeDisabled();
    await expect(page.getByText("No unsaved changes")).toBeVisible();
    await expect(
      page.getByText(
        "An active subscription is required to store harness credentials."
      )
    ).toBeVisible();
    expect(credentialMutations).toBe(0);
    await expect(
      page.getByTitle("An active subscription is required to run agents.")
    ).toBeVisible();
    if (CHECKOUT_ENABLED) {
      await page.getByRole("tab", { name: "Billing" }).click();
      await expect(checkoutButton(page)).toBeVisible();
      await page.getByRole("tab", { name: "Harness credentials" }).click();
    } else {
      await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    }

    currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await notifySessionChange(page);

    await expect(credential).toBeEnabled();
    await credential.fill("new-authority-token");
    await expect(save).toBeEnabled();

    credentialStatus = 401;
    await save.click();

    await expect(page.getByText("Subscription required")).toBeVisible();
    await expect(credential).toBeDisabled();
    await expect(credential).toHaveValue("");
    await expect(save).toBeDisabled();
  });

  for (const refusedMethod of ["GET", "POST", "DELETE"] as const) {
    test(`credential ${refusedMethod} 403 invalidates shared authority once and a newer active revision recovers`, async ({
      page,
    }) => {
      await setServerSession(page.context(), "subscriber");
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({ json: sessionFor("subscriber") })
      );
      await page.route("**/api/tenant/prewarm", (route) =>
        route.fulfill({ status: 204 })
      );
      await page.route("**/api/usage", (route) =>
        route.fulfill({
          json: {
            cap: 750,
            resetsAt: "2099-02-01T00:00:00.000Z",
            used: 0,
          },
        })
      );
      await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
        const { pathname } = new URL(route.request().url());
        return route.fulfill(
          pathname === "/api/agents"
            ? { json: { agents: [] } }
            : { json: { apiVersion: "1.0", runs: [] } }
        );
      });

      await page.route("**/api/credentials", (route) => {
        const method = route.request().method();
        if (method === "GET") {
          return route.fulfill({
            json: {
              harnessIds: refusedMethod === "DELETE" ? ["copilot"] : [],
            },
          });
        }
        if (method === refusedMethod) {
          return route.fulfill({
            json: { error: "subscription_required" },
            status: 403,
          });
        }
        return route.fulfill({ json: {}, status: 500 });
      });

      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      let serverRefreshes = 0;
      await page.route("**/agents?**", async (route) => {
        if (isServerComponentRequest(route.request())) {
          serverRefreshes += 1;
          await refreshGate;
        }
        await route.continue();
      });

      let refusedGetHandler: ((route: Route) => Promise<void>) | null = null;
      if (refusedMethod === "GET") {
        await page.goto("/agents");
        await expect(
          page.getByTitle(
            "The Daytona runner answered for this authenticated session."
          )
        ).toBeVisible();
        refusedGetHandler = (route) =>
          route.fulfill({
            json: { error: "subscription_required" },
            status: 403,
          });
        await page.route("**/api/credentials", refusedGetHandler);
        await page
          .getByRole("button", { name: "Account and settings" })
          .click();
      } else {
        await openConsoleSettings(page);
      }
      const credential = page.getByLabel("GitHub Copilot CLI credential");
      const billing = page.getByRole("tab", { name: "Billing" });
      if (refusedMethod !== "GET") {
        await expect(credential).toBeEnabled();
        await expect(billing).toBeVisible();
      }

      if (refusedMethod === "POST") {
        await credential.fill("must-clear-after-refusal");
        await page.getByRole("button", { exact: true, name: "Save" }).click();
      } else if (refusedMethod === "DELETE") {
        await page.getByRole("button", { exact: true, name: "Remove" }).click();
      }

      await expect.poll(() => serverRefreshes).toBe(1);
      await expect(
        page.getByTitle("An active subscription is required to run agents.")
      ).toBeVisible();
      await expect(credential).toBeDisabled();
      await expect(credential).toHaveValue("");
      await expect(
        page.getByText("Subscription required", { exact: true })
      ).toBeVisible();
      await expect(page.getByText("Subscription active")).toHaveCount(0);
      if (CHECKOUT_ENABLED) {
        await expect(billing).toBeVisible();
      } else {
        await expect(billing).toHaveCount(0);
      }
      await page.waitForTimeout(100);
      expect(serverRefreshes).toBe(1);

      if (refusedGetHandler) {
        await page.unroute("**/api/credentials", refusedGetHandler);
      }
      releaseRefresh();

      await expect(credential).toBeEnabled();
      await expect(
        page.getByTitle(
          "The Daytona runner answered for this authenticated session."
        )
      ).toBeVisible();
      await expect(page.getByRole("tab", { name: "Billing" })).toBeVisible();
      expect(serverRefreshes).toBe(1);
    });
  }

  test("an initial credential 403 closes console authority before Settings opens", async ({
    page,
  }) => {
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: sessionFor("subscriber") })
    );
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/usage", (route) =>
      route.fulfill({
        json: {
          cap: 750,
          resetsAt: "2099-02-01T00:00:00.000Z",
          used: 0,
        },
      })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/api/agents"
          ? { json: { agents: [] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });
    let credentialGets = 0;
    await page.route("**/api/credentials", (route) => {
      credentialGets += 1;
      return credentialGets === 1
        ? route.fulfill({
            json: { error: "subscription_required" },
            status: 403,
          })
        : route.fulfill({ json: { harnessIds: [] } });
    });

    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let serverRefreshes = 0;
    await page.route("**/agents?**", async (route) => {
      if (isServerComponentRequest(route.request())) {
        serverRefreshes += 1;
        await refreshGate;
      }
      await route.continue();
    });

    await page.goto("/agents");

    await expect.poll(() => serverRefreshes).toBe(1);
    await expect(
      page.getByTitle("An active subscription is required to run agents.")
    ).toBeVisible();
    await page.waitForTimeout(100);
    expect(serverRefreshes).toBe(1);

    releaseRefresh();

    await expect(
      page.getByTitle(
        "The Daytona runner answered for this authenticated session."
      )
    ).toBeVisible();
    expect(serverRefreshes).toBe(1);
  });

  test("persistent credential refusal stays closed after one recovery refresh", async ({
    page,
  }) => {
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: sessionFor("subscriber") })
    );
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/api/agents"
          ? { json: { agents: [] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });
    await page.route("**/api/credentials", (route) =>
      route.fulfill({
        json: { error: "subscription_required" },
        status: 403,
      })
    );
    let serverRefreshes = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/agents" &&
        isServerComponentRequest(request)
      ) {
        serverRefreshes += 1;
      }
    });

    await page.goto("/agents");

    await expect.poll(() => serverRefreshes).toBeGreaterThanOrEqual(1);
    await expect(
      page.getByTitle("An active subscription is required to run agents.")
    ).toBeVisible();
    await page.waitForTimeout(500);
    expect(serverRefreshes).toBe(1);
  });

  test("console credential bootstrap starts fresh after a same-user auth-version change", async ({
    page,
  }) => {
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/api/agents"
          ? { json: { agents: [] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });
    let releaseCredentials!: () => void;
    const credentialsGate = new Promise<void>((resolve) => {
      releaseCredentials = resolve;
    });
    let credentialGets = 0;
    await page.route("**/api/credentials", async (route) => {
      credentialGets += 1;
      if (credentialGets === 1) {
        await credentialsGate;
        return route.fulfill({
          json: { error: "subscription_required" },
          status: 403,
        });
      }
      return route.fulfill({ json: { harnessIds: [] } });
    });
    let serverRefreshes = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/agents" &&
        isServerComponentRequest(request)
      ) {
        serverRefreshes += 1;
      }
    });

    await page.goto("/agents");
    await expect(
      page.getByTitle(
        "The Daytona runner answered for this authenticated session."
      )
    ).toBeVisible();
    await setServerSession(page.context(), "subscriber", { authVersion: 2 });
    currentSession = sessionFor("subscriber", { authVersion: 2 });
    await notifySessionChange(page);

    await expect.poll(() => serverRefreshes).toBe(1);
    await expect.poll(() => credentialGets).toBe(2);
    releaseCredentials();
    await page.waitForTimeout(100);

    await expect(
      page.getByTitle(
        "The Daytona runner answered for this authenticated session."
      )
    ).toBeVisible();
    expect(serverRefreshes).toBe(1);
  });

  test("a same-user auth-version change fails closed before refreshed authority returns", async ({
    page,
  }) => {
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockSubscriberConsoleDependencies(page);
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let serverRefreshes = 0;
    await page.route("**/agents?**", async (route) => {
      if (isServerComponentRequest(route.request())) {
        serverRefreshes += 1;
        await refreshGate;
      }
      await route.continue();
    });

    await page.goto("/agents");
    await expect(
      page.getByTitle(
        "The Daytona runner answered for this authenticated session."
      )
    ).toBeVisible();

    await setServerSession(page.context(), "demo", { authVersion: 2 });
    currentSession = sessionFor("demo", { authVersion: 2 });
    await notifySessionChange(page);

    await expect.poll(() => serverRefreshes).toBe(1);
    await expect(
      page.getByTitle("An active subscription is required to run agents.")
    ).toBeVisible();

    releaseRefresh();
    await expect(
      page.getByTitle("An active subscription is required to run agents.")
    ).toBeVisible();
  });

  test("a current credential 401 closes shared console authority", async ({
    page,
  }) => {
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: sessionFor("subscriber") })
    );
    await mockSubscriberConsoleDependencies(page);
    await page.unroute("**/api/credentials");
    await page.route("**/api/credentials", async (route) => {
      if (route.request().method() === "POST") {
        await setServerSession(page.context(), "demo");
        return route.fulfill({
          json: { error: "authentication_required" },
          status: 401,
        });
      }
      return route.fulfill({ json: { harnessIds: [] } });
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let serverRefreshes = 0;
    await page.route("**/agents?**", async (route) => {
      if (isServerComponentRequest(route.request())) {
        serverRefreshes += 1;
        await refreshGate;
      }
      await route.continue();
    });

    await openConsoleSettings(page);
    const credential = page.getByLabel("GitHub Copilot CLI credential");
    await credential.fill("must-close-shared-authority");
    await page.getByRole("button", { exact: true, name: "Save" }).click();

    await expect.poll(() => serverRefreshes).toBe(1);
    await expect(
      page.getByTitle("An active subscription is required to run agents.")
    ).toBeVisible();
    await expect(credential).toBeDisabled();

    releaseRefresh();
  });

  test("credential 403 remains fail-closed when the newer server revision is inactive", async ({
    page,
  }) => {
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: sessionFor("subscriber") })
    );
    await mockSubscriberConsoleDependencies(page);
    await page.unroute("**/api/credentials");
    await page.route("**/api/credentials", async (route) => {
      if (route.request().method() === "POST") {
        await setServerSession(page.context(), "demo");
        return route.fulfill({
          json: { error: "subscription_required" },
          status: 403,
        });
      }
      return route.fulfill({ json: { harnessIds: [] } });
    });
    let serverRefreshes = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/agents" &&
        isServerComponentRequest(request)
      ) {
        serverRefreshes += 1;
      }
    });

    await openConsoleSettings(page);
    const credential = page.getByLabel("GitHub Copilot CLI credential");
    await credential.fill("must-not-reactivate");
    await page.getByRole("button", { exact: true, name: "Save" }).click();

    await expect.poll(() => serverRefreshes).toBe(1);
    await expect(
      page.getByTitle("An active subscription is required to run agents.")
    ).toBeVisible();
    await expect(credential).toBeDisabled();
    await expect(credential).toHaveValue("");
    if (CHECKOUT_ENABLED) {
      await page.getByRole("tab", { name: "Billing" }).click();
      await expect(checkoutButton(page)).toBeVisible();
    } else {
      await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    }
    await page.waitForTimeout(100);
    expect(serverRefreshes).toBe(1);
  });

  test("an account credential 403 closes the menu and Billing until a newer active revision reloads", async ({
    page,
  }) => {
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: sessionFor("subscriber") })
    );
    let credentialGets = 0;
    await page.route("**/api/credentials", (route) => {
      credentialGets += 1;
      return credentialGets === 1
        ? route.fulfill({
            json: { error: "subscription_required" },
            status: 403,
          })
        : route.fulfill({ json: { harnessIds: [] } });
    });

    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let serverRefreshes = 0;
    await page.route("**/account?**", async (route) => {
      if (isServerComponentRequest(route.request())) {
        serverRefreshes += 1;
        await refreshGate;
      }
      await route.continue();
    });

    await page.goto("/account");

    await expect.poll(() => serverRefreshes).toBe(1);
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByText("Guest", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByText("Storing a credential needs an active subscription.")
    ).toBeVisible();
    await expect(page.getByLabel("GitHub Copilot CLI")).toHaveCount(0);
    await expect(page.getByText("Subscription active")).toHaveCount(0);
    if (CHECKOUT_ENABLED) {
      await expect(page.getByRole("tab", { name: "Billing" })).toBeVisible();
    } else {
      await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    }

    releaseRefresh();

    await expect(page.getByLabel("GitHub Copilot CLI")).toBeVisible();
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByText("Subscriber", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tab", { name: "Billing" })).toBeVisible();
    expect(serverRefreshes).toBe(1);
  });

  test("an old account credential refusal cannot invalidate a newer auth version", async ({
    page,
  }) => {
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    let releaseCredentials!: () => void;
    const credentialsGate = new Promise<void>((resolve) => {
      releaseCredentials = resolve;
    });
    let credentialGets = 0;
    await page.route("**/api/credentials", async (route) => {
      credentialGets += 1;
      if (credentialGets === 1) {
        await credentialsGate;
        return route.fulfill({
          json: { error: "subscription_required" },
          status: 403,
        });
      }
      return route.fulfill({ json: { harnessIds: [] } });
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let serverRefreshes = 0;
    await page.route("**/account?**", async (route) => {
      if (isServerComponentRequest(route.request())) {
        serverRefreshes += 1;
        await refreshGate;
      }
      await route.continue();
    });

    await page.goto("/account");
    const credential = page.getByLabel("GitHub Copilot CLI");
    await expect(credential).toBeVisible();
    await credential.fill("belongs-to-new-auth-version");

    currentSession = sessionFor("subscriber", { authVersion: 2 });
    await setServerSession(page.context(), "subscriber", { authVersion: 2 });
    await notifySessionChange(page);
    await expect.poll(() => serverRefreshes).toBe(1);
    releaseCredentials();

    await page.waitForTimeout(100);
    await expect(credential).toHaveCount(0);
    expect(serverRefreshes).toBe(1);

    releaseRefresh();

    await expect(credential).toBeVisible();
    await expect(credential).toHaveValue("");
    expect(serverRefreshes).toBe(1);
  });

  test("account credential memory clears before a new subscriber response arrives", async ({
    page,
  }) => {
    const secondUserId = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    let releaseSecondCredentials!: () => void;
    const secondCredentialsGate = new Promise<void>((resolve) => {
      releaseSecondCredentials = resolve;
    });
    let credentialGets = 0;
    await page.route("**/api/credentials", async (route) => {
      credentialGets += 1;
      if (credentialGets === 1) {
        return route.fulfill({ json: { harnessIds: ["copilot"] } });
      }
      await secondCredentialsGate;
      return route.fulfill({ json: { harnessIds: [] } });
    });

    await page.goto("/account");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    const initialCredentialGets = credentialGets;

    await setServerSession(page.context(), "subscriber", { id: secondUserId });
    currentSession = sessionFor("subscriber", {
      email: "second@example.invalid",
      id: secondUserId,
    });
    await notifySessionChange(page);

    await expect(page.getByLabel("GitHub Copilot CLI")).toBeVisible();
    await expect.poll(() => credentialGets > initialCredentialGets).toBe(true);
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);

    releaseSecondCredentials();
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
  });

  for (const initialMismatch of ["auth-version", "user"] as const) {
    test(`initial client ${initialMismatch} mismatch refreshes server authority once`, async ({
      page,
    }) => {
      const secondUserId = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";
      const nextSession =
        initialMismatch === "user"
          ? sessionFor("subscriber", {
              email: "second@example.invalid",
              id: secondUserId,
            })
          : sessionFor("subscriber", { authVersion: 2 });
      const nextServerOptions =
        initialMismatch === "user" ? { id: secondUserId } : { authVersion: 2 };
      await setServerSession(page.context(), "subscriber");
      await page.route("**/api/auth/session", async (route) => {
        await setServerSession(page.context(), "subscriber", nextServerOptions);
        return route.fulfill({ json: nextSession });
      });
      await mockAccountDependencies(page);
      let serverRefreshes = 0;
      page.on("request", (request) => {
        if (
          new URL(request.url()).pathname === "/account" &&
          isServerComponentRequest(request)
        ) {
          serverRefreshes += 1;
        }
      });

      await page.goto("/account");

      await expect.poll(() => serverRefreshes).toBe(1);
      await expect(page.getByLabel("GitHub Copilot CLI")).toBeVisible();
      expect(serverRefreshes).toBe(1);
    });
  }

  for (const refusedMethod of ["POST", "PUT"] as const) {
    test(`device-flow ${refusedMethod} refusal closes shared account authority`, async ({
      page,
    }) => {
      await setServerSession(page.context(), "subscriber");
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({ json: sessionFor("subscriber") })
      );
      await mockAccountDependencies(page);
      await page.route("**/api/credentials/device", (route) => {
        const method = route.request().method();
        if (method === refusedMethod) {
          return route.fulfill({
            json: { error: "subscription_required" },
            status: 403,
          });
        }
        if (method === "POST") {
          return route.fulfill({
            json: {
              binding: "signed-device-binding",
              deviceCode: "device-secret",
              interval: 0,
              userCode: "ABCD-EFGH",
              verificationUri: "https://github.com/login/device",
            },
          });
        }
        return route.fulfill({ json: {}, status: 500 });
      });
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      let serverRefreshes = 0;
      await page.route("**/account?**", async (route) => {
        if (isServerComponentRequest(route.request())) {
          serverRefreshes += 1;
          await refreshGate;
        }
        await route.continue();
      });

      await page.goto("/account");
      await page
        .getByRole("button", { name: "Connect GitHub Copilot" })
        .click();

      await expect.poll(() => serverRefreshes).toBe(1);
      await expect(
        page.getByText("Storing a credential needs an active subscription.", {
          exact: true,
        })
      ).toBeVisible();
      await expect(page.getByLabel("GitHub Copilot CLI")).toHaveCount(0);

      releaseRefresh();
    });
  }

  test("a stale device-flow start refusal cannot invalidate a replacement authority", async ({
    page,
  }) => {
    const secondUserId = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    let releaseDeviceStart!: () => void;
    const deviceStartGate = new Promise<void>((resolve) => {
      releaseDeviceStart = resolve;
    });
    await page.route("**/api/credentials/device", async (route) => {
      await deviceStartGate;
      return route.fulfill({
        json: { error: "subscription_required" },
        status: 403,
      });
    });
    let serverRefreshes = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/account" &&
        isServerComponentRequest(request)
      ) {
        serverRefreshes += 1;
      }
    });

    await page.goto("/account");
    await page.getByRole("button", { name: "Connect GitHub Copilot" }).click();

    await setServerSession(page.context(), "subscriber", { id: secondUserId });
    currentSession = sessionFor("subscriber", {
      email: "second@example.invalid",
      id: secondUserId,
    });
    await notifySessionChange(page);
    await expect.poll(() => serverRefreshes).toBe(1);
    await expect(
      page.getByRole("button", { name: "Connect GitHub Copilot" })
    ).toBeVisible();

    releaseDeviceStart();
    await page.waitForTimeout(100);

    expect(serverRefreshes).toBe(1);
    await expect(page.getByLabel("GitHub Copilot CLI")).toBeVisible();
  });

  test("agents ignores subscriber authority belonging to another current client identity", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    const secondUserId = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: sessionFor("subscriber", {
          email: "second@example.invalid",
          id: secondUserId,
        }),
      })
    );
    let protectedReads = 0;
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      protectedReads += 1;
      return route.fulfill({ json: { agents: [] } });
    });

    await openConsoleSettings(page);

    await expect(
      page.getByTitle("An active subscription is required to run agents.")
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    expect(protectedReads).toBe(0);
  });

  test("a cancelled return is neutral and restores the checkout action", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account?source=ledger&checkout=cancelled#allowance");

    await expect(
      page.getByText("Checkout cancelled. No payment was taken.")
    ).toBeVisible();
    await expect(checkoutButton(page)).toBeEnabled();
    await expect(page.getByText(/payment failed/i)).toHaveCount(0);
    await expect(page).toHaveURL("/account?source=ledger#allowance");

    await page.reload();
    await expect(
      page.getByText("Checkout cancelled. No payment was taken.")
    ).toHaveCount(0);
  });

  test("already-subscribed recovery finalizes its polling generation when refreshed authority activates", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    await page.clock.install({
      time: new Date("2026-08-31T14:25:01.000Z"),
    });
    await mockSession(page, "demo");
    await mockAccountDependencies(page);
    await page.route("**/api/checkout", (route) =>
      route.fulfill({
        json: { error: "already_subscribed" },
        status: 409,
      })
    );
    await page.route("**/api/subscription", async (route) => {
      await setServerSession(page.context(), "subscriber");
      await route.fulfill({ json: subscriptionStatus(true) });
    });
    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();

    await checkoutButton(page).click();
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("status")).toContainText("Subscription active");
    await expect(page).toHaveURL("/account");

    await page.clock.runFor(16_000);
    await expect(page.getByRole("status")).toContainText("Subscription active");
    await expect(page.getByRole("status")).not.toContainText(
      "Payment may still be processing."
    );
  });

  test("network and retryable server failures retain one idempotency key until a terminal response", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    const keys: string[] = [];
    let attempt = 0;
    await page.route("**/api/checkout", (route) => {
      keys.push(idempotencyKey(route.request()));
      expect(route.request().method()).toBe("POST");
      expect(route.request().postData()).toBeNull();
      attempt += 1;
      if (attempt === 1) {
        return route.abort("connectionfailed");
      }
      if (attempt === 2) {
        return route.fulfill({
          json: { error: "billing_unavailable" },
          status: 503,
        });
      }
      if (attempt === 3) {
        return route.fulfill({
          json: { error: "request_in_progress" },
          status: 409,
        });
      }
      if (attempt === 4) {
        return route.fulfill({
          json: { error: "checkout_session_conflict" },
          status: 409,
        });
      }
      if (attempt === 5) {
        return route.fulfill({
          json: { error: "rate_limited" },
          status: 429,
        });
      }
      return route.fulfill({
        json: { error: "checkout_refused" },
        status: 400,
      });
    });
    await openEligibleAccount(page);

    await checkoutButton(page).click();
    await expect(page.getByText(/could not reach billing/i)).toBeVisible();
    await checkoutButton(page).click();
    await expect(page.getByText(/temporarily unavailable/i)).toBeVisible();
    await checkoutButton(page).click();
    await expect(page.getByText(/still processing/i)).toBeVisible();
    await checkoutButton(page).click();
    await expect(page.getByText(/still settling/i)).toBeVisible();
    await checkoutButton(page).click();
    await expect(page.getByText(/rate limited/i)).toBeVisible();
    await checkoutButton(page).click();
    await expect(page.getByText(/could not be started/i)).toBeVisible();
    await checkoutButton(page).click();
    await expect.poll(() => keys.length).toBe(7);

    expect(new Set(keys.slice(0, 6))).toEqual(new Set([keys[0]]));
    expect(keys[6]).not.toBe(keys[0]);
  });

  test("the pending guard blocks same-tick duplicate checkout and exposes an accessible live status", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/checkout", async (route) => {
      requests += 1;
      await gate;
      return route.fulfill({
        json: { error: "checkout_refused" },
        status: 400,
      });
    });
    await openEligibleAccount(page);
    const button = checkoutButton(page);
    await page.getByRole("tab", { name: "Billing" }).focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("outline-style", "solid");

    await button.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });

    await expect.poll(() => requests).toBe(1);
    const pendingButton = page.locator("button.oc-subscription-action");
    await expect(pendingButton).toBeDisabled();
    await expect(pendingButton).toHaveText("Opening secure checkout…");
    await expect(page.getByRole("status")).toContainText(
      "Opening secure checkout"
    );

    release();

    await expect(page.getByRole("status")).toContainText(
      "Checkout could not be started"
    );
    await expect(page.getByRole("status")).toBeFocused();
  });

  test("a delayed successful checkout for user A cannot navigate after switching to user B, which gets a new key", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    let currentSession: ReturnType<typeof sessionFor> | null =
      sessionFor("demo");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const keys: string[] = [];
    let checkoutRequests = 0;
    let assignedDestinations = 0;
    await page.route("**/api/auth/session", (route) =>
      currentSession
        ? route.fulfill({ json: currentSession })
        : route.fulfill({ body: "null", contentType: "application/json" })
    );
    await mockAccountDependencies(page);
    await page.route("https://checkout.stripe.test/**", (route) => {
      assignedDestinations += 1;
      return route.abort();
    });
    await page.route("**/api/checkout", async (route) => {
      checkoutRequests += 1;
      keys.push(idempotencyKey(route.request()));
      if (checkoutRequests === 1) {
        await firstGate;
        await route
          .fulfill({
            json: { url: "https://checkout.stripe.test/session/user-a" },
          })
          .catch(() => undefined);
        return;
      }
      await route.fulfill({
        json: { error: "request_in_progress" },
        status: 409,
      });
    });
    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();

    await checkoutButton(page).click();
    await expect.poll(() => checkoutRequests).toBe(1);

    currentSession = sessionFor("demo", {
      email: "second@example.invalid",
      id: "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
    });
    await notifySessionChange(page);
    await expect(checkoutButton(page)).toBeEnabled();
    await checkoutButton(page).click();
    await expect.poll(() => checkoutRequests).toBe(2);
    await expect(page.getByRole("status")).toContainText(
      "A checkout request is still processing."
    );

    releaseFirst();

    await expect.poll(() => assignedDestinations).toBe(0);
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("a delayed successful checkout for user A cannot navigate after sign-out, and null to user B starts cleanly", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    let currentSession: ReturnType<typeof sessionFor> | null =
      sessionFor("demo");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const keys: string[] = [];
    let checkoutRequests = 0;
    let assignedDestinations = 0;
    await page.route("**/api/auth/session", (route) =>
      currentSession
        ? route.fulfill({ json: currentSession })
        : route.fulfill({ body: "null", contentType: "application/json" })
    );
    await mockAccountDependencies(page);
    await page.route("https://checkout.stripe.test/**", (route) => {
      assignedDestinations += 1;
      return route.abort();
    });
    await page.route("**/api/checkout", async (route) => {
      checkoutRequests += 1;
      keys.push(idempotencyKey(route.request()));
      if (checkoutRequests === 1) {
        await firstGate;
        await route
          .fulfill({
            json: { url: "https://checkout.stripe.test/session/user-a" },
          })
          .catch(() => undefined);
        return;
      }
      await route.fulfill({
        json: { error: "checkout_refused" },
        status: 400,
      });
    });
    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    await checkoutButton(page).click();
    await expect.poll(() => checkoutRequests).toBe(1);

    currentSession = null;
    await notifySessionChange(page);
    await expect(
      page.getByRole("heading", { name: "Sign in to manage your account" })
    ).toBeVisible();
    releaseFirst();
    await expect.poll(() => assignedDestinations).toBe(0);

    currentSession = sessionFor("demo", {
      email: "second@example.invalid",
      id: "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
    });
    await notifySessionChange(page);
    await page.getByRole("tab", { name: "Billing" }).click();
    await checkoutButton(page).click();
    await expect.poll(() => checkoutRequests).toBe(2);
    await expect(page.getByRole("status")).toContainText(
      "Checkout could not be started."
    );
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("a stale checkout error for user A cannot overwrite user B state", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    let currentSession = sessionFor("demo");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let checkoutRequests = 0;
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/checkout", async (route) => {
      checkoutRequests += 1;
      if (checkoutRequests === 1) {
        await firstGate;
        await route
          .fulfill({
            json: { error: "billing_unavailable" },
            status: 503,
          })
          .catch(() => undefined);
        return;
      }
      await route.fulfill({
        json: { error: "request_in_progress" },
        status: 409,
      });
    });
    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    await checkoutButton(page).click();
    await expect.poll(() => checkoutRequests).toBe(1);

    currentSession = sessionFor("demo", {
      email: "second@example.invalid",
      id: "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
    });
    await notifySessionChange(page);
    await checkoutButton(page).click();
    await expect(page.getByRole("status")).toContainText(
      "A checkout request is still processing."
    );

    releaseFirst();

    await expect(page.getByRole("status")).toContainText(
      "A checkout request is still processing."
    );
    await expect(page.getByRole("status")).not.toContainText(
      "Billing is temporarily unavailable."
    );
  });

  test("inactive confirmation times out without implying success and Check again starts a bounded new check", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await page.clock.install({
      time: new Date("2026-08-31T14:25:01.000Z"),
    });
    await mockSession(page, "demo");
    await mockAccountDependencies(page);
    let attempts = 0;
    await page.route("**/api/subscription", (route) => {
      attempts += 1;
      return route.fulfill({ json: subscriptionStatus(false) });
    });

    await page.goto("/account?checkout=success");
    await expect.poll(() => attempts).toBe(1);
    await page.clock.runFor(15_000);

    await expect(
      page.getByText(/payment may still be processing/i)
    ).toBeVisible();
    await expect(page.getByText("Subscription active")).toHaveCount(0);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(15);

    const attemptsBeforeRetry = attempts;
    await page.getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => attempts).toBe(attemptsBeforeRetry + 1);
  });

  test("a never-ending subscription response body aborts at the confirmation deadline", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await page.clock.install({
      time: new Date("2026-08-31T14:25:01.000Z"),
    });
    await installSubscriptionBodyMock(page, null);
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account?checkout=success");
    await expect
      .poll(async () => (await subscriptionBodyMockState(page)).calls)
      .toBe(1);
    await page.clock.runFor(15_000);

    await expect(
      page.getByText(/payment may still be processing/i)
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Check again" })
    ).toBeVisible();
    expect(await subscriptionBodyMockState(page)).toMatchObject({
      aborts: 1,
      calls: 1,
    });
  });

  test("headers before the deadline cannot activate from a body completed after it", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await page.clock.install({
      time: new Date("2026-08-31T14:25:01.000Z"),
    });
    await installSubscriptionBodyMock(page, 16_000);
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account?checkout=success");
    await expect
      .poll(async () => (await subscriptionBodyMockState(page)).calls)
      .toBe(1);
    await page.clock.runFor(15_000);
    await expect(
      page.getByRole("button", { name: "Check again" })
    ).toBeVisible();

    await page.clock.runFor(1100);

    await expect(page.getByText("Subscription active")).toHaveCount(0);
    await expect(page).toHaveURL("/account?checkout=success");
    expect(await subscriptionBodyMockState(page)).toMatchObject({
      aborts: 1,
      calls: 1,
      lateBodyWrites: 1,
    });
  });

  test("a short Retry-After delays confirmation without an early request", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await page.clock.install({
      time: new Date("2026-08-31T14:25:01.000Z"),
    });
    await mockSession(page, "demo");
    await mockAccountDependencies(page);
    let attempts = 0;
    await page.route("**/api/subscription", (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({
            headers: { "retry-after": "3" },
            json: { error: "rate_limited" },
            status: 429,
          })
        : route.fulfill({ json: subscriptionStatus(false) });
    });

    await page.goto("/account?checkout=success");
    await expect.poll(() => attempts).toBe(1);
    await page.clock.runFor(2500);
    expect(attempts).toBe(1);
    await page.clock.runFor(600);
    await expect.poll(() => attempts).toBe(2);
  });

  test("a long Retry-After cannot keep foreground confirmation past its deadline", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await page.clock.install({
      time: new Date("2026-08-31T14:25:01.000Z"),
    });
    await mockSession(page, "demo");
    await mockAccountDependencies(page);
    let attempts = 0;
    await page.route("**/api/subscription", (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({
            headers: { "retry-after": "30" },
            json: { error: "rate_limited" },
            status: 429,
          })
        : route.fulfill({ json: subscriptionStatus(false) });
    });

    await page.goto("/account?checkout=success");
    await expect.poll(() => attempts).toBe(1);
    await expect(page.getByRole("status")).toContainText(
      "Payment status is temporarily rate limited."
    );
    await expect(page.getByRole("status")).toContainText("after");
    await page.clock.runFor(15_000);
    expect(attempts).toBe(1);
    await expect(
      page.getByRole("button", { name: "Check again" })
    ).toBeVisible();
    expect(attempts).toBe(1);
    await page.getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => attempts).toBe(2);
  });

  test("a subscriber downgrade clears stale billing state and falls back from a removed Billing tab", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );
    await page.goto("/account");
    const billing = page.getByRole("tab", { name: "Billing" });
    await billing.click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    await billing.focus();

    currentSession = sessionFor("demo");
    await setServerSession(page.context(), "demo");
    await notifySessionChange(page);

    await expect(billing).toHaveCount(0);
    const copilot = page.getByRole("tab", { name: "Copilot" });
    await expect(copilot).toHaveAttribute("aria-selected", "true");
    await expect(copilot).toBeFocused();
    await expect(page.getByRole("tabpanel", { name: "Copilot" })).toBeVisible();
    await expect(page.getByText("Subscription active")).toHaveCount(0);
  });

  test("an account downgrade preserves focus moved outside Billing", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );
    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    const accountButton = page.getByRole("button", { name: "Account" });
    await accountButton.focus();

    currentSession = sessionFor("demo");
    await setServerSession(page.context(), "demo");
    await notifySessionChange(page);

    await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Copilot" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(accountButton).toBeFocused();
  });

  test("an account downgrade moves focus out of the removed Billing panel", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );
    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    const notice = page.getByRole("status");
    await expect(page.getByText("Subscription active")).toBeVisible();
    await notice.focus();
    await expect(notice).toBeFocused();

    currentSession = sessionFor("demo");
    await setServerSession(page.context(), "demo");
    await notifySessionChange(page);

    const copilot = page.getByRole("tab", { name: "Copilot" });
    await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    await expect(copilot).toHaveAttribute("aria-selected", "true");
    await expect(copilot).toBeFocused();
  });

  test("switching users aborts stale subscription reads and clears old authority notices", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", async (route) => {
      await statusGate;
      return route.fulfill({ json: subscriptionStatus(true) });
    });
    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(page.getByText("Checking subscription")).toBeVisible();

    currentSession = sessionFor("demo", {
      email: "second@example.invalid",
      id: "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
    });
    await setServerSession(page.context(), "demo", {
      email: "second@example.invalid",
      id: "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
    });
    await notifySessionChange(page);
    releaseStatus();

    await expect(checkoutButton(page)).toBeVisible();
    await expect(page.getByText("Checking subscription")).toHaveCount(0);
    await expect(page.getByText("Subscription active")).toHaveCount(0);
    await expect(page.getByText("January 15, 2099")).toHaveCount(0);
  });

  test("desktop console settings expose vertical keyboard-operable ARIA tabs", async ({
    page,
  }) => {
    await mockSession(page, "demo");
    await mockSubscriberConsoleDependencies(page);
    await openConsoleSettings(page);

    const tablist = page.getByRole("tablist", { name: "Console settings" });
    await expect(tablist).toHaveAttribute("aria-orientation", "vertical");
    const harness = page.getByRole("tab", { name: "Harness credentials" });
    const usage = page.getByRole("tab", { name: "Usage" });
    const account = page.getByRole("tab", { exact: true, name: "Account" });
    await expect(harness).toHaveAttribute("aria-selected", "true");
    await expect(harness).toHaveAttribute(
      "aria-controls",
      "console-settings-panel-harness"
    );
    await harness.focus();
    await page.keyboard.press("ArrowRight");
    await expect(harness).toBeFocused();
    await expect(harness).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(usage).toBeFocused();
    await expect(usage).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Usage" })).toHaveAttribute(
      "id",
      "console-settings-panel-usage"
    );
    await page.keyboard.press("End");
    await expect(account).toBeFocused();
    await page.keyboard.press("Home");
    await expect(harness).toBeFocused();
  });

  test("mobile console settings expose non-shrinking horizontal tabs with Billing keyboard-reachable", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await mockSession(page, "subscriber");
    await mockSubscriberConsoleDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );
    await openConsoleSettings(page);

    const tablist = page.getByRole("tablist", { name: "Console settings" });
    const harness = page.getByRole("tab", { name: "Harness credentials" });
    const usage = page.getByRole("tab", { name: "Usage" });
    const billing = page.getByRole("tab", { name: "Billing" });
    await expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
    await harness.focus();
    await page.keyboard.press("ArrowDown");
    await expect(harness).toBeFocused();
    await expect(harness).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(usage).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(billing).toBeFocused();
    await expect(billing).toHaveAttribute("aria-selected", "true");

    const geometry = await page.evaluate(() => {
      const navigation = document.querySelector(".oc-settings-nav");
      const tabs = Array.from(
        document.querySelectorAll<HTMLElement>('.oc-settings-nav [role="tab"]')
      );
      return {
        contentFits: tabs.every(
          (element) => element.scrollWidth <= element.clientWidth
        ),
        flexShrink: tabs.map((element) => getComputedStyle(element).flexShrink),
        navigationOverflowX:
          navigation instanceof HTMLElement
            ? getComputedStyle(navigation).overflowX
            : null,
        whiteSpace: tabs.map((element) => getComputedStyle(element).whiteSpace),
      };
    });
    expect(geometry).toEqual({
      contentFits: true,
      flexShrink: ["0", "0", "0", "0", "0"],
      navigationOverflowX: "auto",
      whiteSpace: ["nowrap", "nowrap", "nowrap", "nowrap", "nowrap"],
    });
    await expect(billing).toHaveCSS("outline-style", "solid");
  });

  test("console settings focus a visible fallback when Billing is removed", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockSubscriberConsoleDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );
    await openConsoleSettings(page);
    const billing = page.getByRole("tab", { name: "Billing" });
    await billing.click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    await billing.focus();

    currentSession = sessionFor("demo");
    await setServerSession(page.context(), "demo");
    await notifySessionChange(page);

    await expect(billing).toHaveCount(0);
    const harness = page.getByRole("tab", { name: "Harness credentials" });
    await expect(harness).toHaveAttribute("aria-selected", "true");
    await expect(harness).toBeFocused();
    await expect(
      page.getByRole("tabpanel", { name: "Harness credentials" })
    ).toBeVisible();
  });

  test("console settings preserve focus moved outside Billing on downgrade", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockSubscriberConsoleDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );
    await openConsoleSettings(page);
    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    const externalButton = page.getByRole("button", {
      name: "Search or run a command",
    });
    await externalButton.focus();

    currentSession = sessionFor("demo");
    await setServerSession(page.context(), "demo");
    await notifySessionChange(page);

    await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    await expect(
      page.getByRole("tab", { name: "Harness credentials" })
    ).toHaveAttribute("aria-selected", "true");
    await expect(externalButton).toBeFocused();
  });

  test("console settings move focus out of the removed Billing panel", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    let currentSession = sessionFor("subscriber");
    await setServerSession(page.context(), "subscriber");
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: currentSession })
    );
    await mockSubscriberConsoleDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );
    await openConsoleSettings(page);
    await page.getByRole("tab", { name: "Billing" }).click();
    const notice = page.locator(".oc-subscription-card").getByRole("status");
    await expect(page.getByText("Subscription active")).toBeVisible();
    await notice.focus();
    await expect(notice).toBeFocused();

    currentSession = sessionFor("demo");
    await setServerSession(page.context(), "demo");
    await notifySessionChange(page);

    const harness = page.getByRole("tab", { name: "Harness credentials" });
    await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    await expect(harness).toHaveAttribute("aria-selected", "true");
    await expect(harness).toBeFocused();
  });

  for (const scenario of [
    {
      body: { error: "subscriptions_unavailable" },
      message: "Subscriptions are not available right now.",
      name: "subscriptions unavailable",
      status: 404,
    },
    {
      body: { error: "already_subscribed" },
      message: "A subscription already exists for this account.",
      name: "already subscribed",
      status: 409,
    },
    {
      body: { error: "billing_unavailable" },
      message: "Billing is temporarily unavailable.",
      name: "billing unavailable",
      status: 503,
    },
    {
      body: { error: "request_in_progress" },
      message: "A checkout request is still processing.",
      name: "request in progress",
      status: 409,
    },
    {
      body: { error: "checkout_session_conflict" },
      message: "A previous checkout session is still settling.",
      name: "checkout session conflict",
      status: 409,
    },
    {
      body: { error: "rate_limited" },
      message: "Checkout is temporarily rate limited.",
      name: "rate limited",
      status: 429,
    },
    {
      body: { error: "checkout_failed" },
      message: "The checkout provider could not open a session.",
      name: "provider failure",
      status: 502,
    },
  ]) {
    test(`maps ${scenario.name} without collapsing it into a generic failure`, async ({
      page,
    }) => {
      test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
      await page.route("**/api/checkout", (route) =>
        route.fulfill({ json: scenario.body, status: scenario.status })
      );
      await openEligibleAccount(page);

      await checkoutButton(page).click();

      await expect(page.getByRole("status")).toContainText(scenario.message);
    });
  }

  test("missing and unsafe checkout destinations are rejected without navigation", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    let attempt = 0;
    await page.route("**/api/checkout", (route) => {
      attempt += 1;
      return route.fulfill({
        json: attempt === 1 ? {} : { url: "http://billing.example/session" },
      });
    });
    await openEligibleAccount(page);
    const accountUrl = page.url();

    await checkoutButton(page).click();
    await expect(page.getByRole("status")).toContainText(
      "Checkout returned no secure destination."
    );
    expect(page.url()).toBe(accountUrl);

    await checkoutButton(page).click();
    await expect(page.getByRole("status")).toContainText(
      "Checkout returned an unsafe destination."
    );
    expect(page.url()).toBe(accountUrl);
  });

  test("a valid HTTPS checkout destination is assigned", async ({ page }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    let assignedUrl: string | null = null;
    await page.route("https://checkout.stripe.test/**", (route) => {
      assignedUrl = route.request().url();
      return route.abort();
    });
    await page.route("**/api/checkout", (route) =>
      route.fulfill({
        json: { url: "https://checkout.stripe.test/session/e2e" },
      })
    );
    await openEligibleAccount(page);

    await checkoutButton(page).click();

    await expect
      .poll(() => assignedUrl)
      .toBe("https://checkout.stripe.test/session/e2e");
  });

  for (const scenario of [
    {
      body: { error: "unauthorized" },
      message: "Your sign-in changed before payment could be confirmed.",
      name: "revoked session",
      status: 401,
    },
    {
      body: { active: "yes" },
      message: "The subscription status response was incomplete.",
      name: "malformed response",
      status: 200,
    },
  ]) {
    test(`stops confirmation explicitly for a ${scenario.name}`, async ({
      page,
    }) => {
      test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
      await mockSession(page, "demo");
      await mockAccountDependencies(page);
      let reads = 0;
      await page.route("**/api/subscription", (route) => {
        reads += 1;
        return route.fulfill({ json: scenario.body, status: scenario.status });
      });

      await page.goto("/account?checkout=success");

      await expect(page.getByRole("status")).toContainText(scenario.message);
      expect(reads).toBe(1);
    });
  }

  test("a 401 confirmation action preserves the full successful return through login", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    await mockSession(page, "demo");
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: { error: "unauthorized" }, status: 401 })
    );
    await page.goto("/account?source=ledger&checkout=success#allowance");

    const signIn = page.getByRole("link", { name: "Sign in again" });
    await expect(signIn).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Faccount%3Fsource%3Dledger%26checkout%3Dsuccess%23allowance"
    );
    await page.context().clearCookies({ name: /authjs\.session-token/u });
    await signIn.click();

    await expect(page).toHaveURL(
      "/login?callbackUrl=%2Faccount%3Fsource%3Dledger%26checkout%3Dsuccess%23allowance"
    );
  });

  for (const scenario of [
    {
      message: "Payment status is temporarily rate limited.",
      name: "rate limit",
      status: 429,
    },
    {
      message: "Payment status is temporarily unavailable.",
      name: "server failure",
      status: 503,
    },
  ]) {
    test(`retries a bounded confirmation ${scenario.name}`, async ({
      page,
    }) => {
      test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
      await mockSession(page, "demo");
      await mockAccountDependencies(page);
      let reads = 0;
      await page.route("**/api/subscription", (route) => {
        reads += 1;
        return reads === 1
          ? route.fulfill({
              json: { error: "subscription_unavailable" },
              status: scenario.status,
            })
          : route.fulfill({ json: subscriptionStatus(false) });
      });

      await page.goto("/account?checkout=success");
      await expect(page.getByRole("status")).toContainText(scenario.message);
      await expect.poll(() => reads, { timeout: 2500 }).toBeGreaterThan(1);
    });
  }

  test("the shared card stays within both phone surfaces and its action remains operable", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/checkout", (route) =>
      route.fulfill({
        json: { error: "checkout_refused" },
        status: 400,
      })
    );
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(checkoutButton(page)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    await checkoutButton(page).click();
    await expect(page.getByRole("status")).toContainText(
      "Checkout could not be started"
    );

    await openConsoleSettings(page);
    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(checkoutButton(page)).toBeVisible();
    const consoleLayout = await page.evaluate(() => {
      const settings = document.querySelector(".oc-settings");
      const content = document.querySelector(".oc-settings-content");
      const bounds = settings?.getBoundingClientRect();
      return {
        contentFits:
          content instanceof HTMLElement &&
          content.scrollWidth <= content.clientWidth,
        fitsViewport:
          bounds !== undefined &&
          bounds.left >= 0 &&
          bounds.right <= window.innerWidth,
      };
    });
    expect(consoleLayout).toEqual({
      contentFits: true,
      fitsViewport: true,
    });
  });
});
