import { loadEnvConfig } from "@next/env";

import { validateRuntimeConfig } from "./runtime-config-validation";

const explicitRelease = process.argv.includes("--release");

async function main(): Promise<void> {
  if (explicitRelease) {
    loadEnvConfig(process.cwd(), false);
  }

  await validateRuntimeConfig(process.env, explicitRelease);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime configuration is invalid."}\n`
  );
  process.exit(1);
});
