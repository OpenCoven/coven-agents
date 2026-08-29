# Credential key rotation

This runbook covers the application credential-encryption KEK ring.

## Credential KEK rotation

Each credential row records the KEK version wrapping its per-row data key and
the AAD format binding ciphertext to tenant and harness context. New writes use
`CREDENTIAL_KEK_CURRENT_VERSION`; reads use the row's exact versions and fail
closed on unknown values.

```dotenv
CREDENTIAL_KEK_CURRENT_VERSION=v1
CREDENTIAL_KEK_V1=
CREDENTIAL_KEK_V2=
CREDENTIAL_KEK=
CREDENTIAL_AAD_WRITES_ENABLED=false
```

The unversioned `CREDENTIAL_KEK` may temporarily alias only v1 and must equal
`CREDENTIAL_KEK_V1` when both are set.

### Rotation procedure

1. Apply the credential revision and AAD migration while
   `CREDENTIAL_AAD_WRITES_ENABLED=false`.
2. Drain application instances that cannot read AAD-bound rows.
3. Enable AAD-bound writes and deploy.
4. Bind existing rows in resumable batches:

   ```bash
   pnpm credentials:rewrap bind-aad --batch 100
   ```

5. Configure the existing key as `CREDENTIAL_KEK_V1`.
6. Add `CREDENTIAL_KEK_V2`, set
   `CREDENTIAL_KEK_CURRENT_VERSION=v2`, retain v1, and deploy.
7. Rewrap:

   ```bash
   pnpm credentials:rewrap --from v1 --to v2 --batch 100
   ```

8. Inspect without writing:

   ```bash
   pnpm credentials:rewrap --from v1 --to v2 --batch 100 --dry-run
   ```

9. Wait for encrypted idempotency-response retention to drain or migrate it
   through an approved procedure.
10. Run the retirement gate:

    ```bash
    pnpm credentials:rewrap verify --version v1
    ```

The gate requires zero `v1` rows, zero AAD-v0 credential rows, no unexpired
encrypted v1 idempotency rows, and successful unwrap of current rows. Output
contains counts and opaque row identifiers only.

- Exit `0`: retirement gate passed.
- Exit `2`: resumable work remains.
- Exit `1`: configuration or corruption failure.

Remove `CREDENTIAL_KEK` and then `CREDENTIAL_KEK_V1` only after the production
gate passes.

### Rollback before retirement

Keep both keys configured, set `CREDENTIAL_KEK_CURRENT_VERSION=v1`, deploy the
current AAD-capable application, and reverse the rewrap:

```bash
pnpm credentials:rewrap --from v2 --to v1 --batch 100
```

Do not deploy an application version that cannot read AAD-bound rows after any
such row exists. Do not remove either key until rollback and read-only
verification complete.
