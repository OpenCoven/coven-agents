export const HOSTED_EXECUTION_CAPABILITY_CONTRACT_VERSION = "hosted-v1";

/**
 * Immutable server-selected configuration evidence for one hosted attempt.
 * Provider adapters construct it; request and browser code never supply it.
 */
export type RunnerExecutionProvenance = Readonly<{
  adapterVersion: string;
  capabilityContractVersion: string;
  lifecycle: string;
  pinnedSnapshot: string;
  productExecutionClass: "hosted";
  provider: string;
  target: string;
}>;
