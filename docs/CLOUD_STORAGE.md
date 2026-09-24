# Company cloud storage — Phase 1

CMS → Integrations → Cloud Storage supports Dropbox and Google Drive alongside
existing local/Supabase storage. No historical files are migrated, regenerated or
rewritten. Attendance, Permit and deployment changes are outside this checkpoint.

## Deployment setup (operator action required)

Create provider applications in the external consoles. Put secrets directly in
ignored server environment configuration or deployment secret settings, never in
chat, frontend variables, CMS text settings or source control.

Server configuration:

| Variable | Value |
| --- | --- |
| `CLOUD_STORAGE_MASTER_KEY` | Independently generated random 32-byte key, base64 encoded; keep a secure backup |
| `CLOUD_STORAGE_KEY_VERSION` | `1` initially |
| `CLOUD_STORAGE_OAUTH_ORIGIN` | Exact frontend origin, also included in `FRONTEND_ORIGIN`; HTTPS in production |
| `DROPBOX_CLIENT_ID` / `DROPBOX_CLIENT_SECRET` | Dropbox app key / app secret |
| `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` | Google web application OAuth client credentials |

Generate the master key locally with `openssl rand -base64 32` and store its output
directly in the secret configuration. Losing it prevents decrypting existing
connections. Changing the key/version is **not** an automatic rotation mechanism;
existing envelopes must be re-encrypted in a separately reviewed rotation process.
Keep existing `STORAGE_PROVIDER` and Supabase configuration for historical files.
Production still requires the existing private Supabase legacy provider.

For local development with frontend origin `http://localhost:5173`, register:

- Dropbox: `http://localhost:5173/api/v1/cms/cloud-storage/dropbox/callback`
- Google: `http://localhost:5173/api/v1/cms/cloud-storage/google_drive/callback`

For staging, replace the origin with the exact HTTPS frontend origin. The same-origin
frontend proxy must forward `/api/v1`; do not register an arbitrary redirect URL.
Reverse proxies/access logs must omit callback query strings (authorization codes
and state). The application logger records the route pattern, not the query.

### Dropbox console

Create a scoped Dropbox API app with **App Folder** access, not Full Dropbox.
Enable only `account_info.read`, `files.metadata.read`, `files.content.write`, and
`files.content.read`. Register the exact callback above. Use a personal test
account initially. The server requests authorization-code access with offline
refresh tokens and S256 PKCE. The visible `ESDMS` root lives inside the Dropbox
application folder, normally under `Apps/<app name>/ESDMS`.

