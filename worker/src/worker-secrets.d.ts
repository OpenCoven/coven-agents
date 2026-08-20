/**
 * Secret bindings are not written into the generated `worker-configuration.d.ts`,
 * and a Worker never exposes them on `process.env` — only `vars` reach that
 * object, and only under `nodejs_compat`. Declaring the secret here keeps the
 * handler reading from the `env` binding that actually carries it.
 *
 * This merges into the global `Env` interface that `worker-configuration.d.ts`
 * declares, so regenerating those types does not drop it.
 */

interface Env {
  AGENT_CONTROL_TOKEN?: string;
}
