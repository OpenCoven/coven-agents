import { expect, type Page, type Route, test } from "@playwright/test";
import { sessionCookies, subscriberCookies } from "./session";

const STARTED_DEVICE_FLOW = {
  binding: "owner-binding",
  deviceCode: "device-secret",
  expiresIn: 900,
  interval: 0.01,
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
};

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

async function subscriberSessionSetCookie(
  email: string,
  id: string,
  authVersion = 1
): Promise<string> {
  const [cookie] = await sessionCookies("subscriber", {
    authVersion,
    email,
    id,
  });
  if (!cookie) {
    throw new Error("Subscriber session cookie was not created.");
  }
  return `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax`;
}

function fulfillSessionOverride(
  route: Route,
  sessionOverride: Record<string, unknown> | undefined,
  setCookie: string | undefined
) {
  return sessionOverride === undefined
    ? route.continue()
    : route.fulfill({
        headers: setCookie ? { "set-cookie": setCookie } : undefined,
        json: sessionOverride,
      });
}

test.describe("Account settings", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signed-out visitors see a sign-in gate without protected requests", async ({
    page,
  }) => {
    const protectedRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        pathname === "/api/credentials" ||
        pathname === "/api/account/avatar" ||
        pathname === "/api/usage" ||
        pathname === "/api/subscription" ||
        pathname === "/api/checkout"
      ) {
        protectedRequests.push(pathname);
      }
    });

    await page.goto("/account?source=ledger&checkout=success#allowance");

    await expect(
      page.getByRole("heading", { name: "Sign in to manage your account" })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Faccount%3Fsource%3Dledger%26checkout%3Dsuccess%23allowance"
    );
    await expect(page.getByLabel("GitHub Copilot credential")).toHaveCount(0);
    expect(protectedRequests).toEqual([]);
  });

  test("subscriber account navigation and controls fit a phone viewport", async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/credentials", (route) =>
      route.fulfill({
        body: JSON.stringify({ harnessIds: [] }),
        contentType: "application/json",
        status: 200,
      })
    );

    await page.goto("/account");
    await expect(
      page.getByRole("heading", { name: "Harness credentials" })
    ).toBeVisible();
    const tablist = page.getByRole("tablist", { name: "Account settings" });
    const copilot = page.getByRole("tab", { name: "Copilot" });
    const profile = page.getByRole("tab", { name: "Profile" });
    await expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
    await copilot.focus();
    expect(
      await copilot.evaluate((button) => {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowDown",
        });
        button.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
    await page.keyboard.press("ArrowDown");
    await expect(copilot).toBeFocused();
    await expect(copilot).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(profile).toBeFocused();
    await expect(profile).toHaveAttribute("aria-selected", "true");
    const navigation = await page
      .getByRole("navigation", { name: "Account settings navigation" })
      .boundingBox();
    expect(navigation).not.toBeNull();
    expect(navigation?.width ?? 0).toBeGreaterThanOrEqual(360);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("credential authority loss clears a typed secret and closes the editor", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let credentialStatus = 200;
    await page.route("**/api/credentials", (route) =>
      route.fulfill(
        credentialStatus === 200
          ? { json: { harnessIds: [] } }
          : { status: credentialStatus }
      )
    );

    await page.goto("/account");
    const credential = page.getByLabel("GitHub Copilot CLI");
    await credential.fill("must-not-survive");
    credentialStatus = 401;
    const authorityRefresh = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/account" && request.headers().rsc === "1";
    });
    await page
      .getByRole("button", {
        exact: true,
        name: "Save GitHub Copilot CLI credential",
      })
      .click();

    await authorityRefresh;
    await expect(credential).toHaveCount(0);
    await expect(
      page.getByText("Storing a credential needs an active subscription.")
    ).toBeVisible();
  });

  test("desktop account settings expose vertical keyboard-operable ARIA tabs", async ({
    page,
  }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: {
          expires: "2099-01-01T00:00:00.000Z",
          user: {
            authVersion: 1,
            email: "tabs@example.invalid",
            id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
            image: null,
            name: "Tabs user",
            type: "subscriber",
          },
        },
      })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({
        body: JSON.stringify({ harnessIds: [] }),
        contentType: "application/json",
        status: 200,
      })
    );

    await page.goto("/account");

    const tablist = page.getByRole("tablist", { name: "Account settings" });
    await expect(tablist).toBeVisible();
    await expect(tablist).toHaveAttribute("aria-orientation", "vertical");
    const copilot = page.getByRole("tab", { name: "Copilot" });
    const profile = page.getByRole("tab", { name: "Profile" });
    const data = page.getByRole("tab", { name: "Data" });
    await expect(copilot).toHaveAttribute("aria-selected", "true");
    await expect(copilot).toHaveAttribute("tabindex", "0");
    await expect(copilot).toHaveAttribute(
      "aria-controls",
      "account-panel-copilot"
    );
    await expect(
      page.getByRole("tabpanel", { name: "Copilot" })
    ).toHaveAttribute("id", "account-panel-copilot");

    await copilot.focus();
    expect(
      await copilot.evaluate((button) => {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowRight",
        });
        button.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
    await page.keyboard.press("ArrowRight");
    await expect(copilot).toBeFocused();
    await expect(copilot).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(profile).toBeFocused();
    await expect(profile).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Profile" })).toBeVisible();

    await page.keyboard.press("End");
    await expect(data).toBeFocused();
    await expect(data).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(copilot).toBeFocused();
    await expect(copilot).toHaveAttribute("aria-selected", "true");
  });

  test("device start 403 clears the flow and shows subscription guidance", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: [] } })
    );
    await page.route("**/api/credentials/device", (route) =>
      route.fulfill({
        json: { error: "subscription_required" },
        status: 403,
      })
    );

    await page.goto("/account");
    await page.getByRole("button", { name: "Connect GitHub Copilot" }).click();

    await expect(
      page.getByText("Subscription required to connect GitHub Copilot.")
    ).toBeVisible();
    await expect(page.getByText(STARTED_DEVICE_FLOW.userCode)).toHaveCount(0);
  });

  test("device poll 403 clears the displayed code and stops the flow", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: [] } })
    );
    await page.route("**/api/credentials/device", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ json: STARTED_DEVICE_FLOW })
        : route.fulfill({
            json: { error: "subscription_required" },
            status: 403,
          })
    );

    await page.goto("/account");
    await page.getByRole("button", { name: "Connect GitHub Copilot" }).click();
    await expect(page.getByText(STARTED_DEVICE_FLOW.userCode)).toBeVisible();

    await expect(
      page.getByText("Subscription required to connect GitHub Copilot.")
    ).toBeVisible();
    await expect(page.getByText(STARTED_DEVICE_FLOW.userCode)).toHaveCount(0);
  });

  test("popup-blocked device flow focuses an atomic status instruction", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: [] } })
    );
    await page.route("**/api/credentials/device", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ json: STARTED_DEVICE_FLOW })
        : route.fulfill({ json: { status: "pending" } })
    );

    await page.goto("/account");
    await page.getByRole("button", { name: "Connect GitHub Copilot" }).click();

    const instructions = page.getByRole("status", {
      name: /ABCD-EFGH.*github\.com\/login\/device/i,
    });
    await expect(instructions).toBeVisible();
    await expect(instructions).toHaveAttribute("aria-live", "polite");
    await expect(instructions).toHaveAttribute("aria-atomic", "true");
    await expect(instructions).toHaveAttribute("tabindex", "-1");
    await expect(instructions).toContainText(STARTED_DEVICE_FLOW.userCode);
    await expect(instructions).toContainText(
      "Enter this code on GitHub, then come back"
    );
    await expect(instructions).toBeFocused();
    await expect(
      instructions.getByRole("link", {
        name: /Open github\.com\/login\/device/i,
      })
    ).toHaveAttribute("href", STARTED_DEVICE_FLOW.verificationUri);
  });

  test("leaving the credential tab cancels its pending device poll", async ({
    context,
    page,
  }) => {
    let polls = 0;
    await context.addCookies(await subscriberCookies());
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: [] } })
    );
    await page.route("**/api/credentials/device", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          json: { ...STARTED_DEVICE_FLOW, interval: 1 },
        });
      }
      polls += 1;
      return route.fulfill({ json: { status: "pending" } });
    });

    await page.goto("/account");
    await page.getByRole("button", { name: "Connect GitHub Copilot" }).click();
    await expect(page.getByText(STARTED_DEVICE_FLOW.userCode)).toBeVisible();
    await page.getByRole("tab", { name: "Profile" }).click();
    await page.waitForTimeout(1250);

    expect(polls).toBe(0);
  });

  test("successful device flow still connects and clears its code", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: [] } })
    );
    await page.route("**/api/credentials/device", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ json: STARTED_DEVICE_FLOW })
        : route.fulfill({ json: { status: "authorized" } })
    );

    await page.goto("/account");
    await page.getByRole("button", { name: "Connect GitHub Copilot" }).click();
    await expect(page.getByText(STARTED_DEVICE_FLOW.userCode)).toBeVisible();

    await expect(page.getByText("Copilot connected.")).toBeVisible();
    await expect(page.getByText(STARTED_DEVICE_FLOW.userCode)).toHaveCount(0);
  });

  test("an in-place account switch clears secrets and fences stale credential work", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies("first@example.invalid"));
    let sessionOverride: Record<string, unknown> | undefined;
    let sessionSetCookie: string | undefined;
    await page.route("**/api/auth/session", (route) =>
      fulfillSessionOverride(route, sessionOverride, sessionSetCookie)
    );

    let getCount = 0;
    let postCount = 0;
    let releaseFirstGet!: () => Promise<void>;
    let releaseFirstSave!: () => Promise<void>;
    let firstSaveStarted!: () => void;
    let secondGetStarted!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      firstSaveStarted = resolve;
    });
    const secondGet = new Promise<void>((resolve) => {
      secondGetStarted = resolve;
    });
    const savedCredentials: Array<{ credential: string; harnessId: string }> =
      [];
    await page.route("**/api/credentials", (route) => {
      const method = route.request().method();
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) {
          return new Promise<void>((resolve) => {
            releaseFirstGet = async () => {
              await route
                .fulfill({ json: { harnessIds: ["copilot"] } })
                .catch(() => undefined);
              resolve();
            };
          });
        }
        secondGetStarted();
        return route.fulfill({ json: { harnessIds: [] } });
      }
      if (method === "POST") {
        postCount += 1;
        const body = route.request().postDataJSON() as {
          credential: string;
          harnessId: string;
        };
        savedCredentials.push(body);
        if (postCount === 1) {
          firstSaveStarted();
          return new Promise<void>((resolve) => {
            releaseFirstSave = async () => {
              await route
                .fulfill({
                  json: { harnessId: body.harnessId, stored: true },
                })
                .catch(() => undefined);
              resolve();
            };
          });
        }
        return route.fulfill({
          json: { harnessId: body.harnessId, stored: true },
        });
      }
      return route.fallback();
    });

    await page.goto("/account");
    const input = page.getByLabel("GitHub Copilot");
    await input.fill("first-account-secret");
    await page
      .getByRole("button", { name: "Save GitHub Copilot CLI credential" })
      .click();
    await firstSave;

    const secondId = "00000000-0000-4000-8000-000000000002";
    sessionOverride = {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        authVersion: 2,
        email: "second@example.invalid",
        id: secondId,
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    sessionSetCookie = await subscriberSessionSetCookie(
      "second@example.invalid",
      secondId,
      2
    );
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { id?: string } };
      return body.user?.id === secondId;
    });
    await notifySessionChange(page);
    await sessionRefresh;

    await expect(input).toHaveValue("", { timeout: 1000 });
    await secondGet;
    await releaseFirstGet();
    await releaseFirstSave();
    await page.waitForTimeout(100);
    await expect(input).toHaveValue("");
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Credential stored.")).toHaveCount(0);

    await input.fill("second-account-secret");
    await page
      .getByRole("button", { name: "Save GitHub Copilot CLI credential" })
      .click();
    await expect(page.getByText("Credential stored.")).toBeVisible();
    await expect(input).toHaveValue("");
    expect(savedCredentials).toEqual([
      { credential: "first-account-secret", harnessId: "copilot" },
      { credential: "second-account-secret", harnessId: "copilot" },
    ]);
    expect(getCount).toBeGreaterThanOrEqual(3);
  });

  test("an account switch dismisses the previous account's credential notice", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies("first@example.invalid"));
    let sessionOverride: Record<string, unknown> | undefined;
    let sessionSetCookie: string | undefined;
    await page.route("**/api/auth/session", (route) =>
      fulfillSessionOverride(route, sessionOverride, sessionSetCookie)
    );
    await page.route("**/api/credentials", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { harnessIds: [] } })
        : route.fulfill({
            json: { message: "First account token rejected." },
            status: 422,
          })
    );

    await page.goto("/account");
    const input = page.getByLabel("GitHub Copilot");
    await input.fill("first-account-secret");
    await page
      .getByRole("button", { name: "Save GitHub Copilot CLI credential" })
      .click();
    await expect(page.getByText("First account token rejected.")).toBeVisible();

    const secondId = "00000000-0000-4000-8000-000000000002";
    sessionOverride = {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        authVersion: 2,
        email: "second@example.invalid",
        id: secondId,
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    sessionSetCookie = await subscriberSessionSetCookie(
      "second@example.invalid",
      secondId,
      2
    );
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { id?: string } };
      return body.user?.id === secondId;
    });
    await notifySessionChange(page);
    await sessionRefresh;

    await expect(input).toHaveValue("");
    await expect(page.getByText("First account token rejected.")).toHaveCount(
      0
    );
  });
});
