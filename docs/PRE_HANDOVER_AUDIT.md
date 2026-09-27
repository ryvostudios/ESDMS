# Pre-handover audit and reset preparation

Review baseline: `main`, `5a7321b` (47 migrations, latest and provisioning
contract `1787436000000_cloud-storage`). No application business code,
migrations, grants, RLS policies or provider connections changed in this review.

## Execution status and target blocker

**NOT EXECUTED — awaiting explicit human approval.**

The human identified `Faseehuddin@eset.pk` as the permanent CEO. That account
was absent from both inspected local databases: the running disposable
`esdms_cloud_live_1192f50b` at `127.0.0.1:50319` and the separately inspected
`eset_dev` at local port 5432. Neither is therefore approved as a handover reset
target. No substitute CEO was created or selected. Target identity must be
resolved before an execution proposal can be approved.

The running cloud-live API uses `esdms_runtime`, with no migration credentials
in its process environment. Health/readiness both returned 200, all 47
migrations matched, and all runtime attribute/membership/schema/table/sequence/
function/RLS/ownership/provisioning checks were healthy. Legacy storage is
local; Dropbox is connected and active; Google remains disconnected. This is
local disposable QA, not staging or production.

## Material security finding

Update: the Multer blocker was subsequently remediated to 2.4.0 with explicit
multipart limits and full regression. See [MULTIPART_SECURITY.md](MULTIPART_SECURITY.md).
The findings below describe the original audit baseline.

Dependency audit found backend Multer 2.2.0 (high) and qs 6.15.3 (moderate),
and frontend build dependency fast-uri 3.1.5 (high).

Multer is a release blocker: upload routes use the affected parser after
application authentication/permission checks. The upstream
[crafted-field advisory](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm)
identifies an uncaught process-terminating error, fixed in 2.3.0. An isolated,
resource-bounded dependency probe reproduced `RangeError: Invalid array length`.
No probe was sent to the running API. Authentication limits who can reach
these upload routes; it does not repair the parser. This audit did not change
dependencies, because the authorized implementation change was the reset tool.

The disk-storage-specific Multer advisory does not match the application's
memory storage, and its asynchronous-filter advisory does not match the
synchronous filters. These distinctions do not remove the crafted-field issue.
Express uses its default simple query parser and this application does not
install URL-encoded body parsing: no application exploit of the qs advisories
was established. fast-uri is under Workbox/Ajv build tooling, not application
server-side outbound URL validation; no runtime SSRF was established. Record
and remediate the dependency findings without claiming all audit entries are
reachable application vulnerabilities.

## Security evidence

Direct review covered authentication/session revocation and cookies, effective
permission/DENY calculation, locked governance ceilings, scoped file access,
CMS validation/audit projection, OAuth state/account replacement, authenticated
token encryption, provider routing and database readiness. The forced-password
frontend transition remains intact. File authorization precedes provider reads.
API responses use safe projections rather than stored credentials/raw audit
payloads. Business modules and document-generation code were not changed.

Known deployment/token secrets were compared in memory against tracked files,
local API/frontend/release/seed logs and governance audit metadata: no matches.
Git history was also checked against known deployment secrets, with no matches.
Stored Dropbox credentials were authenticated-decrypted in memory and verified
not to contain plaintext tokens. Secret values were not printed or saved.
This is scoped evidence, not a claim that historical unknown credentials can
be exhaustively detected. Only `.env.example` files are tracked.

The automated regression covers auth/governance/scope, DB privilege/readiness,
CMS/content/audit, mixed storage/OAuth, document branding/history and pricing,
Material/Demand/Procurement/IPO/receiving/DC, Gate/Fleet, Workforce and outbox
invariants. Existing manual QA was accepted; unrelated browser QA was not
repeated. Google live OAuth remains deferred.

## Provisional disposable QA inventory

Inventory only, **not approval to preserve the fixture CEO**. The private,
Git-ignored `tmp/reset-preparation/cloud-live-inventory.json` contains complete
per-table counts, business record IDs/storage keys and cloud registry/provider
IDs/paths. It was rebuilt from the database; the referenced scratchpad cleanup
file was not present. Regenerate and compare immediately before any approved
cleanup; do not rely on old manifests alone.

| Category | Rows |
|---|---:|
| QA users / employees / employment assignments | 15 / 3 / 3 |
| Company items / department catalog links | 2 / 2 |
| Demands / lines / pricing headers / pricing lines | 2 / 4 / 2 / 4 |
| Demand approvals / audit | 8 / 25 |
| IPOs / lines / purchase events | 2 / 4 / 2 |
| Receipts / receipt lines | 2 / 2 |
| Delivery Challans / lines | 2 / 2 |
| Stored procurement documents | 4 |
| Gate Passes / items / files / audit | 4 / 2 / 9 / 15 |
| Workforce documents / business history | 2 / 11 |
| Governance / procurement audit | 53 / 23 |
| Notification outbox | 60 |
| User bundle assignments / overrides | 2 / 3 |
| Demand / Gate / document counter rows | 1 / 1 / 2 |
| Drivers, vehicles, contracts, compensation, leave, rotations | 0 |
| Cloud objects: files / folders / OAuth states | 14 / 27 / 0 |

