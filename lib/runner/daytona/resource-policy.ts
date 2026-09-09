/**
 * Public policy constants, not an attestation of a deployed snapshot.
 * Keep this module free of server, environment, and provider SDK imports.
 */
export const DAYTONA_PROVIDER_RESOURCE_MAXIMA = Object.freeze({
  cpu: 4,
  disk: 10,
  memory: 8,
});
export const DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS = Object.freeze({
  autoArchiveInterval: 10_080,
  autoStopInterval: 15,
  cpu: 2,
  disk: DAYTONA_PROVIDER_RESOURCE_MAXIMA.disk,
  memory: 4,
});
export const DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS = Object.freeze({
  autoArchiveInterval: 43_200,
  autoStopInterval: 60,
  cpu: DAYTONA_PROVIDER_RESOURCE_MAXIMA.cpu,
  disk: DAYTONA_PROVIDER_RESOURCE_MAXIMA.disk,
  memory: DAYTONA_PROVIDER_RESOURCE_MAXIMA.memory,
});
