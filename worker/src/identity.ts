/**
 * The worker's view of identity verification.
 *
 * The implementation lives in `@opencoven/agent-contracts` because the app
 * verifies the same tokens when the worker asks it for a credential, and two
 * copies of a signature check are two things that can drift apart. The worker
 * still only ever holds a public key.
 */
export {
  importVerifyKey,
  verifyRunnerToken,
} from "@opencoven/agent-contracts";
