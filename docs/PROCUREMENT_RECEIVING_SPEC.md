# E-Set Digital Management System
## Procurement & Material Receiving V1 — Authoritative Business Specification

Status: **Approved for implementation** (2026-08-25)

This document is the authoritative source for Procurement & Material
Receiving V1 business rules. It supersedes the placeholder language in
`docs/MODULES.md` §4 (Inventory), §5 (Procurement), and §6 (Material
Receiving) for everything within this V1's scope. Where this document and
code disagree, inspect Git history to determine which is stale and
reconcile via a new `docs/DECISIONS.md` entry — do not silently pick one.
See `docs/DECISIONS.md`'s "V1 Scope Narrowed to Procurement & Material
Receiving" entry for why this scope was chosen over the full Inventory
design explored in Phase I.

**This is not the Inventory module.** No stock balance, stock ledger,
FIFO/batch consumption, Material Issue, usage, return, adjustment,
transfer, or warehouse/bin management exists in this V1 — see §24. Full
Inventory is a distinct, later project phase.

---

## 0. Implementation Status

| Checkpoint | Scope | Status |
|---|---|---|
| 1 | Material Catalog Foundation (Company Item, Department Material Catalog, Units of Measure) | **Implemented** |
| 2 | Demand List + department item picker + submit | **Implemented** (revisions/reopen deferred — see §7, §14) |
| 3 | Initial UM/CFO review + notification routing | Not started |
| 4 | Procurement pricing + financial visibility | Not started |
| 5 | Final approval + automatic IPO generation + numbering | Not started |
| 6 | Purchase progress + Delivery Challan | Not started |
| 7 | Department receiving + Admin fallback custody/handover + Team Lead closure | Not started |
| 8 | End-to-end regression + reporting/history + beta polish | Not started |

Only §2-§9 (Material Catalog, Demand List, Draft editing, Submission) and
§25-§27, §29, §31-§32 (data model, authorization, isolation tests,
notification, security, frontend — the implemented portions) describe
implemented, working behavior today. Everything from §9's "First
Management Review" onward describes checkpoints 3-8, not yet built.
Everything from §6 onward (Demand through Closure) is the **authoritative
target design** for checkpoints 2-8, not yet built — treat it as binding
for future implementation, not as a description of current code.

---

## 1. Business Ownership Principle

Every department owns its own material workflow (Civil owns Civil demands
and receiving, WTG owns WTG's, E-BOP owns E-BOP's, Admin owns Admin's —
Kitchen may remain under Admin per current business policy). Admin is
**not** the universal material approver or issuer; a department does not
require Admin approval to receive or use its own material.

Department separation is enforced server-side. A department-scoped user
cannot browse or modify another department's Demand Lists, department
material catalog, receiving records, workflow tasks, or history, unless
their ESDMS capabilities explicitly grant broader access (an
`*.all_departments`-style capability — see §26). Frontend hiding alone is
never sufficient.

**Implemented today (Checkpoint 1):** `material_catalog.view` /
`material_catalog.manage` are department-scoped by default;
`material_catalog.all_departments` is the explicit broad-visibility
override. See `backend/src/modules/material-catalog/material-catalog.authorization.js`.

---

## 2. Company Item + Department Material Catalog — **Implemented**

Two-tier model so Demand creation is fast and future Inventory can treat
the same physical material consistently across departments:

