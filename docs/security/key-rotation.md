# Runner key rotation

Runner identity keys are versioned. The app keeps the current Ed25519 private
key and the Worker keeps only public verification keys. Key IDs are part of the
signed claims and are routing hints, never authority.

## Configuration

On the app, configure `RUNNER_SIGNING_KEY_ID`, `RUNNER_SIGNING_KEY`, and
`RUNNER_SIGNING_PUBLIC_KEY`. During a rotation, also configure
`RUNNER_VERIFY_PREVIOUS_KEY_ID`, `RUNNER_VERIFY_PREVIOUS_KEY`, and
`RUNNER_VERIFY_PREVIOUS_RETIRE_AT`. On the Worker, configure
`RUNNER_VERIFY_KEY_ID`, `RUNNER_VERIFY_KEY`, and the same previous-key
variables. Set values through Vercel and Wrangler secrets; never commit or log
key material.

The legacy `RUNNER_SIGNING_KEY` plus `RUNNER_VERIFY_KEY` pair is accepted only
when no versioned current ID/public-key variables are present. It is a
fail-closed migration path, not a reason to overwrite a key in place.

## Rotation

1. Generate a new Ed25519 pair.
2. Deploy the new public key as the Worker's current key, retaining the old
   public key as `previous` with a retirement time at least 15 minutes plus
   bounded clock skew in the future. This covers the existing five-minute
   admission queue because expiry is measured from mint time; never retire the
   old key before the maximum token lifetime after its last possible issuance.
3. Switch the app's signing ID, private key, and matching public key.
4. Wait 15 minutes plus the configured skew, then remove the previous key.

The Worker cache is keyed by the complete configuration, so an environment
change is picked up immediately. Unknown IDs, mismatched key pairs, duplicate
IDs, and retired keys fail closed.

## Rollback

If the new signer is unhealthy, switch the app back to the old private key and
ID while both public keys remain configured. Keep the new key as previous until
all tokens it could have issued have expired, then remove it. Never shorten a
previous retirement window while tokens may still be queued or in flight.
