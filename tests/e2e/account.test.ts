import { expect, test } from "@playwright/test";
import { subscriberCookies } from "./session";

const STARTED_DEVICE_FLOW = {
  deviceCode: "device-secret",
  expiresIn: 900,
  interval: 0.01,
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
};

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
    await expect(
      page.getByRole("link", { name: "Sign in with GitHub" })
    ).toHaveAttribute(
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
    await page.getByRole("button", { exact: true, name: "Save" }).click();

    await expect(credential).toHaveCount(0);
    await expect(
      page.getByText("Sign in again to manage harness credentials.")
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
});
