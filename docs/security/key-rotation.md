# Runner key rotation

Runner identity keys are versioned. The app keeps the current Ed25519 private
key and the Worker keeps only public verification keys. Key IDs are part of the
signed claims and are routing hints, never authority.

## Configuration

On the app, configure `RUNNER_SIGNING_KEY_ID`, `RUNNER_SIGNING_KEY`, and
`RUNNER_SIGNING_PUBLIC_KEY`. During a rotation, also configure
`RUNNER_VERIFY_PREVIOUS_KEY_ID`, `RUNNER_VERIFY_PREVIOUS_KEY`,
`RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT`, and
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
   public key as `previous`.
3. Switch the app's signing ID, private key, and matching public key. Record
   the exact UTC timestamp of that switch as
   `RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT`; this is the last instant the old
   signer could mint a token.
4. Set `RUNNER_VERIFY_PREVIOUS_RETIRE_AT` to at least that timestamp plus
   `TOKEN_LIFETIME_SECONDS` and `TOKEN_CLOCK_SKEW_SECONDS` (15 minutes plus
   configured clock skew). The app and Worker reject an earlier retirement,
   while restarts remain safe even after the retirement instant has passed.
5. After retirement, remove the previous key variables.

The Worker cache is keyed by the complete configuration, so an environment
change is picked up immediately. Unknown IDs, mismatched key pairs, duplicate
IDs, and retired keys fail closed.

## Rollback

If the new signer is unhealthy, switch the app back to the old private key and
ID while both public keys remain configured. Keep the new key as previous with
its own last-signed timestamp and retirement boundary until all tokens it could
have issued have expired. Never shorten a previous retirement window while
tokens may still be queued or in flight.

## Credential KEK rotation

Credential rows carry the exact KEK version that wrapped their per-credential
data key and an `aadVersion`. Version `0` is the explicit legacy format with
no AES-GCM associated data; version `1` binds every new credential ciphertext
to a canonical tenant+harness context. The app encrypts new rows only with
`CREDENTIAL_KEK_CURRENT_VERSION`; reads use the row's exact KEK and AAD
versions and never infer or try another format when a row is unknown.

Configure the fixed ring through the secret manager:

```dotenv
CREDENTIAL_KEK_CURRENT_VERSION=v1
CREDENTIAL_KEK_V1=
CREDENTIAL_KEK_V2=
CREDENTIAL_KEK=
```

During the staged migration, the existing unversioned `CREDENTIAL_KEK` may
alias **only** `v1`. If both `CREDENTIAL_KEK` and `CREDENTIAL_KEK_V1` are set,
they must be the same value; otherwise the app fails closed. Always configure
the current version and its matching key. Blank, malformed, duplicate, or
unknown versions are rejected. KEK values may use unpadded base64url or the
existing padded standard-base64 encoding. Imported KEKs are non-extractable and
key material is never logged.

### Rotation procedure

1. Apply the credential revision/AAD migration before changing application
   traffic. It adds non-null `envelopeRevision` and `aadVersion` defaults and
   a database trigger that rejects any ciphertext, IV, wrapped-key, KEK-version,
   or AAD-version update unless the revision changes. Roll out the new writers, then
   drain every old writer before allowing credential updates: old writers may
   still insert rows (the database labels omitted revisions with fresh defaults
   and those rows remain explicit `kekVersion=v1`, `aadVersion=0`), but an old
   writer's update fails closed with the revision-trigger error instead of
   silently writing an unbound envelope under a newer label.
2. Deploy the new readers and writers, and keep old readers and writers drained
   before binding legacy rows. Old code cannot read AAD-bound ciphertext.
   Convert legacy rows in resumable batches:

   ```bash
   pnpm credentials:rewrap bind-aad --batch 100
   ```

   The command decrypts one `aadVersion=0` row in memory, re-encrypts it with
   the current KEK and canonical tenant+harness AAD, then updates it only when
   its `envelopeRevision` still matches. It prints only opaque row IDs on
   failure. Repeat until it exits `0`; exit `2` means resume after a CAS race.
3. Deploy the application with
   `CREDENTIAL_KEK_CURRENT_VERSION=v1` and the existing secret in
   `CREDENTIAL_KEK_V1`. Keep `CREDENTIAL_KEK` only as the equal legacy alias
   while old rows exist.
4. Add the new secret as `CREDENTIAL_KEK_V2`, switch
   `CREDENTIAL_KEK_CURRENT_VERSION=v2`, retain `CREDENTIAL_KEK_V1`, and deploy.
5. Rewrap resumably. Repeat after interruptions or concurrent updates:

   ```bash
   pnpm credentials:rewrap --from v1 --to v2 --batch 100
   ```

6. Check the target without writing:

   ```bash
   pnpm credentials:rewrap --from v1 --to v2 --batch 100 --dry-run
   ```

   Dry-run verifies every target-version wrapped data key without writing or
   claiming completion of the source migration. It returns `0` when target
   rows are clean and `1` for configuration or corruption.

7. Wait for the bounded device-response retention window to drain, or
   rewrap those idempotency envelopes through an equivalent reviewed operator
   procedure. The retirement gate reads unexpired completed
   `IdempotencyRecord` envelopes without exposing their bodies: versioned
   payloads use their exact version, legacy payloads without `kekVersion` are
   v1, and `plain_json` responses are ignored. A malformed encrypted response
   fails the gate. The normal rewrap command intentionally does not rewrite
   these short-lived rows.
8. Run the retirement gate in production:

   ```bash
   pnpm credentials:rewrap verify --version v1
   ```

   It succeeds only when zero legacy rows remain: zero `v1` rows (credential
   rows), zero `aadVersion=0` credential rows, zero unexpired encrypted v1
   idempotency envelopes, and every current-version credential and idempotency
   wrapped data key pass read-only unwrapping. It prints counts and opaque row IDs for credential or
   idempotency records only; it never prints tenants, harnesses, credentials,
   response bodies,
   ciphertext, or keys. Exit `0` is a complete gate. Exit `2` means resume
   because v1 rows remain or a compare-and-swap was skipped. Exit `1` means
   configuration or corruption failure. A normal rewrap never claims
   completion when it exits `2`; rerun it until the verify command exits `0`.
9. After the gate passes, remove the `CREDENTIAL_KEK` compatibility alias.
   Retire `CREDENTIAL_KEK_V1` only after the same zero-row and current-key
   verification conditions hold in production. Removing a key before the gate
   makes affected credentials unreadable.

### Rollback before retirement

If the new key is unhealthy, set
`CREDENTIAL_KEK_CURRENT_VERSION=v1` and keep both `CREDENTIAL_KEK_V1` and
`CREDENTIAL_KEK_V2` configured. Existing `v2` rows remain readable, and the
rewrap is reversible:

```bash
pnpm credentials:rewrap --from v2 --to v1 --batch 100
```

Do not remove either key until the rollback is complete and the appropriate
read-only verification gate passes.

If rollback is required after AAD binding, keep the new readers deployed: they
read both explicit AAD versions, while old code cannot read version `1`.
Therefore drain old writers/readers before binding and do not roll back to an
old application binary after any `aadVersion=1` row exists. A database restore
or forward re-encryption is required to return to a wholly legacy format.
