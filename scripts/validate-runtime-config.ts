import { validateAbuseConfig } from "../lib/abuse/config";
import { credentialKekRingFromEnvironment } from "../lib/credentials/key-ring";

async function main() {
  validateAbuseConfig({
    globalDailyRunCap: process.env.GLOBAL_DAILY_RUN_CAP,
    isProduction: true,
    keySecret: process.env.ABUSE_KEY_SECRET,
    redisUrl: process.env.REDIS_URL,
  });
  if (hasCredentialKekConfiguration(process.env)) {
    await credentialKekRingFromEnvironment();
  }
}

function hasCredentialKekConfiguration(
  environment: NodeJS.ProcessEnv
): boolean {
  return Object.keys(environment).some(
    (name) => name === "CREDENTIAL_KEK" || name.startsWith("CREDENTIAL_KEK_")
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime configuration is invalid."}\n`
  );
  process.exit(1);
});
