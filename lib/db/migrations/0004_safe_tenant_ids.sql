-- Tenant ids move from `user:<uuid>` / `demo:<uuid>` to `u_<32hex>` / `d_<32hex>`
-- so they satisfy the sandbox key pattern /^[A-Za-z0-9_]{1,64}$/. Rows keyed by
-- the old form would otherwise be orphaned: a connected credential would still
-- exist but never be found again, and the account page would offer to connect a
-- harness that was already connected.
--
-- Only a remainder that is genuinely a uuid is rewritten. Anything else is left
-- untouched rather than coerced -- an unparseable value has no correct new name,
-- and inventing one risks mapping two old tenants onto a single new one, which
-- would merge two accounts' sandboxes.

UPDATE "TenantCredential"
SET tenant = 'u_' || lower(replace(substring(tenant FROM 6), '-', ''))
WHERE tenant LIKE 'user:%'
  AND substring(tenant FROM 6) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
UPDATE "TenantCredential"
SET tenant = 'd_' || lower(replace(substring(tenant FROM 6), '-', ''))
WHERE tenant LIKE 'demo:%'
  AND substring(tenant FROM 6) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
UPDATE "RunUsage"
SET tenant = 'u_' || lower(replace(substring(tenant FROM 6), '-', ''))
WHERE tenant LIKE 'user:%'
  AND substring(tenant FROM 6) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
UPDATE "RunUsage"
SET tenant = 'd_' || lower(replace(substring(tenant FROM 6), '-', ''))
WHERE tenant LIKE 'demo:%'
  AND substring(tenant FROM 6) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
