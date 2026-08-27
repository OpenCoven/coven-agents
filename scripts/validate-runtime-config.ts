import { validateAbuseConfig } from "../lib/abuse/config";
import { credentialKekRingFromEnvironment } from "../lib/credentials/key-ring";

async function main() {
  validateAbuseConfig({
    globalDailyRunCap: process.env.GLOBAL_DAILY_RUN_CAP,
    isProduction: true,
    keySecret: process.env.ABUSE_KEY_SECRET,
    redisUrl: process.env.REDIS_URL,
  });
  await credentialKekRingFromEnvironment();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime configuration is invalid."}\n`
  );
  process.exit(1);
});
