/**
 * Secret bindings are not written into the generated `worker-configuration.d.ts`,
 * and a Worker never exposes them on `process.env` — only `vars` reach that
 * object, and only under `nodejs_compat`. Declaring the secrets here keeps the
 * handler reading from the `env` binding that actually carries them.
 *
 * This merges into the global `Env` interface that `worker-configuration.d.ts`
 * declares, so regenerating those types does not drop it.
 *
 * Harness credentials are never declared here. They belong to a tenant, not
 * to this deployment, and are fetched per run from the Next app instead —
 * see `tenant-credentials.ts`. Coven Agents holds no model provider API key
 * either.
 */

interface Env {
  AGENT_CONTROL_TOKEN?: string;
  /**
   * Harness credentials are per tenant and fetched at run time. They are
   * deliberately absent from this deployment: a forbidden fallback survives
   * refactors, an absent one cannot.
   */
  APP_ORIGIN?: string;
  EDGE_ABUSE_KEY_SECRET?: string;
  /** Dedicated operator credential for the rate-limited diagnostic route only. */
  OPERATOR_DIAGNOSTIC_TOKEN?: string;
  RUNNER_SERVICE_TOKEN?: string;
  RUNNER_VERIFY_KEY?: string;
  RUNNER_VERIFY_KEY_ID?: string;
  RUNNER_VERIFY_PREVIOUS_KEY?: string;
  RUNNER_VERIFY_PREVIOUS_KEY_ID?: string;
  RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT?: string;
  RUNNER_VERIFY_PREVIOUS_RETIRE_AT?: string;
}
