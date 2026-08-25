import { validateAbuseConfig } from "../lib/abuse/config";

validateAbuseConfig({
  isProduction: true,
  keySecret: process.env.ABUSE_KEY_SECRET,
  redisUrl: process.env.REDIS_URL,
});