- **Company Item** — the physical/material identity (e.g. Cement, WD-40,
  Transformer Oil, Bearing XYZ, PVC Pipe 4"). Global, not site- or
  department-scoped. Table: `company_items`.
- **Department Material Catalog** — a department-specific, reusable list
  referencing Company Items, each entry carrying that department's own
  default Unit of Measure. A Company Item may belong to more than one
  department's catalog without duplicating the physical identity. Table:
  `department_material_catalog`, unique on `(department_id, company_item_id)`.

```text
Company Item: WD-40
        │
        ├── Civil Department Catalog
        │
        └── WTG Department Catalog
```

---

## 3. Demand Creation UX — target design (Checkpoint 2)

When an authorized department user creates a Demand List, the department's
saved material catalog (§2) is shown with checkboxes and quantity fields:

```text
NEW DEMAND — CIVIL

[✓] Cement             [ 50 ] Bags
[ ] Binding Wire       [    ] Kg
[✓] Paint              [ 40 ] Litres
[ ] PVC Pipe 4"        [    ] Lengths

+ Add Material
```

Only checked items become Demand List lines. The catalog list supports
search/filter (§2's implemented search endpoint is designed to serve this
UI directly once Checkpoint 2 begins).

---

## 4. Adding New Material — **Implemented**

An authorized department user (holding `material_catalog.manage`) may add
a new material while building their catalog: search existing Company
Items and the department catalog first (`GET
/material-catalog/company-items/search`, annotates whether each match is
already in the caller's department catalog) to discourage — not hard-block
— accidental duplicates, matching the existing Employee
duplicate-detection convention. If genuinely new, the minimal Company Item
is created and linked to the department's catalog in one request (`POST
/material-catalog`), immediately selectable — no separate administration
workflow required. Organizational Position never grants this authority;
only the `material_catalog.manage` capability does.

---

## 5. Unit of Measure — **Implemented (seeded set, no admin UI yet)**

V1 keeps UOM simple: each Department Material Catalog entry carries one
default UOM (Bags, Litres, Kilograms, Metres, Pieces, Boxes, Rolls, Sets,
Gallons, Tons — seeded by the Checkpoint 1 migration). The Demand creator
normally enters only a quantity against the catalog entry's default unit.
No UOM conversion engine exists; the schema does not preclude adding one
later. A UOM management UI (create/edit beyond the seeded set) was
deliberately not built in Checkpoint 1 — add it if the seeded set proves
insufficient (see the Checkpoint 1 report).

---

## 6. Authoritative V1 Workflow — target design (Checkpoints 2-8)

Implemented as separate, auditable state machines (§30), not one giant
cross-domain status field:

```text
DEPARTMENT DEMAND
        ↓
FIRST UM / CFO REVIEW
        ↓
PROCUREMENT PRICING
        ↓
FINAL UM / CFO APPROVAL
        ↓
IPO AUTO-GENERATED
        ↓
PROCUREMENT PURCHASE
        ↓
DELIVERY CHALLAN
        ↓
MATERIAL RECEIVING
        ↓
DEPARTMENT CONFIRMATION
        ↓
CLOSED / HISTORY
```

---

## 7. Stage A — Demand List — **Implemented (Checkpoint 2)**

Department user creates a Draft Demand: department, site, creator, a
system-generated Demand number (`DL-YYYY-NNNNNN`, sequential per year —
same year-keyed counter pattern as Gate Pass's `ESD-YYYY-NNNNNN`, see
`backend/src/modules/material-demand/material-demand.repository.js`),
revision (reserved integer column, always `1` in this checkpoint —
revision/reopen is Checkpoint 3+ work, see §14), selected material lines
with requested quantities and the catalog entry's default UOM, an optional
note/justification, and timestamps. A Draft may have zero lines while it's
being built — "at least one line" is a submit-time check, not a save-time
one (§9). Draft is editable by the authorized creator or an
all-departments actor while `status = DRAFT` (§8 Draft Editing).

**Historical/snapshot strategy** (the task's required historical-design
answer): a Demand line stores a snapshot of the item name and UOM at
creation time (`item_name_snapshot`, `uom_code_snapshot`,
`uom_name_snapshot`) alongside a live FK (`catalog_entry_id`) to the
Department Material Catalog entry. Display always prefers the snapshot —
a later Company Item rename or catalog archive can never change what an
old Demand appears to have asked for. Only name and UOM are snapshotted
(the two fields a line actually displays); nothing else is duplicated.
Line-to-catalog-entry ownership (a line must belong to the exact same
department as its parent Demand) is additionally pinned by a composite FK,
the same pattern `db-relational-coherence.js` established for
`gate_pass_files`.

On submit: `DRAFT` → `PENDING_INITIAL_REVIEW`, and the first workflow
notification fires within the same committed transaction (§10, §29).

---

## 8. Notification — Demand Submitted (Checkpoint 3)

Notifies authorized Upper Management reviewers, CFO, and any other
explicitly configured management participant per current governance
(§26), deep-linked to the exact Demand record, plus a Pending Actions
surface if the existing architecture supports it. Built on the existing
notification/outbox infrastructure (`src/shared/notifications/`) — no
second notification framework, and no new push provider unless one is
already integrated and separately authorized.

---

## 9. First Management Review (Checkpoint 3)

The need/quantity review before Procurement spends time pricing it.
Authorized UM/CFO users may review requested materials, modify quantities
where the approved business rule permits, remove/reject items,
approve/reject the Demand, and record auditable comments/reasons where
required. Not every UM account individually approves — the required
review path is determined by capability (§26), and approvals are recorded
as real workflow actions with history, not a status change alone. Once the
required UM-level and CFO approvals are satisfied: `Demand → READY_FOR_PRICING`,
and Procurement is notified automatically (§10).

---

## 10. Notification — Ready for Pricing (Checkpoint 3)

Procurement is notified and the Demand appears in Procurement's pending
work. Only authorized Procurement users see pricing fields (§16).

---

## 11. Procurement Pricing (Checkpoint 4)

Procurement enters, for every active Demand line: exact estimated market
price per unit, and sourcing/purchasing notes where required. Previous
purchase price (once historical data exists), estimated market price, and
later actual purchase price are preserved separately — never silently
overwritten by one another. Frontend-calculated totals are never trusted;
monetary totals are recomputed server-side using safe decimal/numeric
handling. A Demand is not ready for final approval until all required
pricing is complete. Submitting pricing sets `PRICING_COMPLETE` /
`PENDING_FINAL_APPROVAL` and notifies UM + CFO again (§12).

---

## 12. Notification — Pricing Complete (Checkpoint 4)

UM and CFO see requested/approved quantities, estimated prices, prior-price
information where available, calculated totals, Procurement information,
and audit/revision information — gated by financial-visibility capability
(§16), never merely because someone can view a department Demand.

---

## 13. Final Approval (Checkpoint 5)

The final purchasing authorization gate. Required UM/CFO approvals are
recorded. CFO is the formal financial/final authority per current business
proposal, expressed as a capability (`procurement.financial_approve` or
equivalent — see §26), never a scattered `if (role === 'CFO')` check. Once
all required final approvals succeed: the approved Demand revision is
locked, approval-relevant editing is prevented, and the **IPO is generated
automatically** — no separate manual "Generate IPO" step (owner override,
explicit).

---

## 14. Revisions (Checkpoints 2 &amp; 5)

After final approval, the approved Demand revision is immutable for
approval-relevant content. A required change reopens the Demand,
increments the revision, preserves the previous approved revision
unchanged, re-enters the required review/approval workflow, and notifies
previously relevant reviewers/approvers. Approved history is never
silently rewritten.

---

## 15. IPO — First-Class Business Document (Checkpoint 5)

**IPO is the final approved purchasing document generated from the final
approved Demand revision.** It is a real first-class domain entity, never
merely another Demand status. It records: a unique IPO id, a
system-generated IPO number (never reused, never silently changed —
numbering configuration follows existing governance/configuration
patterns, protected the same way other protected numbering/configuration
surfaces are), the exact Demand id and revision, department/site, approved
line items, approved quantities, approved pricing/budget information as
applicable, a generation timestamp, and approval references/history. Once
generated, the IPO is locked, and Procurement is notified automatically.

---

## 16. Procurement Purchase (Checkpoint 6)

Procurement works item-by-item against the IPO. Each IPO line supports
`NOT_PURCHASED` / `PARTIALLY_PURCHASED` / `PURCHASED`. Procurement records
actual purchased quantity, actual purchase unit price, relevant purchase
details, and an optional internal note. Estimated and actual price remain
separately traceable. Partial purchasing is supported; outstanding/
unpurchased quantity remains traceable to the original Demand/IPO — never
silently marked as fully purchased.

**Financial visibility (applies from Checkpoint 4 onward):** commercial
data is sensitive. A user authorized to see operational quantities is not
automatically authorized to see estimated prices, actual prices,
supplier/financial details, or totals — the query/service layer enforces
this (never fetching sensitive pricing and hiding it only in React),
mirroring the existing `compensation.view`/`compensation.export` split in
Workforce. Gate Guard and Driver continue to have zero price visibility
(§18, §28).

---

## 17. Delivery Challan (Checkpoint 6)

Delivery Challan (DC) is a separate first-class operational document from
Demand, IPO, and Gate Pass (existing decision, reaffirmed — see
`docs/DECISIONS.md`'s "Keep Gate Pass and Delivery Challan Separate"
entry). Generated from actually purchased material; references the IPO,
relevant purchased lines, quantities, department/site, Procurement
context, a DC number, status, and timestamps. A printed/exported DC stays
operationally clean: no internal approval history, pricing comparison
notes, hidden internal comments, or unrelated audit data. DC is not
coupled to Gate Pass.

---

## 18. WhatsApp Remains Part of the Real Workflow

Do not replace WhatsApp in V1. Today, the Delivery Challan is shared in
the relevant WhatsApp group, and material photos are commonly shared in
the department WhatsApp group or directly with the Team Lead. ESDMS is the
authoritative workflow/history system but does not duplicate every
WhatsApp communication in V1 — no WhatsApp integration is built unless one
already exists and is separately authorized, and receiving photo upload is
not made mandatory merely because photos are shared over WhatsApp today.
This may be revisited later based on operational feedback.

---

## 19. Receiving — Core Owner Rule (Checkpoint 7)

Any appropriate person from the relevant department who is present at the
site may physically receive that department's material — no Admin
approval required. They record the DC, received lines, actual received
quantities, timestamp, receiver identity, discrepancy/damage notes where
needed, and receiving status. Receiving is the department/Team Lead's
digital green light that material has physically arrived. Receiving does
not depend on the Gate Guard; the Gate Guard remains outside
Inventory/Procurement verification and sees no prices (existing Gate Pass
boundary, reaffirmed).

---

## 20. Receiving by Department Member (Checkpoint 7)

```text
Material arrives
        ↓
Civil/WTG/E-BOP/etc. person receives
        ↓
Receiver records receipt in ESDMS
        ↓
Relevant Team Lead notified
        ↓
TL reviews/acknowledges
        ↓
Receiving completed
        ↓
Demand/IPO/DC cycle may close when all lines are resolved
```

Receiving retains: actual receiver, receiver's department, time, DC,
actual quantities, discrepancies, and relevant references.

---

## 21. Admin as Fallback Temporary Custodian (Checkpoint 7)

Admin is not the required receiver — only a fallback when nobody from the
relevant department is available:

```text
Material arrives
        ↓
No relevant department person available
        ↓
Admin receives temporarily
        ↓
AWAITING_DEPARTMENT_HANDOVER
        ↓
Relevant department + Team Lead notified
        ↓
Admin physically hands material to department person
        ↓
Department person acknowledges handover
        ↓
TL / relevant workflow authority confirms
        ↓
Receiving closes
```

Recorded separately and never merged: physical initial receiver (Admin),
intended department, temporary-custody status, eventual handover
recipient, handover timestamp, confirmation. The initial receiver is never
rewritten after handover — both events are preserved.

---

## 22. Receiving Notifications (Checkpoint 7)

- **Department member receives directly** → notify the relevant Team Lead
  to review/close the receiving cycle.
- **Admin receives temporarily** → notify the relevant Team Lead/department
  that receiving is awaiting department handover.
- **Admin completes handover** → notify the relevant Team Lead to confirm
  completion.
- **Discrepancy/rejection** → notify the relevant Team Lead, Procurement,
  and the appropriate management authority where required.

Routed by site, department, workflow responsibility, and capability — never
broadcast to unrelated users.

---

## 23. Closing the Demand / Receiving Cycle (Checkpoint 7-8)

A Demand/IPO purchasing cycle closes only through explicit resolution
conditions, never an arbitrary close button: received and
department-confirmed; partially fulfilled with outstanding quantity
explicitly carried forward; rejected/cancelled through an authorized
workflow; or another explicitly defined resolution. Fully received and
department/TL-confirmed → Completed/History. Partially fulfilled →
requested, approved, purchased, and received quantities are all preserved,
and the unresolved quantity is never lost.

---

## 24. No Inventory Balance in V1 — Critical, Applies From Checkpoint 7

Receiving V1 records **what was received**; it does not calculate present
stock. No `current_stock = receipts - assumed usage` (or any variant) is
computed, because Issue/Usage is not digital yet. No "current inventory"
quantity is displayed. Historical receiving totals may be reported as
receiving history, clearly distinguished from current physical stock.
Full Inventory, when introduced later, establishes an authoritative
physical opening-stock count and builds ledger-based inventory from that
cutover — not by retrofitting a computed balance onto V1 receiving data.

---

## 25. Domain / Data Model — V1

### Implemented (Checkpoint 1)

- `company_items` — global physical/material identity.
- `units_of_measure` — global reference data (seeded set).
- `department_material_catalog` — department-scoped, reusable, references
  `company_items` and `units_of_measure`.

### Implemented (Checkpoint 2)

- `material_demands` — the Demand List header (site, department, status,
  revision, note, creator, timestamps).
- `material_demand_lines` — requested materials, snapshotting item name +
  UOM at creation time alongside a live catalog-entry FK (§7).
- `material_demand_number_counters` — year-keyed sequential counter for
  `DL-YYYY-NNNNNN` numbers, mirroring `gate_pass_number_counters`.
- `material_demand_audit_log` — append-only, one row per create/edit/submit
  (not per-line), mirroring `gate_pass_audit_log`.

### Target for later checkpoints — not yet created

- Demand Revision as its own structure (the `revision` column exists and
  is reserved but unused beyond `1` — see §14).
- Demand Review/Approval history.
- Procurement: pricing data/procurement action, final financial approval,
  IPO, IPO Line, purchasing line/progress.
- Delivery: Delivery Challan, Delivery Challan Line.
- Receiving: Material Receipt, Receipt Line, department confirmation,
  temporary Admin custody/handover record.

No speculative Inventory table (`stock_movements`, `stock_balances`,
`inventory_batches`, material issue/usage/return) exists or is planned
within this V1 — see §24.

Audit and notifications reuse existing ESDMS infrastructure throughout
(one dedicated audit table per bounded domain, matching the `gate_pass_audit_log`
convention; the existing `notification_outbox`) — no new mechanism is
introduced for either.

---

## 26. Authorization — V1 Capability Model

Capability codes follow the existing `module.action` convention
(confirmed in `docs/DECISIONS.md`). **Implemented (Checkpoint 1):**

| Capability | Grants |
|---|---|
| `material_catalog.view` | View a department's material catalog |
| `material_catalog.manage` | Add materials to a department's catalog; archive/unarchive entries |
| `material_catalog.all_departments` | View/manage material catalogs across every department |

Default role grants: `CEO` — all three. `ADMIN`, `SITE_MANAGER`, `TEAM_LEAD`
— view + manage (department-scoped). `UPPER_MANAGEMENT` — **view only**,
no `.all_departments` (corrected during Checkpoint 1 finalization to match
Workforce's own precedent — holding Upper Management never implies a
broad-scope grant by itself; see `docs/DECISIONS.md`). `EMPLOYEE` — view
only. `GATE_GUARD` and `HR` — none. Adjustable per-user via the existing
GRANT/DENY override mechanism; no new mechanism was introduced.

**Implemented (Checkpoint 2):**

| Capability | Grants |
|---|---|
| `demand.view` | View a department's Material Demand Lists |
| `demand.create` | Create a Material Demand List for a department |
| `demand.edit` | Edit a Material Demand List while it is in DRAFT |
| `demand.submit` | Submit a Material Demand List into the review workflow |
| `demand.all_departments` | View/manage Material Demand Lists across every department |

Default role grants mirror Material Catalog's corrected pattern exactly:
`CEO` — all five. `ADMIN`, `SITE_MANAGER`, `TEAM_LEAD` — view/create/edit/
submit (department-scoped), no `.all_departments`. `UPPER_MANAGEMENT` —
view only. `EMPLOYEE` — view only ("no Demand creation by default unless
explicitly granted" — an individual GRANT is the intended mechanism for a
specifically designated employee Demand creator). `GATE_GUARD` — none.

**Target for later checkpoints** (capability names indicative, not final
— define precisely when each checkpoint is designed):

- Demand: review, approve (Checkpoint 3 — distinct from the implemented
  `demand.edit`/`demand.submit`, which only cover the creator's own draft
  workflow).
- Procurement: view assigned approved demands, enter pricing, view prices,
  submit pricing, record purchasing, view actual prices.
- Financial approval: a distinct capability from ordinary Procurement
  authority (mirrors the existing `users.create_um`/`users.manage_um`
  pattern — role alone never implies the higher authority).
- IPO: view, cancel where authorized, configure numbering only through
  protected governance authority.
- DC: create/finalize/view.
- Receiving: receive relevant department material, receive temporarily as
  Admin, confirm handover, Team Lead/department completion, manage
  discrepancy where separately authorized.
- Cross-department/all-site visibility: always an explicit capability,
  never implied by role or by organizational Position.

A user's organizational Position alone grants zero application authority,
at every checkpoint.

---

## 27. Department Isolation Tests — Mandatory at Every Checkpoint

Every checkpoint that adds a department-scoped record type must ship
backend tests proving, via direct API calls (not merely UI navigation):
a department-scoped user CAN see/act on their own department's records
(catalog, demand, receiving, etc.) if authorized, and CANNOT enumerate or
modify another department's equivalent records — including by supplying
that department's id as an explicit request parameter, which must be an
explicit denial, not a silent override or a silent empty result. All-site/
management authority must also be tested against the existing ESDMS
authorization model.

**Implemented:** `backend/test/material-catalog-department-scope.test.js`
(Checkpoint 1); `backend/test/material-demand-department-scope.test.js`
(Checkpoint 2 — department isolation, site isolation, capability/DENY-wins
checks, and Draft-integrity checks together).

---

## 28. Financial Data Separation

Commercial data is sensitive at every checkpoint from Checkpoint 4 onward.
Being authorized to receive or view material operationally never implies
authorization to see estimated prices, actual prices, supplier/financial
details, or totals. Department receiver screens expose operational
information primarily. Gate Guard and Driver have zero price visibility,
unchanged from Gate Pass. The query/service layer enforces this — pricing
is never fetched and merely hidden by React.

---

## 29. Notification State Machine

Notifications are workflow side effects of successfully **committed**
transitions — never sent before the corresponding transaction commits
(mirrors the existing Gate Pass approval → outbox-in-same-transaction
pattern). **`DEMAND SUBMITTED` is implemented (Checkpoint 2)**; everything
else below remains target design for checkpoints 3-7:

```text
DEMAND SUBMITTED                       → notify UM + CFO
INITIAL REQUIRED APPROVALS COMPLETE    → notify Procurement: READY FOR PRICING
PROCUREMENT PRICING SUBMITTED          → notify UM + CFO: FINAL APPROVAL REQUIRED
FINAL APPROVAL COMPLETE                → atomically generate IPO
                                        → notify Procurement: IPO READY FOR PURCHASE
PURCHASING / DC FINALIZED              → notify relevant department/TL as appropriate
DIRECT DEPARTMENT RECEIPT              → notify Team Lead: CONFIRM RECEIPT
ADMIN TEMPORARY RECEIPT                → notify department/TL: HANDOVER PENDING
HANDOVER COMPLETED                     → notify Team Lead: CONFIRM COMPLETION
DISCREPANCY / REJECTION                → notify responsible Department + Procurement
                                          + required management authority
```

**Implementation note (Checkpoint 2):** `DEMAND SUBMITTED` is routed by
role + site — the same mechanism every existing ESDMS notification uses
(Gate Pass's `GATE_PASS_APPROVED` → `recipientRole: "GATE_GUARD"`): one
`IN_APP` row targeting `UPPER_MANAGEMENT` at the Demand's site, one
targeting `CEO` at the Demand's site. This is correct for
`UPPER_MANAGEMENT` (already site-scoped by default, §26). It is a known,
narrow, deliberately deferred gap for `CEO` specifically: CEO's authority
spans every site, but a CEO account's own `site_id` only matches a Demand
submitted at that CEO's home site — in a genuinely multi-site deployment,
a Demand at a site with no matching CEO `recipient_site_id` would not
notify CEO in-app (CEO can still find it by browsing; their *view*
authority is unaffected, only the notification). The correct fix is a
capability-driven (not role-string-driven) notification routing
mechanism, deferred to Checkpoint 3 alongside the real
review/final-approval capabilities — see
`backend/src/modules/material-demand/material-demand.service.js`'s
`submitDemand` for the exact code comment, and `docs/DECISIONS.md`.

Idempotency/uniqueness (the existing `notification_outbox` idempotency-key
pattern) prevents a retried transition from creating a duplicate IPO or a
duplicate notification.

---

## 30. State Machine Design — target design

Separate bounded state machines per domain (not one cross-domain status
field), each following the existing Gate Pass pattern: lock the row,
validate the transition against an explicit allowed-transition table,
apply, audit — all in one transaction.

**Demand** (indicative; `DRAFT → PENDING_INITIAL_REVIEW` is implemented,
everything after it is not):
```text
DRAFT → PENDING_INITIAL_REVIEW → READY_FOR_PRICING → PENDING_FINAL_APPROVAL
      → APPROVED → IPO_GENERATED → IN_PURCHASING → RECEIVING → COMPLETED
```
plus controlled `REJECTED`, `CANCELLED`, and a reopen/revision path (§14).
The implemented `submit` transition follows the exact
lock-then-validate-then-transition-then-audit pattern this section
describes: `backend/src/modules/material-demand/material-demand.service.js`
locks the row, checks `definition.from.includes(status)`, checks line
count, updates status + `submitted_at`, writes one audit row, and enqueues
the notification — all inside one transaction.

**IPO** (indicative): `GENERATED → ACKNOWLEDGED → PURCHASING →
PURCHASE_COMPLETE/PARTIAL → COMPLETED`, plus authorized cancellation.

**DC** (indicative): `DRAFT → FINALIZED → IN_TRANSIT/READY → RECEIVED`.

**Receiving** (indicative): `RECEIVED_BY_DEPARTMENT →
PENDING_TL_CONFIRMATION → COMPLETED`, or the Admin-fallback path
`RECEIVED_BY_ADMIN → AWAITING_DEPARTMENT_HANDOVER → HANDED_OVER →
PENDING_TL_CONFIRMATION → COMPLETED`, plus discrepancy/rejection states if
the checkpoint that implements them justifies them.

Only implement statuses justified by actual V1 workflow when each
checkpoint is built — do not add a status because it sounds useful.

---

## 31. Security / Integrity Rules — binding at every checkpoint

- Backend owns authorization, state transitions, approval validity, IPO
  generation, and numbering.
- A client can never forge actor/department/site.
- Approved revisions cannot be silently altered.
- Duplicate requests cannot generate duplicate IPOs; duplicate transition
  calls cannot create duplicate notifications (idempotency-key pattern).
- Money uses safe numeric/decimal types, never floating point.
- Approved historical values remain auditable.
- Department/site isolation is enforced server-side (§27).
- Prices are not exposed through broad operational endpoints (§16, §28).
- Gate Pass and Workforce remain unchanged; Employee and User remain
  distinct; Position never grants application authority.
- No stock quantity is ever fabricated (§24).

---

## 32. Frontend Experience

Reuse the existing AppShell, navigation, PageHeader, Button, FormField,
Dialogs, pagination, permission gates, responsive conventions, and CSS
design tokens — no new UI framework, no Tailwind/shadcn (confirmed not
present in this repository).

**Implemented (Checkpoint 1):** Department Material Catalog page
(`frontend/src/modules/material-catalog/pages/MaterialCatalogPage.jsx`) —
search/filter, table + responsive card list, archive/restore, and an Add
Material dialog (search existing items, annotate catalog membership,
create-new-and-add in one flow). Reachable via a capability-gated
"Material Catalog" nav item.

**Implemented (Checkpoint 2):** Demand List page
(`frontend/src/modules/material-demand/pages/DemandListPage.jsx` —
search/filter by status, table + responsive card list), New/Edit Demand
page (`DemandFormPage.jsx` + `DemandForm.jsx`, reused for both create and
Draft edit), the department catalog picker
(`components/DemandItemPicker.jsx` — checkbox + quantity, reuses
Checkpoint 1's `AddMaterialDialog` directly for "+ Add Material" rather
than a second material-creation implementation), and the Demand Detail
page (`DemandDetailPage.jsx` — read-only once `PENDING_INITIAL_REVIEW`,
with an explicit "pending management review" notice; Edit/Submit actions
only while `DRAFT`). Reachable via a capability-gated "Demands" nav item.

**Target for later checkpoints:** Department — Receiving/Pending
Confirmation. Procurement — Ready for Pricing, Pricing Detail, Ready for
Purchase, IPO Detail, Purchase Progress, Delivery Challan. Management —
Pending Initial Review, Pending Final Approval, Demand Detail/revision
history. Receiving — Receive DC, Pending Department Handover, Pending TL
Confirmation, Completed Receiving. All navigation capability-controlled.

---

## 33. Responsive / Mobile

This workflow is used at site, often on a phone. At ~360px and above: no
page-level horizontal overflow, touch-usable forms, fast Demand item
selection, easy mobile receiving, contained-scroll or existing responsive
table/card patterns. PWA behavior is preserved. Offline mutation is not
enabled for this workflow unless deliberately designed and separately
approved (existing PWA architecture already treats offline write support
as something that must explicitly address action queues, idempotency,
conflicts, and sync status before being introduced — see
`docs/ARCHITECTURE.md` §11).

---

## 34. Reporting — V1

No full reporting engine is built in V1, but data is structured so future
reports can answer: demands by department; demand status/history; approved
quantities; IPO references; purchase completion; DC references; received
quantities; receiver; Admin temporary receipt/handover; department
confirmation; unresolved discrepancies. Received totals are never labeled
as current stock (§24).

---

## 35. Formal PDF Documents — target design

At minimum, three later-checkpoint document types are generated as formal,
downloadable PDFs, mirroring the existing Gate Pass PDF/QR pattern
(`docs/GATE_PASS_SPEC.md` §7-§8: PostgreSQL stores structured data +
object metadata only, actual bytes served only through an authenticated,
authorized backend endpoint, never a static file mount):

- Demand List
- IPO
- Delivery Challan

**Exact printable layouts are not invented now.** They will be derived
from real E-Set sample documents the owner supplies when each checkpoint
that generates them is designed. Until then, this section only commits to
the access model: any authorized user may eventually download a PDF for a
record they hold view authority over, generated server-side (never
client-assembled), through an authorized endpoint that re-checks scope and
permission the same way `GET /gate-passes/:id/files/:fileId` does — never
a public/guessable URL. Financial fields (IPO/pricing-bearing documents)
follow the same visibility gate as the underlying data (§16, §28): a PDF
download must never leak pricing to a viewer who couldn't see it through
the ordinary API.

---

## 36. Excel / Historical Data Export — target design

All relevant structured workflow/history data is ultimately exportable to
Excel, subject to the same authorization the application enforces
elsewhere — reusing the existing Workforce export pattern
(`src/shared/reports/excel-safety.js`'s `sanitizeCell` for
formula-injection safety and `safeExportFilename` for server-generated
filenames, per `docs/SECURITY.md` §13) rather than a new export mechanism.
Candidate exports (later checkpoints, not V1 Checkpoint 1):

- Demand history and revisions
- Approval history
- IPO history
- Purchasing history
- Delivery Challans
- Receiving history
- Department confirmation/handover history
- Completed/cancelled/rejected workflow records

An export must respect the same data permissions as the live application —
**a user who cannot view procurement pricing must not obtain pricing
through an export endpoint either**, matching the existing precedent that
a Workforce report "never fetches compensation at all (not just hides it)
unless the requester holds the export permission" (`docs/SECURITY.md`
§13). A filtered export preserves the filters applied and carries
traceability identifiers (Demand/IPO/DC numbers) rather than exporting
anonymous rows. Implementation belongs to the checkpoint that introduces
each underlying record type, not to Checkpoint 1.

---

## 37. Audit / Log Management Authority

This module follows the platform-wide audit/log-management invariant now
documented in `docs/SECURITY.md` (new §14, "Audit / Log Management
Authority — Platform Invariant"): ordinary users never modify or delete
historical logs; holding Upper Management does not by itself grant
log-management authority (mirrors §26's "action authority is separate from
scope authority" and the `material_catalog.all_departments` correction
recorded in `docs/DECISIONS.md`); CEO holds exceptional log-management
authority by default and may delegate specific log-management capabilities
to a specific Upper Management user through the existing per-user
GRANT/DENY mechanism — delegation is per-user, revocable, and itself
audited; corrections prefer reversal/history-preserving patterns over
destructive rewriting wherever the domain allows it. No new
log-management UI is introduced in Checkpoint 1 — this module currently
has no audit log of its own beyond ordinary `created_at`/`updated_at`
columns (Company Item and Department Material Catalog are simple
reference/master data, matching the existing `departments`/`positions`
convention). A dedicated append-only `procurement_audit_log`-style table
(reusing the existing `forbid_update_delete()` trigger, per
`docs/DECISIONS.md`'s Phase I specification §19) becomes relevant starting
at Checkpoint 2 (Demand List), once real workflow state transitions exist
to audit.

---

## 38. Out of Scope for This Phase

- Full Inventory (stock ledger, current balances, FIFO/batches, Material
  Issue/Usage/Return, adjustment, transfer, warehouse/bin management,
  low-stock calculation) — see §24 and `docs/DECISIONS.md`.
- Real WhatsApp Business API integration (§18).
- Offline transaction sync for this workflow (§33).
- Multi-supplier quotation/RFQ comparison, structured Supplier/Vendor
  master data, and multi-tier approval thresholds beyond the single
  UM/CFO gate described above — revisit only if operational feedback or
  an explicit owner decision requires them.
- Final PDF layouts (§35) and Excel export implementation (§36) — both are
  target designs for later checkpoints, not Checkpoint 1 deliverables.
- A dedicated log-management UI (§37) — the platform invariant is
  documented now; UI/endpoints are introduced only when a checkpoint
  actually needs them.
