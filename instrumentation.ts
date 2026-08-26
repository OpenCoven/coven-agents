import { OpenTelemetry } from "@ai-sdk/otel";
import { registerOTel } from "@vercel/otel";
import { registerTelemetry } from "ai";
import { validateAbuseConfig } from "./lib/abuse/config";

export function register() {
  validateAbuseConfig({
    globalDailyRunCap: process.env.GLOBAL_DAILY_RUN_CAP,
    isProduction: process.env.NODE_ENV === "production",
    keySecret: process.env.ABUSE_KEY_SECRET,
    redisUrl: process.env.REDIS_URL,
  });
  registerOTel({ serviceName: "chatbot" });
  registerTelemetry(new OpenTelemetry());
}
