# System Administration foundation

`/cms` integrates existing Organization, Governance and Workforce configuration.
Old `/governance` and `/workforce/config` bookmarks remain supported. Employee
records remain under Workforce. Sites are read-only here: site provisioning and
lifecycle remain release-managed. Department/position archive safeguards and
multi-site behavior are unchanged.

## Authority

CMS has no umbrella permission or bypass. Navigation and `/api/v1/cms` list only
areas for which the actor holds an effective permission. Every area API enforces
its own capability; existing APIs retain their own checks.

| Area | Authority |
| --- | --- |
| Organization | `departments.manage` / `positions.manage` |
| Users & Access | `users.view`; existing action-specific governance capabilities |
| Workforce Configuration | Existing configuration, employment type, rotation or leave management capability |
| Permission Catalog | `cms.permissions.view` or `cms.permissions.manage`; editing requires manage |
| Branding | `cms.branding.manage` |
| Application Content | `cms.content.manage` |
| Integrations | `cms.integrations.view` |
| Audit Center | `cms.audit.view` |
| System | `cms.system.view` |

Only CEO receives the seven new capabilities by default. Site Manager, selected
UM and HR retain existing permissions; extra access requires explicit assignment
through existing governance. Delegation ceilings, permanent CEO protection,
explicit DENY and existing scope checks remain authoritative. Branding/content
and permission metadata are explicitly **company-wide** capabilities; assign them
accordingly. No position or department grants authority.

## Configuration and public text

Permission codes and enforcement remain application-controlled. The existing
`permissions` table now holds display name, category and help text alongside its
existing description. The CMS edits metadata only; no creation/rename API exists.

`cms_settings` contains seeded, allowlisted keys. Company name, short name,
contact details and document issuer name form the branding text (plus the
managed logo reference, see Document branding). Sign-in heading/help,
announcement and support text form application content. Each has server-side
length/type validation, labels and descriptions. Markup/control characters and
unknown keys are rejected. React renders values as text. Edits require the current
revision, preventing stale updates, and audit in the same transaction.

All plain-text values are deliberately public; the logo reference is not. `/api/v1/cms/public-content` is the sole
unauthenticated CMS endpoint and returns only these values with no-store headers.
Do not put confidential company announcements, credentials or employee data here.
Sign-in consumes company labels and login text; the application shell consumes
announcement/support text. Fetch failures retain safe defaults and never block
authentication. New text appears on a fresh page load.

## Document branding

Migration `1787435000000_cms-document-branding` extends the same allowlist
(no new table, no new grants) with two branding keys:

- `document.company_name` — issuer name printed on newly generated documents
  (default `E-Set Engineering Services`). Public plain text like the others.
- `company.logo` — managed only by the logo endpoints below; the generic
  setting PATCH refuses it. `''` means the bundled default logo. Otherwise it
  holds a server-written reference (storage key, SHA-256, type, dimensions)
  that is never returned to clients or written to audit.

`company.contact_details` is now printed as a small line under the issuer name.

**Logo source.** The default is the real E-Set logo
(`eset-logo-header.png`, 1200×630 RGBA) with only its fully transparent margin
trimmed (pixels, colours and proportions untouched), bundled at
`backend/assets/branding/eset-logo.png` (353×402). Runtime code never reads a
developer Desktop path.

