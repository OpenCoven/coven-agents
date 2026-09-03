import { connection } from "next/server";
import { subscriptionPageAuthority } from "@/app/(auth)/auth";
import { RunConsole } from "@/components/console/run-console";
import { subscriptionCheckoutEnabled } from "@/lib/billing/config";
import { minutePacksFromEnv } from "@/lib/billing/minute-packs";

export const instant = false;

export default async function AgentsPage() {
  await connection();
  const subscriptionAuthority = await subscriptionPageAuthority(new Date());

  return (
    <RunConsole
      checkoutEnabled={subscriptionCheckoutEnabled({
        SUBSCRIPTION_CHECKOUT_ENABLED:
          process.env.SUBSCRIPTION_CHECKOUT_ENABLED,
      })}
      minutePacks={minutePacksFromEnv(process.env)}
      subscriptionAuthority={subscriptionAuthority}
    />
  );
}
