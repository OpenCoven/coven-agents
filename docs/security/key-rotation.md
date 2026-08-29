# Credential key rotation

This runbook covers the application credential-encryption KEK ring. The retired
Cloudflare runner signing and verification keys are no longer runtime
configuration and require no application rotation procedure.

## Credential KEK rotation

Credential rows carry the exact KEK version that wrapped their per-credential
data key and an `aadVersion`. Version `0` is the explicit legacy format with
no AES-GCM associated data; version `1` binds credential ciphertext to a
canonical tenant+harness context. The app encrypts new rows only with
`CREDENTIAL_KEK_CURRENT_VERSION`; reads use the row's exact KEK and AAD
versions and never infer or try another format when a row is unknown.

Configure the fixed ring through the secret manager:

```dotenv
CREDENTIAL_KEK_CURRENT_VERSION=v1
CREDENTIAL_KEK_V1=
CREDENTIAL_KEK_V2=
CREDENTIAL_KEK=
CREDENTIAL_AAD_WRITES_ENABLED=false
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
   or AAD-version update unless the revision changes. Keep
   `CREDENTIAL_AAD_WRITES_ENABLED=false` during the rolling deployment, so
   upgraded writers continue producing `aadVersion=0` envelopes that old
   readers can decrypt. The database default also remains `0` for pre-change
   writers. Roll out the new readers and writers, then drain every old instance.
   An old writer's update fails closed with the revision-trigger error instead
   of silently writing an unbound envelope under a newer label. Do not remove
   the `aadVersion=0` default until the legacy drain and AAD retirement gate
   have both passed.
2. After every old reader and writer has drained, set
   `CREDENTIAL_AAD_WRITES_ENABLED=true` and deploy. New credential writes and
   OAuth refreshes and encrypted idempotency responses now produce
   `aadVersion=1`. Old code cannot read AAD-bound ciphertext, so do not open
   this gate before the drain is verified. Then bind legacy credential rows in
   resumable batches:

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
