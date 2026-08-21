# E-Set Digital Management System
## Gate Pass — Authoritative Business Specification

Status: **Approved for implementation** (2026-08-22)

This document is the authoritative source for Gate Pass business rules. It
supersedes the placeholder language in `docs/MODULES.md`. Where this document
and code disagree, inspect Git history to determine which is stale and
reconcile via a new `docs/DECISIONS.md` entry — do not silently pick one.

Target: a secure, polished, responsive, installable Gate Pass **product**
suitable for an E-Set management demonstration, built on production-intended
architecture. Not a throwaway prototype — management feedback is expected to
add/remove fields, roles, and rules, so the implementation must absorb that
without a rewrite.

---

## 1. Roles

There is no login account for Driver — Driver is a business entity (name,
phone, license/ID reference) associated with a Gate Pass, not a system user.

| Role | Summary |
|---|---|
| `TEAM_LEAD` | Requests/creates gate passes for their own work, cannot approve |
| `ADMIN` | Full operational control; multiple Admins may exist |
| `SITE_MANAGER` | Site-wide create/approve authority |
| `GATE_GUARD` | Gate-only: verify, exit, return — nothing else |

Management/CEO visibility is a **read-only permission scope**, not a
separate role for now (grant `gate_pass.view_site` + `gate_pass.view_history`
to whichever role needs it later).

### TEAM_LEAD
- Create Gate Pass, save draft, edit own/team draft, submit for approval.
- View own/team Gate Passes and their status/history.
- Cannot approve, reject, or perform Guard exit/return actions.
- Cannot access Gate Passes outside their team scope.

**"Team" scope definition (engineering default, see DECISIONS.md):** team =
same `department_id` as the Team Lead. There is no separate team/hierarchy
table yet. This is intentionally an isolated assumption in the authorization
layer so it can be swapped for a real team-membership model later without
touching the workflow/service code.

### ADMIN
- Create, save/edit draft, submit, approve, reject, cancel (where the
  workflow state permits), view all operational Gate Passes, approval queue,
  history, search/filter.
- An Admin **may approve a Gate Pass they created themselves** — four-eyes
  approval is deliberately not enforced.
- `gate_pass.create` and `gate_pass.approve` remain **distinct permissions**
  internally even though every Admin currently holds both, so a future role
  split (e.g. a non-approving Admin) doesn't require a data model change.

### SITE_MANAGER
- Same operational permissions as Admin for Gate Pass (create, edit draft,
  submit, approve, reject, cancel), site-wide scope, plus management-facing
  audit/history visibility.

### GATE_GUARD
- Receive in-app notification when a pass is approved.
- Scan secure QR (deep link) or use manual search fallback (Gate Pass
  number / vehicle registration / driver name) restricted to
  `APPROVED`/`VEHICLE_OUTSIDE` passes.
- Verify pass (state + identity), record departure odometer + photo, mark
  vehicle exited. Record return odometer + photo, add optional remark,
  complete return.
- Must NOT receive: procurement pricing, inventory quantities, unrelated
  reports, user management, unrelated master data, historical record edit
  access. Backend responses to Guard endpoints are data-minimized at the
  query/serialization level — never rely on the frontend to hide fields.
- A PDF/screenshot is never sufficient authority by itself — system
  verification (current DB state + valid token/search match) is always
  authoritative. The Guard must match the physical driver against the
  authoritative record.

---

## 2. Actors on a Gate Pass record

Three distinct identities are tracked, all separate from the audit trail:

- **Requested By** — free-text/reference to the human/business requester
  (may not be a system user at all, e.g. "Electrical Team Lead").
- **Created By** — the authenticated system user who entered the record
  (`created_by_user_id`, always a real user FK).
- **Approved By** — the authenticated system user who approved it
  (`approved_by_user_id`, nullable until approved).

The audit log separately records every authenticated actor and action
regardless of these three fields.

---

## 3. Gate Pass fields (v1)

Deliberately **excluded for now** (may be added later without redesign):
`Issued By`, `Received By`.

| Field | Notes |
|---|---|
| Gate Pass Number | Server-authoritative, format `ESD-YYYY-NNNNNN`, sequential per year |
| Date | Server timestamp at creation |
| Issuing Department | FK to `departments` |
| Requested By | Free text (business requester, may be non-system) |
| Issued To / Destination | Free text |
| Driver name / phone | Stored as a driver reference on the pass |
| Vehicle Registration | Free text, indexed for Guard search |
| Job Order ID | Optional, free text |
| Purpose | Enum, see below |
| Expected Return Date | Optional date |
| Remarks | Optional free text |
| Items | 1..N rows, relational (see below) — **not** a text blob |
| Created By / Approved By / Approved At | System actor references |
| Verification token | Opaque, generated at approval |

**Purpose enum:** `INTER_DEPARTMENT_TRANSFER`, `REPLACEMENT`, `WARRANTY`,
`REPAIR_RECTIFICATION`, `REJECT`, `SAMPLE`, `SALES`, `RETURNABLE`, `OTHER`.

**Item row:** description, part number (optional), quantity, unit (optional
free text). Modeled as `gate_pass_items` child rows (parent/child, not JSON
blob) so future search/reporting and Inventory integration is possible
without coupling Gate Pass to Inventory now.

---

## 4. Workflow / state machine

```
DRAFT -> PENDING_APPROVAL -> APPROVED -> VEHICLE_OUTSIDE -> COMPLETED
                 |               |
                 v               v
             REJECTED        CANCELLED
      (also DRAFT/APPROVED -> CANCELLED where permitted)
```

