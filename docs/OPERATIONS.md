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

## Safe local operational-data reset

`backend/scripts/reset-operational-data.js` is an offline maintenance tool,
not an application API or a production reset mechanism. Its owner credential
must never be installed in the API environment.

Start with `npm run reset:operational-data -- --dry-run` from `backend`, with
`DATABASE_URL` and `ESDMS_ORIGINAL_CEO_EMAIL` supplied privately. Dry run opens
an explicit read-only transaction and returns counts, business file references,
cloud object IDs/paths, safe connection status, and blockers. It neither
contacts storage providers nor changes database rows. Its inventory contains
identifiers: keep it private and outside Git.

Execution requires all of the following:

- Explicit human approval of the exact environment, permanent CEO and inventory.
- Local PostgreSQL, non-production environment, and an active existing CEO
  matching `ESDMS_ORIGINAL_CEO_EMAIL`; no account is created or selected by age.
- `ESDMS_RESET_CONFIRM` exactly matching the database name.
- A fresh database **and file** backup, verified by restoring into isolation;
  acknowledge that check with `ESDMS_RESET_BACKUP_CONFIRMED` matching the name.
  This is an operator attestation, not an automated backup-verification claim.
- API and outbox workers stopped; external provider deactivated; reviewed file
  cleanup completed and verified; personal connections revoked through CMS.
- No individual CEO override/bundle assignments that would be silently erased;
  such a target requires an explicitly reviewed authority-preservation plan.
- No connected/encrypted cloud credentials, active cloud provider, or undeleted
  cloud registry objects. A retained cloud-backed logo blocks deletion too.
- Referenced local files absent under an explicitly configured `STORAGE_DIR`
  and `STORAGE_PROVIDER=local`. Supabase-backed cleanup is not implemented by
  this tool and is refused; it needs a separately verified provider workflow.

The tool never deletes provider objects or revokes tokens. Do not merely mark
cloud rows deleted to bypass its guard. Storage operations cannot be rolled
back by PostgreSQL; follow the backup and reconciliation sequence in
[PRE_HANDOVER_AUDIT.md](PRE_HANDOVER_AUDIT.md).

**Preserved:** the original CEO identity, password and scope; all sites,
departments, positions and workforce configuration; roles, permissions,
capability definitions and metadata; units; document settings; CMS content and
branding; migration history and security/provisioning objects. Review these
rows separately: preservation does not certify a QA-only reference as company
data. References to removed users in CMS/document-setting updater fields are
cleared; setting values are preserved. Empty provider definition rows remain,
with personal account metadata cleared.

**Removed after safeguards pass:** other users; employee/assignment/history,
compensation/contracts/documents/leave/rotation data; materials/catalogs;
Demands/pricing/approvals; IPOs/purchases; receipts/Delivery Challans; Gate
Passes/evidence/fleet; QA audit logs, notification outbox, per-user grants and
bundles, number counters, expired/pending OAuth states, and already-cleaned
cloud registry rows. The explicit child-before-parent order is maintained in
the script. Unclassified new public tables fail closed.

Execution locks the classified tables with a bounded lock wait, then deletes
in one transaction. Protective triggers are restored before commit; any
failure rolls everything back. It verifies empty operational tables,
reference-table counts and the surviving CEO. No `TRUNCATE CASCADE` is used.

The isolated reset test also runs the supported database release command and
checks real CEO login and readiness using the restricted runtime role after
reset. Actual target reset requires its own fresh post-reset checks.

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
