import { RunConsole } from "@/components/console/run-console";
import { subscriptionCheckoutEnabled } from "@/lib/billing/config";

export default function AgentsPage() {
  return (
    <RunConsole
      checkoutEnabled={subscriptionCheckoutEnabled({
        SUBSCRIPTION_CHECKOUT_ENABLED:
          process.env.SUBSCRIPTION_CHECKOUT_ENABLED,
      })}
    />
  );
}
