# Multipart security checkpoint

Baseline: d2eb7c3. Multer is pinned to **2.4.0**, replacing 2.2.0.
The September advisory also affects 2.3.0; upgrading only to that release is
insufficient. See [2.4.0 release notes](https://github.com/expressjs/multer/releases/tag/v2.4.0)
and [September advisory](https://github.com/expressjs/multer/security/advisories/GHSA-3pph-fpjx-jg34).
The September disk-storage race does not match ESDMS memory storage, but the
August field-parser vulnerabilities did affect the installed parser.

## Upload contracts

All paths below are under `/api/v1`. Every upload requires authentication.
All five Multer instances use memory storage and synchronous MIME filters;
none has destination/filename callbacks. Business authorization and scope remain
server-enforced. Workforce self-service routes check ownership/type permission
in services after parsing; they do not grant arbitrary upload authority.

| Routes | Authorization | Files / bytes per file | Text fields / parts / name bytes / value bytes |
|---|---|---|---|
| POST `/employees/:id/documents`, `/me/documents` | Changed password; self/type upload permission or scoped document management | 1 / 10 MiB | 2 / 3 / 14 / 37 |
| POST `/employees/:id/contracts/:contractId/file`, `/me/contracts/:contractId/file` | Changed password; scoped draft contract edit | 1 / 10 MiB | Shared document handler: 2 / 3 / 14 / 37 |
| POST `/employees/:id/profile/photo`, `/me/profile/photo` | Changed password; self edit or scoped employee update | 1 / 5 MiB | 0 / 1 / 5 / 0 |
| POST `/employees/import/preview`, `/employees/import/confirm` | Changed password; employees.bulk_import | 1 / 2 MiB | 2 / 3 / 17 / 512 |
| PUT `/cms/branding/logo` | cms.branding.manage, changed password | 1 / 2 MiB | 1 / 2 / 8 / 11 |
| POST `/gate-passes/:id/exit`, `/return`, `/evidence` | Corresponding exit/return capability, changed password, scoped lifecycle checks | 10 / 5 MiB | 2 / 12 / 8 / 2000 |

Documents accept PDF/JPEG/PNG/WebP, check signatures and the configured document
type allowlist; contracts narrow to PDF. Profile/Gate photos accept JPEG/PNG/
WebP with signature validation. Logos accept PNG/JPEG with full decoding, declared-type and dimension
checks, and are stored as a canonical re-encoding. Imports accept XLSX MIME plus ZIP signature and workbook validation.

Limits follow current forms: documentTypeId/expiryDate; no profile text;
confirmationToken/confirmWarnings; logo revision; odometer/remarks or kind/note.
Gate remarks allow 500 characters, so 2000 bytes accommodates UTF-8. Import
preview tokens fit within 512 bytes. UUID/revision ceilings reserve one byte
because Busboy considers fieldSize an exclusive boundary. Existing file limits
are unchanged. All handlers set fieldNestingDepth=0 and fieldArrayIndexLimit=0;
repeated photo parts remain supported without nested text fields.

Truncated/malformed multipart parser errors become controlled 400 responses.
Other IO errors retain existing centralized handling. The 2.4.0 inclusive file/
part-limit behavior is compatible; memory storage needs no custom streamHandler.
Only Multer and removal of its unused transitive packages changed in the lockfile.

## Verification

- Focused tests: **74/74 passed**, including real Workforce document, Gate
  evidence, logo, profile, import and contract workflows on local test storage.
- Isolated child-process regression attacks every upload route with crafted
  indices/nesting, excessive fields/names/values/files, oversized files,
  truncated multipart and an aborted upload. Controlled 400/413, continued
  health, unchanged DB file/branding metadata, zero storage-save/provider calls,
  no files left behind, and no stack/secret reflection were asserted.
- Full backend on isolated SCRAM PostgreSQL: **890/890 passed**, zero failures,
  skips or environment blocks; release/readiness/security contract remains 47.
- `npm ci` succeeded. Syntax checks and `git diff --check` passed. Backend has
  no lint/build script. Frontend files and its independent lockfile are unchanged;
  previous 397 tests, lint and build remain applicable and were not rerun.
- No personal Dropbox operations, deployment, migration or business-rule changes.

## Remaining dependency advisories

Audit is **not clean**. Multer has no remaining reported advisory.

| Package | Installed | Severity / relationship | Exposure and status |
|---|---|---|---|
| qs | 6.15.3 | Moderate; transitive through Express/body-parser | Application uses default simple query parsing and no URL-encoded body parser; no reachable application exploit established. Two advisories remain; not updated in this focused checkpoint. |
| fast-uri | 3.1.5 | High; frontend build transitive through Workbox/Ajv | Build tooling, not ESDMS runtime outbound URL handling; no runtime SSRF established. Four advisories remain; not updated. |

## Read-only environment discovery

Case-insensitive lookup for `Faseehuddin@eset.pk` returned no account in local
`eset_dev`, `eset_test`, or disposable `esdms_cloud_live_1192f50b`. No account
was created, logged into, or modified. Thus no linked employee/CEO scope can be
reported for those environments. Local configuration contains only local DB
credentials; no external Render/Supabase management credentials were found there.

The repository explicitly labels `esdms-api-staging` and `esdms-app-staging`
as Render staging, with separately provisioned Supabase infrastructure and
same-origin API proxy. Their public readiness endpoints returned 200 with
**42 migrations**, latest `1787431000000_driver-identifier-normalization`.
That does not identify a company target or expose a CEO lookup. No authenticated
staging action was attempted, and no Supabase project mapping is recorded.

The newly available Supabase connector listed two projects: an active project
explicitly named **E-set Digital permit System** and an inactive project named
**shaheer-cloud123's Project**. Neither is positively mapped to ESDMS. No SQL,
resume, schema inspection or other project operation was performed: Permit is
out of scope and an unrelated project must not be guessed to be the target.

**No candidate handover environment identified.** Required next information:
the ESDMS Supabase project reference (distinct from Permit), or the authorized
company environment/configuration location. Supply secrets directly to approved
configuration, never chat. Then perform the requested read-only CEO and target
inventory. The disposable personal Dropbox connection remains separate,
connected and untouched; no tokens or records were copied.

Destructive reset: **NOT EXECUTED**.