See [Dropbox OAuth documentation](https://docs.dropboxapi.com/dropbox-api/docs/oauth).

### Google console

Enable the Google Drive API. Configure the OAuth consent screen and add the
personal account as a test user while the application is in testing. Create an
OAuth client of type **Web application**, register the exact callback, and permit
only `https://www.googleapis.com/auth/drive.file`. The server requests offline
access and explicit consent. No broad Drive scope or hidden `appDataFolder` is
used; an ordinary user-visible `ESDMS` folder is created.

See [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
and [Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

## Authorization and secrets

`cms.integrations.view` permits safe status visibility. Independent company-wide
`cms.integrations.manage` controls connect, reconnect, test, activate, disconnect
and failed-upload cleanup. It is seeded only to CEO and reserved against delegated
re-granting; CEO may explicitly assign it. HR, UM and Site Manager titles alone do
not grant access. DENY and existing CEO protections remain authoritative. This
permission does not grant access to business files.

OAuth state is unpredictable, hashed in PostgreSQL, tied to actor/session/provider,
expires after ten minutes, and is consumed before code exchange. Redirects are
fixed server configuration. Dropbox's verifier is encrypted. Tokens are stored
only in authenticated AES-256-GCM envelopes with random nonces, authentication
tags, key version and connection-bound associated data. APIs/audit/logging never
return token material. Application client secrets and the encryption key remain
outside PostgreSQL. Missing crypto with configured application credentials fails
startup; missing/wrong crypto for existing credentials fails storage operations
closed. Provider outages do not affect database readiness.

## Storage and data boundaries

Migration `1787436000000_cloud-storage` is migration **47**, the readiness and
runtime-provisioning expectation. It adds four RLS-protected tables: connections,
active selection, OAuth states and object registry. Explicit runtime grants allow
no connection/object hard deletes and no DDL. Run the existing migration and
runtime-role provisioning release workflow; do not run the API as migration owner.

Business modules retain their authenticated, scoped download endpoints. The
central storage wrapper routes old keys unchanged to legacy storage and opaque
`cloud:<uuid>` references to the recorded connection/account and stable provider
file ID. Registry metadata includes size, SHA-256, MIME type, logical path,
site/entity/namespace and creation time; original filenames/creator remain in
existing business metadata. Downloads verify size and SHA-256 before returning
bytes. No public links, provider tokens or arbitrary file-browser API are exposed.

Connecting does not activate storage. Explicit activation changes future writes
only. Pending file reservations pin connection ownership before network I/O;
selection/connection locks are released before provider calls. Disconnect and
replacement refuse active connections or any non-deleted file dependency.
Same-account reconnect remains available for expired/revoked consent. Account
replacement never silently strands historical files.

Workforce uploads perform network storage before their database transaction and
retain rollback cleanup. Existing Gate Pass and issued-document transactions keep
their established entity locks to preserve lifecycle/version/cancellation semantics;
this checkpoint does not redesign those workflows. Requests have bounded network
calls/retries. Existing upload limits remain; aggregate generated PDFs have a
256 MiB cloud envelope. Existing Buffer-based module interfaces are preserved.
Dropbox uses upload sessions above 8 MiB; Google uses resumable upload sessions.

Failed/uncertain writes stay registered as `cleanup_pending`, never fall back to
another provider, and block disconnect. CMS cleanup retries at most ten failed,
unreferenced files older than one hour, using persisted provider IDs/paths. A
successful remote upload followed by process termination before business commit
can leave a conservative reservation; automatic cleanup does not delete unknown
`pending`/`ready` objects. Such crash recovery requires operator reconciliation.
Revocation failures retain encrypted credentials and a retryable disconnect state;
if the provider already revoked consent but confirmation was lost, operator
reconciliation may be needed. Neither case permits silently dropping references.

Folders are centrally built with deterministic, normalized, bounded ASCII-safe
segments and collision suffixes for changed identifiers:

- `ESDMS/<site>/Gate Pass/<year>/<number>/{Approval,Departure,Return,Additional Evidence,Completion}`
- `ESDMS/<site>/Workforce/<employee code>/{Documents,Profile Photos,Contracts}`
- `ESDMS/<site>/{IPO,Delivery Challan}/<year>/<number>`
- `ESDMS/Company/Branding`

Only currently file-producing modules create folders. No personal names, pricing,
salary, credentials or arbitrary user-authored paths enter folder names.

## Verification and live handoff

Automated provider adapters use controlled test-only HTTP fakes; there is no
production mock mode. Tests cover OAuth ownership/session/replay/expiry/provider
mix-up, encrypted token integrity, permission/DENY, refresh, errors/retries,
large-upload sessions, stable duplicate handling, mixed retrieval, account races,
disconnect safeguards, path sanitization and failed-file cleanup.

The disposable browser test is `backend/test/browser/cloud-storage.test.mjs`.
It exercises real application authentication and CMS UI with simulated provider
consent/responses, three provider-backed Workforce files, denied ordinary/cross-site
retrieval, audit and responsive layouts. It is **not live provider verification**.

Dropbox is the **current intended external storage provider**. It has been
connected and activated in a disposable local environment using a personal test
account. Real OAuth, App Folder creation, a normal Workforce PDF upload,
provider-side file listing, ESDMS download, unauthenticated denial, and site-scope
denial were verified. The connection test passed. The OAuth credentials are
encrypted in PostgreSQL, and status/API/audit/browser/log projections did not
expose secrets. Disconnect was refused both while active and after deactivation
because a referenced Dropbox file remained; Dropbox was reactivated for future
local writes. A different-account replacement was verified by automated tests
and does not require a second personal Dropbox account for this delivery.

Google Drive has an implemented adapter, OAuth flow, CMS controls and
automated/simulated coverage. **Live Google OAuth and provider operations are
deferred**; this checkpoint does not claim live or production verification for
Google. With Google application credentials absent, CMS reports setup incomplete
and disconnected, activation fails closed, and API health/readiness and Dropbox
operations remain healthy.

Connecting an account never migrates historical objects. Changing the active
provider affects **future writes only**: every existing file continues to resolve
through its recorded provider. The disposable test still has one legacy/local
file and one Dropbox file. The personal Dropbox connection and its dependent
file remain in place pending a separate, controlled local-test cleanup after
this checkpoint. The exact database, business records, registry object and
Dropbox object are recorded in a private cleanup manifest outside the repository.
No company data, staging or production provider account was used.

A personal account containing retained ESDMS files cannot be replaced with a
corporate account until those dependencies are reconciled/migrated in a future
checkpoint. No historical migration or production connection is authorized here.

### Final automated results (2026-09-24)

- Full backend: **885/885 passed**, zero failed/cancelled/skipped, on an isolated
  SCRAM-authenticated PostgreSQL instance; hostile-password and runtime privilege
  checks passed. The disposable cluster was stopped and removed afterwards.
- Focused cloud suite: **9/9 passed**, including upload-session and account-race tests.
- Frontend: **393/393 passed**; affected panel tests passed after the final effect
  correction. ESLint and production build passed (existing bundle-size advisory).
- Final disposable browser run: **1/1 passed**, simulated OAuth/provider APIs,
  actual application sessions, mixed-file authorization and responsive UI.
- `git diff --check` passed; no generated artifacts or real secrets added.
- Dropbox live verification subsequently passed on disposable local data:
  real OAuth, encrypted token storage, App Folder creation, one PDF upload and
  authorized download, legacy download, negative authorization/site checks,
  connection test, audit and disconnect refusal. The local Dropbox connection
  remains active for future test writes; no cleanup or deployment occurred.
- Google credentials are absent. Live Google verification is deferred; simulated
  provider and OAuth tests passed. Readiness stays healthy and Google cannot be
  selected while setup is incomplete.
