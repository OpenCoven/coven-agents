import { connection } from "next/server";
import { subscriptionPageAuthority } from "@/app/(auth)/auth";
import { AccountSettings } from "@/components/account/account-settings";
import { subscriptionCheckoutEnabled } from "@/lib/billing/config";

type AccountPageProps = {
  searchParams: Promise<{
    checkout?: string | string[];
  }>;
};

// Checkout returns are request-specific, so this page intentionally blocks on
// searchParams instead of presenting a cached account shell as authoritative.
export const instant = false;

export default async function AccountPage({ searchParams }: AccountPageProps) {
  await connection();
  const now = new Date();
  const [{ checkout }, subscriptionAuthority] = await Promise.all([
    searchParams,
    subscriptionPageAuthority(now),
  ]);
  const checkoutResult =
    checkout === "success" || checkout === "cancelled" ? checkout : null;

  return (
    <AccountSettings
      checkoutEnabled={subscriptionCheckoutEnabled({
        SUBSCRIPTION_CHECKOUT_ENABLED:
          process.env.SUBSCRIPTION_CHECKOUT_ENABLED,
      })}
      checkoutResult={checkoutResult}
      subscriptionAuthority={subscriptionAuthority}
    />
  );
}
