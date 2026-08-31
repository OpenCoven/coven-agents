import { expect, type Page, type Request, test } from "@playwright/test";
import { E2E_USER_ID } from "./session";

const CHECKOUT_ENABLED = process.env.SUBSCRIPTION_CHECKOUT_ENABLED === "on";
const SUBSCRIBED_UNTIL = "2099-01-15T12:00:00.000Z";

type SessionType = "demo" | "subscriber";

function sessionFor(type: SessionType) {
  return {
    expires: "2099-01-01T00:00:00.000Z",
    user: {
      authVersion: 1,
      email: "e2e-user@example.invalid",
      id: E2E_USER_ID,
      image: null,
      name: "E2E subscriber",
      type,
    },
  };
}

async function mockSession(page: Page, type: SessionType): Promise<void> {
  await page.route("**/api/auth/csrf", (route) =>
    route.fulfill({ json: { csrfToken: "e2e-csrf" } })
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: sessionFor(type) })
  );
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

async function openEligibleAccount(page: Page): Promise<void> {
  await mockSession(page, "demo");
  await mockAccountDependencies(page);
  await page.goto("/account");
  await page.getByRole("button", { name: "Billing" }).click();
  await expect(checkoutButton(page)).toBeVisible();
}

test.describe("Subscriber checkout", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("flag off hides billing from non-subscribers and ignores inexact checkout values", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the launch-flag-off contract.");
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account?checkout=SUCCESS");
    await expect(page.getByRole("button", { name: "Billing" })).toHaveCount(0);
    await expect(checkoutButton(page)).toHaveCount(0);

    await openConsoleSettings(page);
    await expect(page.getByRole("button", { name: "Billing" })).toHaveCount(0);
    await expect(checkoutButton(page)).toHaveCount(0);
  });

  test("flag on presents the same restrained 750-run offer on both account surfaces", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account");
    await page.getByRole("button", { name: "Billing" }).click();
    const accountCard = page.locator(".oc-subscription-card");
    await expect(accountCard).toContainText("750 runs");
    await expect(accountCard).toContainText("each month");
    await expect(accountCard).toContainText(
      "Stripe shows the configured amount before purchase"
    );
    await expect(checkoutButton(page)).toBeVisible();
    const accountOffer = await accountCard.innerText();

    await openConsoleSettings(page);
    await page.getByRole("button", { name: "Billing" }).click();
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
    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(page.getByText("January 15, 2099")).toBeVisible();
    await expect(checkoutButton(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /manage|cancel/i })
    ).toHaveCount(0);

    await openConsoleSettings(page);
    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByText("Subscription active")).toBeVisible();
    await expect(checkoutButton(page)).toHaveCount(0);
    await expect.poll(() => statusReads).toBe(2);
  });

  test("a successful return opens billing while disabled, stays confirming while inactive, and preserves the rest of the URL", async ({
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

    await expect(page.getByRole("button", { name: "Billing" })).toBeVisible();
    await expect(page.getByText("Confirming payment")).toBeVisible();
    await expect(page.getByText("Subscription active")).toHaveCount(0);
    await expect(checkoutButton(page)).toHaveCount(0);
    await expect(page).toHaveURL("/account?source=ledger#allowance");
    await expect.poll(() => statusReads).toBeGreaterThan(0);
  });

  test("database activation updates Auth.js with an object before showing success", async ({
    page,
  }) => {
    test.skip(CHECKOUT_ENABLED, "This is the in-flight flag-off contract.");
    let updateBody: unknown;
    let updates = 0;

    await page.route("**/api/auth/csrf", (route) =>
      route.fulfill({ json: { csrfToken: "e2e-csrf" } })
    );
    await page.route("**/api/auth/session", (route) => {
      if (route.request().method() !== "POST") {
        return route.fulfill({ json: sessionFor("demo") });
      }
      updateBody = route.request().postDataJSON();
      updates += 1;
      return route.fulfill({
        json: sessionFor(updates === 1 ? "demo" : "subscriber"),
      });
    });
    await mockAccountDependencies(page);
    await page.route("**/api/subscription", (route) =>
      route.fulfill({ json: subscriptionStatus(true) })
    );
    await page.goto("/account?checkout=success");
    await page.goto("/account?checkout=success");
    await expect(page.getByText("Subscription active")).toHaveCount(0);
    await expect(page.getByText("Subscription active")).toHaveCount(0);

    await expect(page.getByText("Subscription active")).toBeVisible();
    expect(updates).toBe(2);
    expect(updateBody).toMatchObject({
      data: { refreshSubscription: true },
    });
  });

  test("a cancelled return is neutral and restores the checkout action", async ({
    page,
  }) => {
    test.skip(!CHECKOUT_ENABLED, "This is the launch-flag-on contract.");
    await mockSession(page, "demo");
    await mockAccountDependencies(page);

    await page.goto("/account?checkout=cancelled");

    await expect(
      page.getByText("Checkout cancelled. No payment was taken.")
    ).toBeVisible();
    await expect(checkoutButton(page)).toBeEnabled();
    await expect(page.getByText(/payment failed/i)).toHaveCount(0);
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
    await page.getByRole("button", { name: "Billing" }).focus();
    await page.keyboard.press("Tab");
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
    await expect.poll(() => attempts).toBe(15);

    await page.getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => attempts).toBe(16);
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
    await page.getByRole("button", { name: "Billing" }).click();
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
    await page.getByRole("button", { name: "Billing" }).click();
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