- **TEAM_LEAD flow:** create → DRAFT → submit → PENDING_APPROVAL → Admin/Site
  Manager decides (approve/reject).
- **ADMIN / SITE_MANAGER flow:** create → DRAFT (optional save) **or**
  create → approve directly (skips the PENDING_APPROVAL wait since the
  creator already holds approval authority). The `approve` operation accepts
  a source state of `DRAFT` or `PENDING_APPROVAL`.
- **Cancel:** permitted from `DRAFT`, `PENDING_APPROVAL`, or `APPROVED` (before
  exit). Not permitted once `VEHICLE_OUTSIDE` — the vehicle has already left;
  the workflow must be completed via `return`, not short-circuited.
- **Reject:** only from `PENDING_APPROVAL` (or `DRAFT`, symmetrically with
  approve, so an Admin/Site Manager can reject their own or a team draft
  outright).
- Every transition: verifies actor authentication, permission, current DB
  state (row-locked via `SELECT ... FOR UPDATE` inside a transaction),
  validates the transition is legal, validates required fields, writes an
  audit row, and is idempotent against retries/double-clicks (a second
  identical transition attempt fails with a conflict, not a duplicate
  audit/state change).

### Approval side-effects (single transaction)
1. Set `APPROVED`, `approved_by_user_id`, `approved_at`.
2. Generate opaque verification token (crypto-random, not a DB id, no
   sensitive payload).
3. Write audit event.
4. Write a notification-outbox row (Guard in-app notification) and a
   WhatsApp-delivery-outbox row (Driver PDF+QR).
5. Commit.
6. **After** commit: generate the PDF (embeds QR), store via the storage
   abstraction, record file metadata; background outbox processing sends the
   Guard notification and attempts WhatsApp delivery. WhatsApp
   success/failure never invalidates the already-committed approval.

### Exit (Guard)
Requires: departure odometer, departure photo, authenticated Guard, server
timestamp. `APPROVED -> VEHICLE_OUTSIDE`. Duplicate exit attempts rejected
(state check under row lock).

### Return (Guard)
Requires: return odometer, return photo, authenticated Guard, server
timestamp. Only valid from `VEHICLE_OUTSIDE`. Validates
`return_odometer >= departure_odometer`. Server computes
`distance = return_odometer - departure_odometer`. `VEHICLE_OUTSIDE ->
COMPLETED`. Duplicate return attempts rejected.

---

## 5. QR verification

- QR encodes a **deep link URL** (e.g. `https://<app>/guard/verify/<token>`)
  containing an opaque, cryptographically random token — never a raw DB id,
  never sensitive pass data. Any phone camera app can scan and open it; no
  in-app camera-scanning library is required.
- The same QR is presented at both exit and return — the backend decides
  which action is available from current state (`APPROVED` → show Exit,
  `VEHICLE_OUTSIDE` → show Return, anything else → refuse with a clear
  reason).
- Possessing/scanning the token is **not** sufficient authorization by
  itself — the Guard must be authenticated and hold the relevant permission;
  the token only looks up the record.
- Manual fallback search (Gate Pass number / vehicle registration / driver
  name) is restricted to Guard-permitted, state-appropriate, data-minimized
  results.

---

## 6. Evidence photos

Mandatory at both exit and return (departure photo, return photo). Stored
via the storage abstraction (see below), never trusting the client-provided
filename, validated by MIME type and size.

---

## 7. Files / storage architecture

PostgreSQL stores structured data + object **metadata** only
(`storage_key`, `mime_type`, `size_bytes`, `checksum_sha256`, owning entity,
creator, timestamp) — never a permanent public URL as the security model.

A `StorageService` interface abstracts the actual bytes. For this demo, a
local-disk provider implements it (files live outside any static/public web
root; access is only via an authenticated, authorized backend endpoint that
streams the file after checking permission — never a static file mount).
Swapping in an S3-compatible provider later requires no business-logic
changes.

---

## 8. Notifications & WhatsApp delivery

Approval writes an outbox row inside the same transaction as the state
change; delivery (Guard in-app notification, Driver WhatsApp) happens in a
background step **after** commit, so external delivery availability never
gates approval. Delivery state (`PENDING` / `SENT` / `FAILED` /
`SIMULATED`) is tracked per outbox row with retry support.

A `WhatsAppProvider` interface is implemented by a demo/local provider when
real Meta WhatsApp Business Cloud API credentials are not configured. The
demo provider must mark deliveries as `SIMULATED`, never `SENT` — simulated
success must never be presented as if Meta actually delivered the message.

---

## 9. Auditability & immutability

No role — including Admin — gets direct PostgreSQL access; all access is
through the application. Audit log rows are append-only at the application
layer (no `UPDATE`/`DELETE` route exists for them). Once `COMPLETED`, a Gate
Pass's operational history is not silently editable; future corrections use
amendment/correction records rather than mutating history. The approved
PDF/snapshot is versioned, not overwritten in place.

---

## 10. Out of scope for this phase

- Inventory / Procurement / Fleet / Maintenance / HSE / Attendance and other
  future modules (per `docs/MODULES.md`).
- Real WhatsApp Business API credentials (provider interface + demo
  provider only, until credentials are supplied).
- Offline transaction sync (architecture must not preclude it later).
- `Issued By` / `Received By` fields.
- A real team/hierarchy table (department is used as the team-scope proxy).