System/reference inventory: 8 roles, 101 permissions, 213 role grants,
2 bundles with 10 memberships, 10 units, 2 document settings, 9 CMS settings,
47 migration rows, 2 provider definitions and one active-selector row.
Organization currently has 2 sites, 10 departments and 17 positions. The 17
position codes match the company reference set. A proposed company structure
would preserve MAIN, the six company departments and those 17 positions, and
remove TEST-SECONDARY plus Electrical, Mechanical, Warehouse and Test Secondary
Dept only after operational dependencies are cleared. This is **not** an
approved preserve/removal list for an identified handover target.
One document type is the cloud verification fixture. Review exact IDs against
company reference requirements; do not retain these QA-only rows by default.
The approved six company departments, real positions, permanent site and
workforce configuration must survive. The tool now preserves configuration
rather than guessing which rows are QA; approved reference pruning remains a
separate explicitly reviewed operation.

## Backup, storage and reset order — proposal only

1. Resolve target and permanent CEO. Approve exact reference/configuration
   preserve/removal IDs and audit-retention policy. The tool clears QA audit;
   this is inappropriate for mixed company/QA data without a different policy.
2. Stop API/writers/outbox. Take a fresh owner `pg_dump` custom-format backup
   using private connection configuration, with restrictive filesystem access.
   Retain the provisioning version, server role configuration and encrypted
   secret configuration separately in approved secure storage. Never commit
   dumps, tokens or master keys. Back up exact local/provider file bytes and
   their IDs, paths, sizes and hashes. A database dump alone cannot restore
   externally deleted content.
3. Restore the backup into isolated PostgreSQL; re-provision runtime access,
   verify CEO authentication, 47 migrations, readiness, FKs and file hashes.
   Only then attest backup verification. The current disposable rehearsal uses
   synthetic fixtures and is not a restore verification of the eventual target.
4. Regenerate/freeze the database-derived manifest. Explicitly select legacy
   for future writes. Keep the personal connection until cleanup is verified.
   Preserve the approved E-Set logo: this QA instance has an uploaded legacy
   logo reference separate from the 15 business file records. Do not delete it
   unless restoring the approved bundled E-Set logo is explicitly chosen.
5. Delete **only** approved QA provider file IDs, verifying account identity,
   ownership, metadata and successful removal. Current Dropbox inventory is
   9 Gate files, 2 IPO PDFs, 2 Delivery Challan PDFs and 1 employee document;
   each has exactly one business owner and every registry file is ready.
   There are no unreferenced registry files. Delete folders deepest-first only
   after listing proves they are empty; never recursively delete `ESDMS` or
   another folder that might contain unrelated personal content. Unknown
   children stop cleanup. Mark registry deletion only after provider success;
   retain failed entries and connection credentials for retry/recovery.
6. Back up/remove the one referenced legacy employee-document object, retaining
   approved branding. The filesystem contains exactly these two referenced files (document and
   logo), with no missing references or orphan files. No Supabase objects are
   referenced by this local QA environment. A different target needs its own provider inventory/workflow.
7. With no dependent files, use CMS to disconnect/revoke personal Dropbox.
   Verify encrypted credentials are removed and legacy remains active. Do not
   silently erase credentials without confirmed revocation. Google stays off.
8. Only after storage reconciliation, explicit approval and backup checks run
   the database reset. It removes operational children before parents, then
   other users, while preserving company/security/configuration tables.
   It refuses active providers, retained credentials, undeleted registry rows,
   existing legacy files and unknown tables. It does not implement remote
   provider cleanup, and must not be bypassed to simulate cleanup success.
9. Verify exactly the approved CEO, no QA operational rows, approved company
   references, no orphan file references/FKs, CMS access, login and readiness.
   Reconcile storage before reopening writes. Connect corporate Dropbox later
   through CMS, never by reusing personal credentials.

Database failure rolls back the database transaction and trigger state.
Provider deletions/revocation do not roll back. On any failure keep maintenance
mode, preserve the manifest and retry only confirmed remaining objects. If
rollback is needed, restore DB and bytes together and reconcile provider IDs;
restoring an old encrypted token does not undo OAuth revocation. Keep backups
until the complete post-reset verification is accepted.

## Reset-tool changes and verification

Added explicit read-only dry run; current table classification; local target,
backup and storage guards; preserved organization/CMS configuration; bounded
maintenance locks; refusal to erase individual CEO grants/DENYs/bundles; cleanup of obsolete OAuth/deleted registry rows only after
storage guards; safe clearing of removed-user updater references. No migration
or application permission changes.

Focused reset tests: 7 passed, including refusal/no-mutation, unknown-table and
cloud-dependency guards, reference/CEO preservation, restored triggers,
repeatability, supported release verification, restricted-runtime CMS access and CEO login
(200), invalid login (401), and readiness (200, 47 migrations). These run only
on a separate synthetic disposable database, never personal Dropbox.

Final backend regression on isolated SCRAM PostgreSQL: **889/889 passed**,
0 failures, 0 skipped, 0 environment-blocked. Reset-specific coverage was also
rerun after additional filesystem/CMS assertions: **7/7 passed**. Frontend:
**397/397 passed**; lint and production build passed (existing bundle-size
advisory only). `git diff --check` passed. No application source changed.