**Logo management** (`cms.branding.manage`, server-enforced; explicit DENY wins):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/cms/branding/logo` | Public read of the active logo (sign-in needs it). Served only as its validated `image/png`/`image/jpeg`, `nosniff`, ETag. |
| `PUT /api/v1/cms/branding/logo` | Multipart `logo` + `revision`. PNG/JPEG only, ≤ 2 MB, 32–4096 px. The declared type is re-checked against the bytes, PNG pixel data is fully inflated and the image is parsed as the PDF renderer will parse it. SVG and anything else is rejected. The client filename is ignored; bytes go through the existing storage service under a server-generated key. |
| `DELETE /api/v1/cms/branding/logo` | `{ revision }` — restore the bundled default. |

Every change requires the current revision and writes `CMS_SETTING_CHANGED`
in the same transaction with a safe description only (for example
`Uploaded PNG 353×402, 149 KB, sha256 1a2b3c4d5e6f`) — never bytes, base64,
storage keys or URLs. Superseded logo files are kept as configuration history.

**Documents.** `backend/src/shared/documents/branding.js` is the single source
of issuer identity: logo (aspect ratio preserved, max 120×46 pt), issuer name,
document title and optional contact line. It is used by the Gate Pass
approval and completion PDFs, IPO, Delivery Challan and Demand List. Each
document keeps its existing projected data; branding adds no fields.

**Historical documents.**

- Gate Pass (approval, completion), IPO and Delivery Challan PDFs are rendered
  once, persisted, and thereafter served as the stored bytes. A later branding
  change never alters an issued document; only newly generated ones use it.
- The Demand List PDF has never been persisted: it is regenerated from live
  Demand data on every download, so it also uses the current branding. This is
  deliberate — it is a working request list, not an issued document — and no
  Demand schema or logic was changed for branding.

**Fallback.** Branding never blocks a document. If settings cannot be read,
defaults are used. If a configured uploaded logo is missing or fails its
checksum, the document shows text identity only and the public logo endpoint
returns 404 — a different logo is never substituted.

## Audit and system information

Audit Center reads the existing append-only governance audit. It includes its
recorded workforce/security/governance events and new configuration events.
Department, position, employment type, profile/custom-field/document type,
rotation-policy and leave-type writes now audit atomically without changing their
validation or lifecycle semantics. Snapshots allowlist reference fields, excluding
notification destinations and arbitrary payloads.

A database trigger captures the event's site at insertion. Historical rows without
a captured site are not backfilled from mutable current assignments. CEO can view
all rows; delegates only see an allowlisted set of event types at their assigned
site. Neither `workforce.all_sites` nor price permissions expand audit scope.
Company-wide configuration events and unscoped historical events remain CEO-only.
Permission checks still apply to CEO. Changes to current user/site assignments do
not relocate old events.

Responses never return raw metadata, compensation, contract data or prices. Only
allowlisted public text changes expose before/after values. Pagination is bounded,
ordered by timestamp and ID, with action/actor/site/time filters. Operational
workflow histories remain in their modules; this is not an invented universal
activity feed or a new logging system.

System status projects revision/environment, migration/provisioning versions and
readiness booleans. It never exposes connection strings, credentials, database
role details, environment dumps or underlying query errors. Integrations show
honest unimplemented/provider-selected status, not verified connectivity.

No provider connection or credential storage exists in this foundation. Future
Dropbox/Google Drive work requires OAuth and encrypted server-side credential
storage with externally managed keys, revocation, masked metadata and audited
replacement. Attendance design waits for its codebase. Do not repurpose public
text settings as a credential store.

## Release and verification

Migration `1787434000000_cms-foundation` is migration 45 and the new runtime
provisioning expectation. It is forward-only to preserve published configuration
and audit history. Use the existing database release command: migrate, provision,
verify privileges/RLS and readiness before serving. Runtime receives SELECT/UPDATE
on seeded settings, no INSERT/DELETE. New metadata columns and the audit scope
trigger are load-bearing readiness checks. No staging or production change is
performed by this checkpoint.

Focused backend: `npm test -- --test-reporter=spec test/cms.test.js` (backend).
Frontend: `npm test` plus lint/build (frontend). Broader backend DB/auth regression
uses the supported disposable test runner; password-boundary tests require a
local PostgreSQL server enforcing password authentication rather than trust.

Real-browser test, from backend:

```sh
FRONTEND_ORIGIN=http://localhost:5179 npm test -- --test-reporter=spec test/browser/cms-foundation.test.mjs
```

It creates a disposable database and authenticates actual CEO/HR/UM/Site Manager/
ordinary accounts, runs local Vite and headless Chrome, and verifies content usage,
audit, API denials and desktop/tablet/mobile layout. `CHROME_BINARY` can override
the macOS Chrome default. Screenshots go to the operating-system temporary folder.
No login bypass or persistent company account is used.

### Verification coverage

Audit date ranges compare parsed instants, so timestamps with different fractional
second precision are accepted or rejected in chronological order. The CMS API
tests cover ascending, descending and equivalent instants.

The database privilege and readiness tests include `cms_settings` with exactly
SELECT/UPDATE access. The privilege integration test also exercises a settings
update and the audit scope trigger through the restricted runtime connection,
rolling both writes back. Run these with:

```sh
npm test -- --test-reporter=spec test/db-privilege-boundary.test.js test/readiness-serving-contract.test.js
```

The password-authentication assertions require an isolated local PostgreSQL
instance using SCRAM authentication; a trust-authenticated local server cannot
prove rejection of an incorrect password.

Final checkpoint verification (2026-09-24): the complete backend suite passed
**871/871 tests**, with zero failures, skips, cancellations or environment-blocked
tests, on an isolated local SCRAM-authenticated PostgreSQL instance using the
repository's disposable-database runner. This includes CMS, governance, runtime
privileges, readiness, authentication and protected business-module regressions.
The disposable database and PostgreSQL instance were removed after verification.

Frontend code is unchanged since its successful **388-test**, lint and production
build runs. Real Chrome verification also passed for CEO/HR/UM/Site Manager/
ordinary-user access, content consumption, scoped audit and 1440/768/390-pixel
layouts. Those results remain applicable to the final tree. The production build
reports a non-blocking bundle-size advisory for its main JavaScript chunk.
No staging or production migration, provisioning or deployment was performed.
