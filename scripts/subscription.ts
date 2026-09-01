#!/usr/bin/env tsx
import {
  applySubscriptionOverride,
  runSubscriptionCli,
} from "@/lib/billing/subscription-override";
import {
  databaseSubscriptionOverrideStore,
  findSubscriptionOverrideUserByEmail,
} from "@/lib/db/queries";

async function main(): Promise<number> {
  const response = await runSubscriptionCli(process.argv.slice(2), {
    applyOverride: (input) =>
      applySubscriptionOverride(databaseSubscriptionOverrideStore, input),
    findUserByEmail: findSubscriptionOverrideUserByEmail,
    now: () => new Date(),
  });
  (response.code === 0 ? process.stdout : process.stderr).write(
    response.output
  );
  return response.code;
}

main()
  .then((code) => process.exit(code))
  .catch(() => {
    process.stderr.write("Subscription command failed.\n");
    process.exit(1);
  });
