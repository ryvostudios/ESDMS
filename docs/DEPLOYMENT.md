# Deployment

This is the authoritative ESDMS deployment sequence. New environments begin as
staging/acceptance; promotion to production is a separate explicit decision.

## Ownership and credential boundary

Use company-owned Git, Supabase, hosting, storage and DNS. Build a new database
from migrations; do not clone operational data from another environment.

Keep these credentials separate:

- `MIGRATION_DATABASE_URL`: schema owner/admin, available only to the reviewed
  database-release job or operator.
- `DATABASE_URL`: `esdms_runtime`, available to the API only.
- `ESDMS_RUNTIME_PASSWORD`: release-job input used to create/rotate the runtime
  login; it is not an API environment variable.

Never grant runtime ownership, `SUPERUSER`, `BYPASSRLS`, schema `CREATE`,
migration-ledger access, broad `GRANT ALL`, or migration authority. Do not put
database or application secrets in Git, command arguments, frontend variables,
build output, or reports.

## Release sequence

From a verified source revision in `backend/`, inject the three database values
above through a secret-safe environment and run:

```bash
npm ci
npm run db:release
```

`db:release` performs the mandatory order:

1. Apply reviewed migrations with `MIGRATION_DATABASE_URL`.
2. Run `scripts/provision-db-roles.sql` as the migration owner.
3. Connect with runtime `DATABASE_URL` and verify grants, RLS, ownership,
   functions, sequences, the provisioning version, the exact login/`/me`
   profile query, and fleet reads.

The command is idempotent. It validates that `DATABASE_URL` names
`esdms_runtime`, that both URLs target the same host/port/database, that the two
credentials are not conflated, and that its runtime password inputs agree. Use
the same managed/pooler endpoint for both identities. It redacts those inputs
from captured child output. Do not replace it with `migrate:up` alone and do
not run migrations on every API process start.

## Bootstrap and deploy

After database release succeeds:

1. Confirm migration/reference state and create exactly one permanent original
   CEO with `npm run user:create-ceo`; collect its password through the
   script's hidden prompt. Do not create a generic root or second bootstrap
   account. Record its email as the protected deployment setting
   `ESDMS_ORIGINAL_CEO_EMAIL` for any future non-production reset operation.
2. Configure the backend with runtime `DATABASE_URL` only, fresh JWT/application
   secrets, company URLs, verified TLS, private durable storage, and the
   documented production settings. Keep WhatsApp disabled/simulated unless
   official company Cloud API credentials are available.
3. Deploy backend and frontend from the same verified company Git revision.
   The real health check is `/api/v1/health/ready`, not liveness `/health`.
4. Verify direct and proxied readiness, valid CEO login, authenticated `/me`,
   invalid-login 401, Governance, Material/Demand, Driver/Vehicle, Gate/Guard,
   evidence/PDF, desktop and mobile acceptance, and security boundaries before
   promotion.

Healthy readiness requires both `schemaCompatible=true` and
`runtimeProvisioningCompatible=true`. Migration count/current schema is not
proof that the API role can serve the application.

## Safe reset

Use the operational reset only on an explicitly confirmed non-production
database and follow `OPERATIONS.md`. Validate it on a disposable equivalent
before company acceptance. Never reset the accepted staging database after the
real CEO or business data exists without separate explicit authorization. The
reset must preserve the one original active CEO, system roles, permissions,
capability bundles, reference state, and Site.
