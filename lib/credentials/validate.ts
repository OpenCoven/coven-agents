/** What a Copilot entitlement check tells us about a pasted token. */
export type TokenCheck = "invalid_token" | "no_copilot" | "unknown" | "valid";

/**
 * Interprets `GET /copilot_internal/user`.
 *
 * The Copilot CLI treats any non-2xx as a hard failure. This is more careful,
 * because the two failures a person can act on are different: a token GitHub
 * does not recognise is a paste error, and a token without Copilot is the
 * wrong kind of token. Telling them apart is the whole point of checking on
 * save rather than letting the first run fail.
 *
 * Anything else is `unknown` and deliberately does NOT block the save.
 * Refusing on an unexpected status would make GitHub's availability a hard
 * dependency of setup, which trades a rare wrong-token for a common
 * cannot-configure-at-all.
 */
export function interpretCopilotCheck(status: number): TokenCheck {
  if (status >= 200 && status < 300) {
    return "valid";
  }

  if (status === 401) {
    return "invalid_token";
  }

  if (status === 403 || status === 404) {
    // 404 on this endpoint means the account has no Copilot record at all,
    // which is indistinguishable from "not entitled" for our purposes.
    return "no_copilot";
  }

  return "unknown";
}

/** Whether a check result should stop the credential being stored. */
export function blocksSave(check: TokenCheck): boolean {
  return check === "invalid_token" || check === "no_copilot";
}

const MESSAGES: Record<TokenCheck, string> = {
  invalid_token:
    "GitHub did not recognise that token. Check it was copied whole and has not expired.",
  no_copilot:
    "That token is valid but has no Copilot access. Use a fine-grained PAT with the Copilot Requests permission, or an OAuth token from the Copilot CLI.",
  unknown: "",
  valid: "",
};

export function checkMessage(check: TokenCheck): string {
  return MESSAGES[check];
}

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Asks GitHub whether this token can actually use Copilot.
 *
 * The same endpoint the Copilot CLI checks entitlement against, so a token
 * that passes here is a token the harness will accept — the check and the
 * consumer agree because they ask the same question.
 *
 * A thrown fetch resolves to `unknown` rather than propagating: an outage
 * should leave the credential storable, not make setup impossible.
 */
export async function checkCopilotToken(
  token: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<TokenCheck> {
  // The E2E adapter proves the real credential route and encryption boundary
  // without allowing its deterministic dummy token onto the network.
  if (hermeticRunnerMode() === "hermetic") {
    return token.trim() ? "valid" : "invalid_token";
  }
  try {
    const response = await fetchImpl(COPILOT_USER_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });

    return interpretCopilotCheck(response.status);
  } catch {
    return "unknown";
  }
}

import "server-only";

import { hermeticRunnerMode } from "@/lib/runner/hermetic/mode";
