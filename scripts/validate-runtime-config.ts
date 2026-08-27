import { loadEnvConfig } from "@next/env";

import { validateRuntimeConfig } from "./runtime-config-validation";

const explicitRelease = process.argv.includes("--release");

if (explicitRelease) {
  loadEnvConfig(process.cwd(), false);
}

validateRuntimeConfig(process.env, explicitRelease);
