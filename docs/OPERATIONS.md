# Operations

## Release procedure

`DEPLOYMENT.md` describes the same sequence from the platform side (services,
environment and topology); this section is the operator's runbook for it. They
must not diverge — the ordering below is the authoritative one.

Run in this order. Steps 2 and 3 are two separate privileged operations, and
running only the first is exactly how a deployment reaches "every object
present, every query denied": a migration adds a table, the runtime role never
receives a grant or an RLS policy for it, and the API serves 500s.
`npm run db:release` performs both and then verifies the result, so the second
cannot be forgotten.

| # | Step | Command | Gate |
| --- | --- | --- | --- |
| 1 | Build from a verified revision | `npm ci && npm test` (backend), `npm ci && npm run lint && npm test && npm run build` (frontend) | All green |
| 2 | Apply schema migrations | `npm run db:release` (step 1 of 3) | Migrations complete |
| 3 | Provision runtime database privileges and row policies | same command (step 2 of 3) | Provisioning COMMITs its own verification |
| 4 | Verify the runtime login can actually serve | same command (step 3 of 3) | Connects **as the runtime role** and requires `ready: true` |
| 5 | Deploy the backend | platform-specific | Process starts |
| 6 | Deploy the frontend | platform-specific | Build published |
| 7-10 | Readiness, login, `/me`, sign-out, wrong-password rejection | `npm run verify:deployment -- https://api.example.com` | Every check `ok` |

```bash
cd backend

# Step 1-4. MIGRATION_DATABASE_URL is the schema owner; DATABASE_URL is the
# restricted runtime login the API uses. Both live on the operator machine or
# the release job — never in the API process's own environment.
read -rs ESDMS_RUNTIME_PASSWORD && export ESDMS_RUNTIME_PASSWORD
export MIGRATION_DATABASE_URL=...   # schema owner
export DATABASE_URL=...             # esdms_runtime
npm run db:release
unset ESDMS_RUNTIME_PASSWORD

# Steps 5-6: deploy backend, then frontend.

# Steps 7-10. Readiness alone is NOT proof that a user can sign in: it runs
# the authentication query with a sentinel id, while this runs it with a real
# credential, an Argon2 verification, a JWT signature and a session cookie.
ESDMS_SMOKE_EMAIL=... ESDMS_SMOKE_PASSWORD=... \
  npm run verify:deployment -- https://api.example.com
```

`verify:deployment` refuses to report success without credentials, signs out
the session it created, and asserts that a wrong password is still rejected —
a deployment that accepted anything would otherwise pass every other check.

### Before enforcing a new data invariant

Two migrations refuse to run rather than silently repairing data, because the
repair is a business decision that reassigns history. Check both before a
release that includes them, so a conflict is found deliberately rather than
during a deploy:

```bash
npm run report:duplicate-company-items   # exits non-zero and names conflicts
```

Driver CNIC/licence normalization refuses the same way, naming the site and
the conflicting value. Resolve conflicts in the application — archive, rename
or deactivate the redundant record — then re-run the release. Neither
migration merges records, and neither leaves a partially applied ledger.

### What each failure means

| Symptom | Cause | Action |
| --- | --- | --- |
| `/health/ready` 503, `schemaCompatible: false` | Migrations not applied, or an object is missing | Re-run step 2 |
| `/health/ready` 503, `runtimeAccessHealthy: false` | Provisioning not run since the last table-adding migration | Re-run step 3; `problems` names the exact missing privileges |
| `/health/ready` 503, `authServingHealthy: false` | The runtime role cannot execute the authentication query | Re-run step 3 |
| `/health/ready` 503, `runtimeProvisioningCompatible: false` | Provisioning is stale or the privilege boundary is broken (role membership, excess grant, unexpected callable function, wrong policy shape) | Re-run step 3; `problems` names the failed checks |
| `/health/ready` 200 but login fails | Should now be impossible — report it | Capture `problems` and the request id |
| Frontend and backend revisions differ | Deploy skew | Redeploy the lagging side; `/diagnostics` shows both |

## Safe non-production data reset

`backend/scripts/reset-operational-data.js` clears operational/demo data so an
owner can rebuild their organization by hand through the UI. It is **not** a
migration-down, not a `TRUNCATE`, and it never weakens an application
guarantee: the runtime database role still cannot delete a Gate Pass or
rewrite an audit log after it has run.

```bash
cd backend
DATABASE_URL=postgresql://localhost:5432/eset_dev \
ESDMS_RESET_CONFIRM=eset_dev \
ESDMS_ORIGINAL_CEO_EMAIL=ceo@company.example \
npm run reset:operational-data
```

It refuses to run when:

* `NODE_ENV=production`;
* the database name or host looks like production (matches `prod`);
* `ESDMS_RESET_CONFIRM` does not exactly equal the target database name;
* `ESDMS_ORIGINAL_CEO_EMAIL` is missing or does not identify the active CEO
  role account created as this environment's permanent original CEO — so the
  reset never relies on an age/name heuristic or leaves the database with no
  way back in.

Everything happens in one transaction, and the script verifies before
committing that each table it claims to clear is empty and that the reference
data, the single Site and the configured permanent original CEO survived.

**Preserved:** schema/migrations, roles, permissions, capability bundles,
units of measure, document-number settings, one Site, and the configured
permanent original CEO login (same id, email, password hash and authority).

**Cleared:** every operational record — users other than the original CEO,
employees and assignments, departments, positions, workforce configuration
catalogs, materials, Demands, pricing, IPOs, Delivery Challans, receipts, Gate
Passes and their evidence, Drivers and Vehicles, leave/contracts/documents,
governance and procurement audit rows, the notification outbox, and every
document-number counter (so a rebuilt organization starts numbering at 1).

After a reset, sign in as the original CEO and rebuild through the UI:
Departments and Positions and Employment Types under Workforce Config,
Employees under Employees (each can be given a login from its own page, which
starts at EMPLOYEE role), then role and capability-bundle assignment under
Governance — Site Administrator, Site Manager, Team Lead, Gate Guard, plus the
Procurement Staff and Formal / Financial Approver bundles. Drivers, Vehicles
and Materials each have their own screen. No manual SQL is required.

An HR Position named "Administration Team Lead" grants zero application
authority: the account's role and capability bundles are the only source of
authority, and they are set separately in Governance.

## WhatsApp document delivery

Delivery runs entirely through the durable notification outbox: a Gate Pass
approval and a Gate Pass completion each enqueue a document job inside the
transaction that made the change, so the business record commits first and no
render, storage or provider failure can roll it back or block it.

Only the official WhatsApp Business Platform (Meta Cloud API) is supported.
There is deliberately no WhatsApp Web scraping, headless-browser automation or
reverse-engineered session library anywhere in this system.

Without credentials the clearly-labelled demo provider is selected at startup
and only ever reports `SIMULATED`, never `SENT`, so a demo run can never be
mistaken for a real delivery. To enable real delivery, set:

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_ENABLED` | Turns the official provider on. |
| `WHATSAPP_ACCESS_TOKEN` | Meta Cloud API access token (secret). |
| `WHATSAPP_PHONE_NUMBER_ID` | The sending business phone number id. |
| `WHATSAPP_API_BASE_URL`, `WHATSAPP_API_VERSION` | Endpoint and Graph API version. |

Provider selection happens once, at startup, so a half-configured deployment
can never silently send from a real account. External setup that must be done
outside this repository: creating the Meta Business account and WhatsApp
Business Platform app, verifying the sending number, and — for group
delivery — whatever destination identifier the business uses, configured per
department (`departments.whatsapp_destination`).
