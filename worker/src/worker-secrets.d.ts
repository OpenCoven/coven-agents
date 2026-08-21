/**
 * Secret bindings are not written into the generated `worker-configuration.d.ts`,
 * and a Worker never exposes them on `process.env` — only `vars` reach that
 * object, and only under `nodejs_compat`. Declaring the secrets here keeps the
 * handler reading from the `env` binding that actually carries them.
 *
 * This merges into the global `Env` interface that `worker-configuration.d.ts`
 * declares, so regenerating those types does not drop it.
 *
 * Every credential below is a *harness* credential: the token a signed-in coding
 * CLI reads for itself. Coven Agents holds no model provider API key.
 */

interface Env {
  AGENT_CONTROL_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CODEX_API_KEY?: string;
  COPILOT_GITHUB_TOKEN?: string;
  GH_TOKEN?: string;
  GITHUB_TOKEN?: string;
}
