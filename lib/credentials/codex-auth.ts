import { z } from "zod";
import { encodeRunnerAttemptRedactionSecrets } from "../runner/redaction-secrets";

export const CODEX_AUTH_MESSAGE =
  "Codex needs ChatGPT CLI auth.json without an API key; each token must fit the supported redaction bounds (4096 UTF-8 bytes, no control characters).";

const token = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const authSchema = z.object({
  auth_mode: z.literal("chatgpt"),
  last_refresh: z.string().datetime({ offset: true }).optional(),
  tokens: z.object({
    access_token: token,
    account_id: token,
    id_token: token,
    refresh_token: token,
  }),
});

/** Keep only supported CLI sign-in fields; unknown private fields never stage. */
export function prepareCodexAuth(value: string): {
  value: string;
  secrets: readonly string[];
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      "OPENAI_API_KEY" in parsed &&
      parsed.OPENAI_API_KEY !== null
    ) {
      throw new Error(CODEX_AUTH_MESSAGE);
    }
    const auth = authSchema.parse(parsed);
    const secrets = [...new Set(Object.values(auth.tokens))];
    // Use the production codec itself, before save or process credential staging.
    // Whole JSON is not a secret unit: whitespace and combined token size
    // must not prevent persistence when every staged private value is covered.
    encodeRunnerAttemptRedactionSecrets(secrets);
    return { secrets, value: JSON.stringify(auth) };
  } catch {
    // biome-ignore lint/style/useErrorCause: Parser errors may contain credential bytes and must not escape.
    throw new Error(CODEX_AUTH_MESSAGE);
  }
}
