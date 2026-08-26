import { validateAbuseConfig } from "../lib/abuse/config";

validateAbuseConfig({
  globalDailyRunCap: process.env.GLOBAL_DAILY_RUN_CAP,
  isProduction: true,
  keySecret: process.env.ABUSE_KEY_SECRET,
  redisUrl: process.env.REDIS_URL,
});
