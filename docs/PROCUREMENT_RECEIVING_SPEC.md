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
| 3 | Initial Management/Formal approval + notification routing | **Implemented** |
| 4 | Procurement pricing + financial visibility | **Implemented** |
| 5 | Final pricing approval + controlled repricing foundation | **Implemented** (stops at `READY_FOR_IPO`; official IPO awaits owner documents) |
| 6 | Official IPO + numbering + purchasing + Delivery Challan | **Implemented** |
| 7 | Department receiving + Admin fallback custody/handover + Team Lead closure | **Implemented** |
| 8 | Line-level budget disposition, previous-price comparison, carry-forward, PDFs, Excel exports, WhatsApp delivery, history | **Implemented** |

Procurement & Material Receiving V1 is complete end to end: Department
Catalog → Demand → Initial Approval → Pricing → Final Approval → IPO →
Purchasing → Delivery Challan → Receiving → Department Confirmation →
Completed History, with PDFs, Excel exports and official WhatsApp document
delivery.

**Still deliberately NOT built** (see §24, §38): current stock balance,
stock ledger, FIFO/batch consumption, Material Issue, usage, return, stock
adjustment, stock transfer, warehouse/bin management, and offline mutation
sync. Receiving records what physically arrived; it never states what is in
stock today.

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

## 8. Notification — Demand Submitted — **Implemented (Checkpoint 3)**

On submit, one `IN_APP` notification row is enqueued per eligible
recipient — every active user who effectively holds `demand.review` or
`demand.approve` (role grant or individual GRANT, minus individual DENY)
and is in scope for this Demand's site (or CEO/`demand.all_departments`) —
computed by the reusable
`src/shared/notifications/recipient-resolver.js#resolveEligibleRecipients`
(§26, §29). A user eligible through both capabilities (e.g. CEO) gets
exactly one notification, not two. Each row carries `demandNumber` and
`departmentId` in its payload and a recipient-specific idempotency key
(`demand:{id}:rev:{revision}:initial-review:{userId}`), enqueued inside
the same committed transaction as the `SUBMIT` transition — never before
commit, never duplicated on replay. This supersedes Checkpoint 2's
temporary role+site mechanism entirely, including its previously
documented CEO cross-site gap (§29).

---

## 9. First Management Review + Formal/CFO Approval — **Implemented (Checkpoint 3)**

The need/quantity review before Procurement spends time pricing it — and
the first of two approval gates in the full workflow (§6/§13: a **second**
management/CFO gate exists after Procurement pricing, in a later
checkpoint; the two are separate and this section only covers the first).

Two independent, required decision slots, each capability-gated
separately (§26):

- **Management Review** (`demand.review`) — the operational/site-management
  slot (Site Manager, Upper Management, or CEO by default). ADMIN has no
  default management-review authority; a specifically authorized ADMIN or
  other user may receive it through an explicit per-user GRANT.
- **Formal Approval** (`demand.approve`) — the CFO/financial-authority
  slot. No CFO role exists in ESDMS; this is CEO-only by default,
  delegable to a specific Upper Management user via the existing per-user
  GRANT mechanism (the same pattern as `users.create_um`/`manage_um`) —
  see the owner decision in `docs/DECISIONS.md`.

Each is recorded as an immutable `material_demand_approvals` row (never a
bare status change) tied to the Demand's `id` **and current `revision`**,
carrying the decision (`APPROVED`/`REJECTED`), the deciding actor, and a
reason (required to reject, optional to approve). A slot can be decided
exactly once — not every eligible reviewer approves, only one decision per
slot, first writer wins (the `INITIAL` partial unique index on Demand,
revision, and approval type backs this, not just application logic). Order does not
matter: either slot may be decided first.

**A single ordinary user cannot fill both slots on the same Demand** —
Management Review and Formal Approval are two distinct workflow
responsibilities. CEO is a deliberate, documented exception (existing
exceptional platform authority, not an accident of also holding both
capabilities).

Once **both** slots show `APPROVED`: `PENDING_INITIAL_REVIEW →
READY_FOR_PRICING`, atomically, in the same transaction as the second
approval, and Procurement is notified automatically (§10). If **either**
slot is `REJECTED`: `PENDING_INITIAL_REVIEW → REJECTED` immediately —
this does not wait for or require the other slot, but any already-recorded
positive decision on the other slot is preserved, never erased. A decision
can only be recorded while the Demand is `PENDING_INITIAL_REVIEW`; once it
has moved to `REJECTED` or `READY_FOR_PRICING`, further attempts fail
(409).

The Demand creator cannot review or approve their own Demand merely by
having created it — ownership grants no review/approval authority (§26).

---

## 10. Notification — Ready for Pricing — **Implemented (Checkpoint 3)**

Once both initial approval slots are `APPROVED`, one `IN_APP` notification
row is enqueued per active user effectively holding `procurement.pricing`
at the Demand's site (or CEO) — the same
`resolveEligibleRecipients`-based, capability-driven mechanism as §8, with
its own recipient-specific idempotency key
(`demand:{id}:rev:{revision}:ready-for-pricing:{userId}`). `procurement.pricing`
is a minimal capability introduced now specifically so this notification
has a real, capability-driven recipient rather than a hardcoded role —
Checkpoint 4 below now defines the actual pricing screen/workflow around
that same capability. CEO is the only default holder; actual Procurement staff
receive an explicit per-user GRANT. ADMIN is not a default holder (§26,
`docs/DECISIONS.md`).
The Demand detail route/UI reference now links eligible Procurement users
to the protected pricing screen (§11).

---

## 11. Procurement Pricing — **Implemented (Checkpoint 4)**

Procurement enters, for every active Demand line: exact estimated market
price per unit, and sourcing/purchasing notes where required. Previous
purchase price (once historical data exists), estimated market price, and
later actual purchase price are preserved separately — never silently
overwritten by one another. Frontend-calculated totals are never trusted;
monetary totals are recomputed server-side using safe decimal/numeric
handling. A Demand is not ready for final approval until all required
pricing is complete. Submitting pricing changes the pricing header from
`DRAFT` to `SUBMITTED` and the Demand from `READY_FOR_PRICING` to
`PENDING_FINAL_APPROVAL`, then notifies eligible second-gate authorities
(§12), atomically.

Pricing is a separate protected Procurement resource; ordinary
`GET /demands/:id` never retrieves or returns it. V1 currency is explicitly
`PKR`. Exact unit prices use PostgreSQL `numeric(14,2)`, must be greater
than zero, and authoritative line/grand totals are recomputed in PostgreSQL
from the revision-bound Demand quantity × unit price. Client totals are not
accepted. Drafts may be partial; submission requires exactly one valid
price for every Demand line. Submitted headers and lines are immutable at
both service and trigger layers. Checkpoint 5 adds controlled Pricing-version
repricing after a FINAL rejection; it does not add Demand reopening.

Previous Purchase Price remains absent until derived from actual purchase
history or a separately designed legacy-data import. It is never inferred
from Estimated Market Price. Actual Purchase Price remains a later
purchasing concern.

---

## 12. Notification — Pricing Complete — **Implemented (Checkpoint 4)**

UM and CFO see requested/approved quantities, estimated prices, prior-price
information where available, calculated totals, Procurement information,
and audit/revision information — gated by financial-visibility capability
(§16), never merely because someone can view a department Demand.

Submission reuses the shared effective-capability recipient resolver for
`demand.review` and `demand.approve`, including GRANT/DENY, active state,
site scope and CEO authority, and deduplicates dual-capability users.
Recipient-specific keys are
`demand:{id}:rev:{revision}:pricing:{version}:final-review:{userId}`.
Checkpoint 5 requires the recipient to hold `procurement.view_prices` as
well as the relevant decision capability. Notification text has no price
data.

---

## 13. Final Pricing Approval — **Implemented (Checkpoint 5)**

The final purchasing-authorization gate has two immutable responsibilities:
`FINAL / MANAGEMENT_REVIEW` and `FINAL / FORMAL_APPROVAL`. They reuse
`demand.review` and `demand.approve`; both also require
`procurement.view_prices` and valid site scope. Every FINAL row references
the exact submitted Pricing header it decided. INITIAL rows remain separate
historical records. An ordinary user cannot fill both FINAL slots for one
Pricing version; CEO retains the deliberate exception. The same actor may
legitimately hold the same responsibility at INITIAL and FINAL stages.

Both approvals for the same submitted Pricing version transition the Demand
exactly once to `READY_FOR_IPO`. This is only a workflow boundary: no IPO
record, number, document, PDF, or purchasing operation is created.

Either rejection preserves all decisions and submitted prices, requires an
internal reason visible only through the protected pricing resource, and
transitions to `PRICING_REVISION_REQUIRED`. Procurement may then explicitly
start one new server-sequenced DRAFT Pricing version. The preceding version
remains immutable; resubmission returns to `PENDING_FINAL_APPROVAL` and sends
a new version-specific notification set.

---

## 14. Revisions

**Pricing-version repricing is implemented (Checkpoint 5).** It may change
only Estimated Market Price and Procurement notes. Demand items, quantities,
site, department, snapshots, and Demand revision do not change. Only one
current DRAFT may exist for a Demand revision, and it may be created only
from `PRICING_REVISION_REQUIRED`.

**Demand reopen/revision remains unimplemented.**

After final approval, the approved Demand revision is immutable for
approval-relevant content. A required change reopens the Demand,
increments the revision, preserves the previous approved revision
unchanged, re-enters the required review/approval workflow, and notifies
previously relevant reviewers/approvers. Approved history is never
silently rewritten.

---

## 15. IPO — First-Class Business Document — **Implemented (Checkpoint 6)**

Tables: `ipos`, `ipo_lines`. Generated automatically inside the very
transaction that completes final approval — there is no manual "Generate
IPO" step. Exactly-once generation is a DATABASE guarantee, not a service
convention: `unique (demand_id, demand_revision)` means a replayed or
concurrent final approval can only ever conflict, never produce a second
IPO. `READY_FOR_IPO` remains a real audited boundary in the history but is
never a resting state; the Demand moves straight on to `IPO_GENERATED`.

Each IPO pins the exact Demand id and revision, the exact approved Pricing
version (composite FK to `material_demand_pricing(id, demand_id,
demand_revision)`), department, site, currency, the server-computed
approved total, the generation timestamp and actor. Lines snapshot the item
name, UOM, approved quantity, estimated unit price and the physical
`company_item_id`. Database triggers make that whole snapshot immutable and
forbid DELETE of an IPO or an IPO line, so cancellation preserves both the
record and its number.

Only lines management approved for purchase reach the IPO (§15a).

**IPO numbering.** Server-controlled, concurrency-safe, never reused.
Issuance reuses the existing atomic year-keyed counter pattern
(`document_number_counters`, `INSERT .. ON CONFLICT DO UPDATE ..
RETURNING`), and the FORMAT is data (`document_number_settings`: prefix,
separator, suffix, pad width, start value). The V1 default follows the
authentic E-Set reference format `ESET/2026/32`. A cancelled IPO keeps its
number and the counter is never rolled back. Because a reference legitimately
contains `/`, every download filename goes through
`documentFilename()`, which allowlists `[A-Za-z0-9_-]` so no separator can
reach a Content-Disposition header or a storage path.

**IPO lifecycle:** `GENERATED → ACKNOWLEDGED → PURCHASING → COMPLETED`,
plus `CANCELLED`. Acknowledgement is audited and does not block purchasing.

**Cancellation** requires `ipo.cancel` (CEO by default), a free-text reason
and an optional category; it preserves the IPO, its number and its history,
notifies Procurement and management, and blocks further purchasing. V1
takes the conservative rule while the business policy is unresolved: an IPO
with recorded purchases or a live Delivery Challan cannot be cancelled at
all, so real recorded purchases are never silently voided — outstanding
quantity is resolved through purchasing closure instead.

### 15a. Line-Level Purchasing Disposition — **Implemented (Checkpoint 8)**

Management routinely funds most of a Demand and marks one line "out of
budget". Table: `material_demand_line_dispositions`, one row per
(`pricing_id`, `demand_line_id`), values `APPROVED_FOR_PURCHASE` /
`EXCLUDED` with categories `OUT_OF_BUDGET`, `NOT_REQUIRED_NOW`,
`ALREADY_AVAILABLE`, `DUPLICATE`, `OTHER`.

An exclusion is **not** a deletion: the Demand line, its requested quantity,
its Pricing version and its estimated price all survive, and the decision
itself snapshots quantity and estimate. A line with no row is implicitly
`APPROVED_FOR_PURCHASE`, so nothing needed backfilling. Excluding every
line is refused — that is a rejection, which already has its own path.

Determinism of the approved set, without blocking a real business event. The
owner's actual sequence is: the Site Manager records the final management
review, and only THEN the CEO rules a line out of budget. Freezing at the first
decision would make that impossible.

Instead every FINAL approval records a `disposition_fingerprint` — a hash of
the exact purchasing set it decided on — and the gate completes only when both
responsibilities have approved the SAME, still-current set. A later exclusion
neither rewrites nor deletes the earlier approval; that approval simply stops
satisfying the gate, and its author decides again on the new set as a NEW
immutable row (the FINAL slot uniqueness is widened by the fingerprint). The
generated IPO therefore always contains exactly the set the formal authority
approved. Dispositions freeze for good once the IPO exists.

Recording a disposition requires a management responsibility
(`demand.review` or `demand.approve`) AND `procurement.view_prices` — it is
a decision about a price. The department sees the disposition and its
category (it needs them to decide about carry-forward); the free-text
financial explanation is redacted exactly like a FINAL rejection reason.

### 15b. Previous Purchase Price — **Implemented (Checkpoint 8)**

When Procurement prices a line, the system shows the most recent **actual
finalized purchase price** — the latest purchase EVENT that still stands, on a
non-cancelled IPO whose purchasing has been formally closed
(`purchasing_closed_at IS NOT NULL`). A purchase still in progress is not an
authoritative "what we last paid", because it can still move; neither is one
that was later reversed. Only the unreversed remainder counts, so a fully
reversed purchase drops out entirely and the lookup falls back to the newest
purchase that survives, while a partially reversed one stays eligible — units
really were bought at that price and kept — for the same
material, plus the difference in PKR
and as a percentage. Matching is on the authoritative `company_item_id`
snapshot stored on `ipo_lines` — never on a similar description, so
"Screw 1/2 inch" and "Screw 2 inch" can never share price history. Fuzzy
search assists catalogue discovery only; it never determines financial
identity.

Arithmetic is exact (`src/modules/procurement/price-comparison.js`): both
prices convert to integer minor units as BigInt, so no float ever touches
money; only the percentage is a ratio, computed at two decimals with
explicit half-away-from-zero rounding. With no prior purchase the response
is `null` and the UI says "No previous purchase history" — never `Rs 0` or
`0%`, which would falsely assert the price had not moved. The whole
comparison is gated behind price authority.

### 15c. Purchase events and corrections — **Implemented**

One IPO line is realistically bought more than once at different prices, so
each purchase is its own append-only `ipo_purchase_events` row (quantity,
price paid, actor, time, operation id). The line-level `purchased_quantity` is
a maintained aggregate, and a deferred constraint trigger proves it always
equals the sum of its events — a total cannot be fabricated without the events
behind it. Once purchasing is closed, a trigger freezes the purchasing facts
for every writer, and ordinary Procurement cannot append anything further.

**A correction is a linked reversal, never a free-priced negative purchase.**
A negative event must name the exact purchase it withdraws
(`reverses_purchase_event_id`) and inherits that purchase's price, which the
server reads from the referenced event — the API accepts no price on a
reversal at all, and requires a reason. Without that link, "reverse the 60
bought at 100" could be recorded as "-60 at 1" and leave 5,940 of value on a
line that was fully undone.

The rules, enforced in the service AND at the database:

- a reversal references an original purchase, never another reversal or itself;
- a composite foreign key makes referencing a purchase on another IPO line —
  and therefore another IPO — structurally impossible;
- total reversals against one purchase can never exceed its quantity, checked
  under a row lock on the original so two concurrent corrections serialize;
- the original row is never rewritten: `+60 @ 100` and `-20 @ 100` both stand,
  netting 40 @ 100;
- net purchased quantity can never go negative, exceed the approved quantity,
  or drop below what a live Delivery Challan already carries — material that
  has physically moved cannot be corrected away.

### 15d. Carry-forward allocation — **Implemented**

An unresolved quantity carried into a later Demand is an authoritative CLAIM
against its source (`carry_forward_allocations`), not a hint. Availability is
`source_quantity` minus every ACTIVE claim, so the same outstanding 40 cannot
be carried into three Demands. Three non-overlapping sources:
`UNPURCHASED_IPO_QUANTITY` (approved and ordered, purchasing closed short),
`OUT_OF_BUDGET` (excluded from the set that actually became purchasing
authority — proven by an IPO generated from that same Pricing version) and
`RECEIVING_SHORTAGE` (purchased, delivered, and confirmed short). The first two
were never bought; the third was — so no unit is ever counted twice.

The claim becomes authoritative at SUBMIT, so an abandoned draft reserves
nothing and there are no orphan reservations. A Demand that is rejected, or
whose IPO is cancelled, releases its claim (marked RELEASED, never deleted).
Allocation is guarded by a trigger that locks the source first, so two Demands
submitting against the same remaining quantity serialize.

Allocations are append-only historical links: source, target, quantity,
department, site, creator and creation time are frozen at the database, and a
row can never be deleted. Release is a one-way lifecycle transition — ACTIVE to
RELEASED, once — which restores the source's remaining availability without
erasing the claim that was made. Undoing an allocation therefore means
releasing it and claiming again through the normal workflow, so both events
stay readable. A ledger whose entries can be restated afterwards would offer no
more protection than no ledger at all: rewriting a claim of 25 down to 10 frees
15 that another Demand has already spent.

A Draft therefore carries source INTENT without reserving quantity, and that
intent is durable: the source linkage is stored on the Demand line, returned
with the Draft, and restored when it is reopened, so editing an unrelated
field — or the carried quantity itself — never silently converts the line into
an ordinary request. Removing the line withdraws its intent with it, and
re-adding the same material by hand is a fresh, unsourced requirement. The
restored linkage is only intent: the server re-validates the source, its
department and its remaining availability on every save and at submission, so
a tampered client cannot switch a claim to another department's source.

**The historical target text below is retained for context.**

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

## 16. Procurement Purchase — **Implemented (Checkpoint 6)**

Procurement records, per IPO line, the actual purchased quantity, the actual
purchase unit price, an optional internal note and the purchase
timestamp/actor. `purchase_status` (`NOT_PURCHASED` /
`PARTIALLY_PURCHASED` / `PURCHASED`) is a stored derivation of the
quantities, and a CHECK constraint proves it can never drift from them.

Values are recorded as ABSOLUTE line values, never deltas — which is what
makes a replayed request naturally idempotent instead of double-counting.
Over-purchase is rejected by the database as well as the service (V1 has no
exception policy). A purchased quantity also cannot be reduced below what a
live Delivery Challan already carries; both that check and DC creation hold
the same IPO row lock, so they cannot race.

Estimated and actual price are permanently distinct columns: recording an
actual price never overwrites the estimate. All totals are computed
server-side in exact numeric; no client total is trusted.

`procurement.purchase` is CEO-only by default — real Procurement staff
receive an explicit per-user GRANT, exactly like `procurement.pricing`.
ADMIN, SITE_MANAGER, UPPER_MANAGEMENT and TEAM_LEAD hold none of it by role.

### Historical target text



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

## 17. Delivery Challan — **Implemented (Checkpoint 6)**

Tables: `delivery_challans`, `delivery_challan_lines`. A first-class
operational document, deliberately NOT merged with Gate Pass: the two share
no foreign key in either direction, and a DC id is not addressable through
the Gate Pass API (both are asserted by test).

Numbering reuses the same configurable mechanism as the IPO
(`ESET-DC/2026/8` by default). Lifecycle: `DRAFT → FINALIZED → RECEIVING →
COMPLETED`, plus `CANCELLED`.

One IPO may produce several Delivery Challans, because partial purchasing
produces partial delivery. The invariant that keeps that safe is
allocation: across all non-cancelled challans, the quantity allocated from
an IPO line can never exceed that line's actual purchased quantity. It is
enforced in the service under the IPO row lock AND re-checked by a trigger
that locks the parent `ipo_lines` row, so two concurrent allocations
serialize rather than both passing.

Creation is idempotent through a client-supplied operation id, bound to the
IPO it was issued against: retrying the same request returns the same challan
and the same number, while reusing that id under a different IPO is a conflict,
never a replay.

A finalized challan is immutable — a trigger refuses content changes and
line writes once it leaves DRAFT, and no challan can ever be deleted.
Correction is cancel-and-replace, and cancellation is refused once anything
has been received against it, so receiving history is never voided by a
Procurement-side correction.

`dc.manage` is CEO-only by default (per-user GRANT for Procurement staff);
`dc.view` is operational and carries no pricing.

### Historical target text



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

## 18. WhatsApp Document Delivery — **Implemented (Checkpoint 8)**

Finalizing an IPO or a Delivery Challan automatically queues its PDF for
delivery to the configured WhatsApp destination — the Procurement/company
destination for an IPO, and the owning department's own destination
(`departments.whatsapp_destination`, falling back to a configured default)
for a Delivery Challan.

**Scope limitation to validate in production.** The provider sends to a
configured DESTINATION using the Cloud API's `recipient_type: individual`.
Automatic delivery to a department WhatsApp GROUP is the owner's eventual
goal; the architecture and per-department configuration support it, but
whether a given destination is deliverable depends on the provider and
business account, which cannot be verified from this codebase. Configuration
and UI therefore say "destination", never "group", until that is confirmed.

**Only the official WhatsApp Business Platform is supported.** There is no
WhatsApp Web scraping, headless-browser automation, reverse-engineered
session library or personal-account cookie reuse anywhere in this codebase,
and none will be added: those violate WhatsApp's terms, break without
warning, and would put a real business account at risk of a ban.
Credentials come only from the environment (`WHATSAPP_ENABLED`,
`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_API_VERSION`, destinations) and
never appear in source, the database, logs, audit metadata or API responses.

**A delivery failure can never touch a business record.** The chain reuses
the existing Gate Pass outbox architecture exactly:

```text
IPO / DC transaction COMMITS
      → SYSTEM job enqueued in that same transaction (so it is as durable
        as the record itself)
      → render PDF, store bytes, insert procurement_documents
      → WHATSAPP job enqueued with a per-document idempotency key
      → official provider attempt; outcome recorded on the outbox row
```

An IPO is never rolled back, deleted or blocked because a renderer, object
store or messaging API had a problem, and the document stays downloadable
either way. Retries never double-send: the idempotency key is stable per
document, a stale in-flight external job goes to `UNCERTAIN` rather than
being replayed, and a document for a cancelled IPO/DC is voided instead of
shared.

**Disabled is a first-class, honest outcome.** With `WHATSAPP_ENABLED=false`
(the default) or missing credentials, the workflow still succeeds and the
delivery row is written terminally as `DISABLED` with a `skippedReason`,
plus a `DOCUMENT_DELIVERY_SKIPPED` audit event — never left `PENDING`
(which would retry forever) and never `FAILED` (which would misreport a
configuration choice as an error). Users download and share by hand.

Delivery history — document type/id, destination, event, status, attempts,
provider message id, timestamps, failure information and idempotency key —
is the existing `notification_outbox` row; no parallel mechanism was added.

Captions carry the document reference only, never an amount: a WhatsApp
caption is visible in a notification preview, a far wider surface than the
document's own authorization.

### Historical context

Do not replace WhatsApp in V1. Today, the Delivery Challan is shared in
the relevant WhatsApp group, and material photos are commonly shared in
the department WhatsApp group or directly with the Team Lead. ESDMS is the
authoritative workflow/history system but does not duplicate every
WhatsApp communication in V1 — no WhatsApp integration is built unless one
already exists and is separately authorized, and receiving photo upload is
not made mandatory merely because photos are shared over WhatsApp today.
This may be revisited later based on operational feedback.

---

## 19-21. Receiving, Confirmation and Admin Fallback — **Implemented (Checkpoint 7)**

Tables: `material_receipts`, `material_receipt_lines`.

**Department ownership.** Any appropriate active member of the owning
department may record receipt — `receiving.receive` is a default EMPLOYEE
capability, so a Team Lead is not the only possible receiver and no Admin
approval is involved at any point. The department's Team Lead is then
notified and closes the cycle with `receiving.confirm`. Nothing here is
department-specific: the same code serves Civil, WTG, E-BOP, HSE, Admin and
any future department.

**Two authorizations, never collapsed into one.** Ordinary
`receiving.receive` is strictly the actor's own department at their own
site — knowing another department's Delivery Challan id gains nothing.
Temporary Admin custody is a separate, explicitly granted
`receiving.fallback_receive`, which is cross-department but still
site-bound. ADMIN holds the fallback capability and NOT `receiving.receive`,
so the ordinary path is refused for them even at their own site.

**Custody is never rewritten.** An `ADMIN_FALLBACK` receipt starts
`AWAITING_HANDOVER`; the DEPARTMENT (not Admin) acknowledges the handover,
which sets the recipient and handover time while leaving the original Admin
receiver and receipt time untouched — a trigger refuses any attempt to
change either, or to rewrite a completed handover.

**Actor identity is never forged.** The audit actor is always the
authenticated user. When the person who physically took delivery has no
login, `physical_receiver_employee_id` records them separately, preserving
the platform-wide Employee ≠ User separation.

**Quantities.** DC quantity, received quantity, discrepancy quantity and
the resulting unresolved quantity are stored separately and never
collapsed. Discrepancy types: `SHORT`, `DAMAGED`, `WRONG_SPEC`, `REJECTED`,
each with an optional note; a discrepancy quantity must name its type, and
discrepant material is never counted as received. Over-receipt is rejected
by both the service and a trigger that locks the DC line first, so two
concurrent receivers cannot both take the last quantity. Recorded receipt
lines are append-only at the database level.

Receiving creates NO stock. There is no balance, ledger, batch, issue,
usage or return table anywhere in this phase — asserted by test.

### Historical target text



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

## 23. Closing the Demand / Receiving Cycle — **Implemented**

Closure is evaluated, never asserted by a button. A Delivery Challan
completes only when every line's confirmed quantity (from receipts a
department authority actually closed) equals its full challan quantity. The
IPO and the Demand complete only when, in addition:

- Procurement has explicitly closed purchasing, so any approved-but-
  unpurchased quantity is deliberate, traceable carry-forward; and
- every purchased quantity has been placed on a Delivery Challan; and
- every Delivery Challan is COMPLETED or CANCELLED.

Requested / Approved / Purchased / Delivered / Received / Outstanding /
Discrepant all remain separately readable after closure.

### Historical target text



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

### Implemented (Checkpoint 3)

- `material_demand_approvals` — one immutable row per
  (`demand_id`, `revision`, `approval_type`) — `MANAGEMENT_REVIEW` or
  `FORMAL_APPROVAL`, each `APPROVED` or `REJECTED`, revision-bound (§9),
  append-only via the existing `forbid_update_delete()` trigger.
  `material_demands_status_check` widened to add `REJECTED` and
  `READY_FOR_PRICING`; `material_demand_audit_log`'s action list widened
  for the four decision outcomes plus `READY_FOR_PRICING`.

### Implemented (Checkpoint 4)

- `material_demand_pricing` — one `DRAFT`/`SUBMITTED`, PKR-denominated
  header per (`demand_id`, `demand_revision`), with creator/submission
  attribution and timestamps.
- `material_demand_pricing_lines` — exact estimated unit prices and
  optional Procurement notes, relationally pinned to both their header and
  a Demand line from the same Demand. Item/UOM snapshots are not duplicated.
- Submitted header/lines are trigger-protected from update/delete.
  `material_demands` now admits `PENDING_FINAL_APPROVAL`; Demand audit
  actions record draft creation/save, pricing submission, and the status
  transition without placing commercial values in the operational audit.

### Implemented (Checkpoint 5)

- `material_demand_approvals.approval_stage` distinguishes `INITIAL` from
  `FINAL`; existing rows were preserved/backfilled as `INITIAL`.
- FINAL approval rows carry `pricing_id`, with a composite foreign key
  proving the Pricing header belongs to the same Demand revision. Partial
  unique indexes provide one INITIAL slot per responsibility and one FINAL
  slot per responsibility per exact Pricing version.
- `material_demand_pricing.version` is positive and server-sequenced within
  (`demand_id`, `demand_revision`). Multiple immutable SUBMITTED versions are
  allowed; a partial unique index permits only one DRAFT for that Demand
  revision.
- Demand statuses now include `PRICING_REVISION_REQUIRED` and
  `READY_FOR_IPO`. The audit stream records exact Pricing id/version metadata
  for final decisions, repricing, resubmission, and the final transition,
  without copying price values or protected rejection reasons into the
  ordinary Demand payload.

### Implemented (Checkpoints 6-8)

- `document_number_settings` / `document_number_counters` — one configurable,
  concurrency-safe numbering surface shared by IPO and Delivery Challan.
- `ipos` / `ipo_lines` — the immutable approved purchasing document and its
  snapshotted, purchase-tracking lines.
- `material_demand_line_dispositions` — management's line-level
  approve/exclude decision, frozen by the first final decision.
- `delivery_challans` / `delivery_challan_lines` — operational delivery,
  allocation-bounded against actual purchased quantity.
- `material_receipts` / `material_receipt_lines` — physical receipt,
  temporary Admin custody, handover, department confirmation, discrepancies.
- `procurement_audit_log` — one append-only audit stream for the whole
  IPO → DC → Receiving chain, keyed by `ipo_id`.
- `procurement_documents` — the stored, historically stable rendering of an
  issued IPO/DC, backing both download and WhatsApp delivery.
- `departments.whatsapp_destination` — per-department delivery destination.

### Target for later checkpoints — not yet created

- Demand Revision as its own structure (the `revision` column exists and
  is used — every approval records the revision it applied to (§9,
  §14) — but no reopen/new-revision workflow exists yet to ever advance
  it past `1`).

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

**Implemented (Checkpoint 3):**

| Capability | Grants | Scope shape |
|---|---|---|
| `demand.review` | Record the Management Review decision on a submitted Demand | Site-wide (any department at the actor's own site), not department-locked |
| `demand.approve` | Record the Formal/CFO Approval decision on a submitted Demand | Site-wide, same shape as `demand.review` |
| `procurement.pricing` | Be notified of, and eventually act on, Demands ready for Procurement pricing | Site-wide |

Action capability and record scope remain separate. Holding
`demand.review`, `demand.approve`, or `procurement.pricing` authorizes the
corresponding workflow action but never inherently grants cross-site
access. A capable Management Reviewer or Formal Approver is authorized
across every department at their own site — mirroring Gate Pass's existing
site-scope shape — while CEO or a separately effective
`demand.all_departments` scope grant reaches every site. This is a third
scope tier layered onto the department-only model Checkpoints 1-2
established, not a replacement for it — `demand.create`/`.edit`/`.submit`
remain strictly department-owner-scoped (§9's "the creator cannot review
their own Demand" holds regardless).

Default role grants: `CEO` — `demand.review` + `demand.approve` +
`procurement.pricing` (plus `demand.all_departments`, unchanged from
Checkpoint 2). `SITE_MANAGER`, `UPPER_MANAGEMENT` — `demand.review` only.
`ADMIN` holds none of these three by default. No role holds
`demand.approve` by default except CEO — no CFO role exists in ESDMS;
Formal Approval authority is delegated to a specific Upper Management
user via the existing per-user GRANT mechanism, exactly like
`users.create_um`/`manage_um`. CEO is also the only default
`procurement.pricing` holder; actual Procurement staff receive an explicit
per-user GRANT. System administration does not imply Procurement authority,
and this checkpoint does not invent a PROCUREMENT global role
(`docs/DECISIONS.md`).

A single ordinary (non-CEO) user cannot record both the Management Review
and the Formal Approval decision on the same Demand, even if individually
granted both capabilities — enforced under the same row lock as the
decision itself, not just by which capabilities happen to be assigned.
CEO is a deliberate, documented exception (§9).

**Implemented (Checkpoint 4):**

| Capability | Grants | Scope shape |
|---|---|---|
| `procurement.pricing` | List READY_FOR_PRICING work; create/edit/submit estimated pricing; view pricing being worked | Site-wide |
| `procurement.view_prices` | View submitted estimated pricing without edit authority | Site-wide |

`procurement.pricing` remains CEO-only by default; actual Procurement staff
receive an explicit per-user GRANT. `procurement.view_prices` defaults to
CEO, `UPPER_MANAGEMENT`, and `SITE_MANAGER`. A pricing holder can see the
pricing they are responsible for without a redundant view grant. ADMIN,
TEAM_LEAD, EMPLOYEE, HR, and GATE_GUARD receive neither financial
capability by default. An individual DENY wins. Capabilities remain
separate from scope: same-site access is cross-department; only CEO or a
separately effective `demand.all_departments` grant reaches other sites.

**Checkpoint 5 reuses existing capabilities:**

| Final responsibility | Required effective capabilities | Scope shape |
|---|---|---|
| Final Management Review | `demand.review` + `procurement.view_prices` | Site-wide |
| Final Formal/CFO Approval | `demand.approve` + `procurement.view_prices` | Site-wide |

No `demand.final_*` capability and no CFO role was introduced. Upper
Management still does not receive `demand.approve` by role. A real CFO/
financial approver receives explicit `demand.approve` and
`procurement.view_prices` GRANTs plus the appropriate scope. ADMIN receives
none merely from its role. CEO retains the documented scope and same-actor
exception. Holding an action capability without price-view cannot inspect
or decide confidential pricing.

**Implemented (Checkpoints 6-8):**

| Capability | Grants | Default role grants |
|---|---|---|
| `ipo.view` | View IPO records operationally — carries NO price visibility | CEO, UPPER_MANAGEMENT, SITE_MANAGER, TEAM_LEAD, ADMIN |
| `ipo.cancel` | Cancel an IPO, preserving its number and history | CEO only |
| `procurement.purchase` | Record actual purchasing and view actual prices | CEO only (per-user GRANT for Procurement staff) |
| `dc.view` | View Delivery Challans (no pricing exists on one) | CEO, UPPER_MANAGEMENT, SITE_MANAGER, ADMIN, TEAM_LEAD, EMPLOYEE |
| `dc.manage` | Create / edit / finalize / cancel Delivery Challans | CEO only (per-user GRANT for Procurement staff) |
| `receiving.view` | View deliveries and receipts in scope | CEO, ADMIN, SITE_MANAGER, UPPER_MANAGEMENT, TEAM_LEAD, EMPLOYEE |
| `receiving.receive` | Record receipt of the actor's OWN department's material | CEO, TEAM_LEAD, EMPLOYEE |
| `receiving.fallback_receive` | Take temporary Admin custody of another department's material at the actor's own site | CEO, ADMIN |
| `receiving.confirm` | Confirm and close a department receiving cycle | CEO, TEAM_LEAD, SITE_MANAGER |
| `procurement.export` | Export permitted Demand/IPO/DC/Receiving history to Excel | CEO, UPPER_MANAGEMENT, SITE_MANAGER, ADMIN, TEAM_LEAD |

HR and GATE_GUARD receive none of these. Note the deliberate splits:

- **`ipo.view` is not price authority.** A Team Lead can follow their own
  department's IPO operationally and still never see an amount; the IPO PDF
  additionally requires `procurement.view_prices` / `procurement.purchase` /
  `procurement.pricing`, so the document cannot be used as a price-leak
  bypass.
- **ADMIN holds `receiving.fallback_receive` but NOT `receiving.receive`.**
  Temporary custody is a distinct, explicitly granted authority; ordinary
  department receiving never crosses a department boundary.
- **EMPLOYEE holds `receiving.receive` but NOT `receiving.confirm`.** Any
  appropriate department member may receive; only the Team Lead closes.
- **`procurement.purchase` and `dc.manage` are CEO-only by default**, exactly
  like `procurement.pricing` — no PROCUREMENT global role was invented.

**Record scope** for the whole chain is resolved by one shared helper
(`shared/authorization/supply-chain-scope.js`) using the same three tiers
Material Demand established: ALL (CEO / `demand.all_departments`), SITE (a
cross-department responsibility holder), OWN (an ordinary department actor).
Action capability and record scope remain separate at every tier: holding
`receiving.receive` says the actor may record a receipt, never whose
material. An out-of-scope id is reported identically to a nonexistent one.

**Target for later checkpoints:**

- Cross-department/all-site visibility: always an explicit capability,
  never implied by role or by organizational Position.
- IPO numbering configuration UI (the settings table exists and is
  authoritative; there is no admin screen for it yet).

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

**Implemented (Checkpoints 6-8):** `backend/test/ipo-purchasing.test.js`
(exactly-once generation, numbering concurrency, immutable snapshot,
partial purchasing, over-purchase rejection, cancellation, previous-price
lookup, carry-forward, capability/DENY and department/site isolation, PDF
price gating); `backend/test/delivery-challan.test.js` (allocation bounds,
no double allocation, concurrent creation, finalized immutability,
capability/scope, commercial-free document, Gate Pass independence);
`backend/test/receiving.test.js` (department direct receipt with no Admin
involvement, cross-department and cross-site denial, Admin fallback custody
and department-acknowledged handover, immutable original receiver, partial
receipt, over-receipt denial, concurrent receivers, discrepancy routing,
replay safety, closure rules, absence of any inventory table);
`backend/test/demand-line-disposition.test.js` (exclusion without deletion,
frozen-after-decision determinism, capability intersection, redaction,
carry-forward); `backend/test/procurement-documents.test.js` (numbering
format and filename safety, durable document job, disabled-WhatsApp
non-blocking, caption confidentiality, cancelled-document voiding,
end-to-end closure, deadlock-free concurrent closure);
`backend/test/procurement-exports.test.js` (real .xlsx, price redaction,
commercial-dataset refusal, scope/filters, formula injection, cell types,
audit); `backend/test/procurement-security-sweep.test.js` (adversarial
cross-surface leak sweep, forgery, append-only audit);
`backend/test/price-comparison.test.js` (exact decimal arithmetic).

**Implemented (Checkpoints 1-5):** `backend/test/material-catalog-department-scope.test.js`
(Checkpoint 1); `backend/test/material-demand-department-scope.test.js`
(Checkpoint 2 — department isolation, site isolation, capability/DENY-wins
checks, and Draft-integrity checks together);
`backend/test/material-demand-approval.test.js` (Checkpoint 3 — capability
separation between `demand.review`/`demand.approve`, site-scoped review
authority, the same-actor-both-slots guard and its CEO exception, gate
completion in both orders, concurrent-approval race safety, rejection
history preservation, revision binding, and the capability-driven
recipient resolver's GRANT/DENY/inactive/site/dedup behavior);
`backend/test/procurement-pricing.test.js` (Checkpoint 4 — financial
confidentiality, capability/scope, exact totals, line/revision validation,
replay/concurrency, notification eligibility, and direct-DB immutability);
`backend/test/material-demand-final-approval.test.js` (Checkpoint 5 —
stage/version binding, capability intersection, same-actor/CEO governance,
rejection/repricing history, versioned notifications, concurrency/replay,
reason redaction, and database immutability/binding).

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
pattern). Demand submission, initial-gate completion, each versioned Pricing
submission, and final rejection/repricing notification are implemented.
IPO/purchasing/receiving events below remain target design:

```text
DEMAND SUBMITTED                       → notify eligible reviewers + approvers
INITIAL REQUIRED APPROVALS COMPLETE    → notify Procurement: READY FOR PRICING
PROCUREMENT PRICING SUBMITTED          → notify UM + CFO: FINAL APPROVAL REQUIRED
FINAL APPROVAL COMPLETE                → READY_FOR_IPO (implemented boundary;
                                          no IPO generation yet)
PURCHASING / DC FINALIZED              → notify relevant department/TL as appropriate
DIRECT DEPARTMENT RECEIPT              → notify Team Lead: CONFIRM RECEIPT
ADMIN TEMPORARY RECEIPT                → notify department/TL: HANDOVER PENDING
HANDOVER COMPLETED                     → notify Team Lead: CONFIRM COMPLETION
DISCREPANCY / REJECTION                → notify responsible Department + Procurement
                                          + required management authority
```

**Implementation note (Checkpoint 3 — supersedes Checkpoint 2's
role+site mechanism).** Both notification events above are routed by
`src/shared/notifications/recipient-resolver.js#resolveEligibleRecipients`
(§8, §10, §26, `docs/SECURITY.md` §11) — one `IN_APP` row per real,
currently-eligible active user (effective capability holder, correct
site/CEO scope), not one row per role name. **This resolves Checkpoint
2's previously documented CEO cross-site gap**: CEO is always eligible
regardless of site (checked directly, not via a site-matched recipient
row), so a CEO account is notified about every Demand company-wide
without depending on which site happens to match their own `site_id`.
Recipient-specific idempotency keys
(`demand:{id}:rev:{revision}:initial-review:{userId}` and
`...:ready-for-pricing:{userId}`) prevent a replayed transition from
duplicating any individual recipient's notification, and deduplicate a
user eligible through more than one capability to exactly one row.

Checkpoint 5 intersects the resolver results for `demand.review` or
`demand.approve` with `procurement.view_prices`. Keys include the exact
Pricing version: `...:pricing:{version}:final-review:{userId}`. Rejection
uses `...:pricing:{version}:repricing-required:{userId}` for eligible
Procurement users. Thus Version 1 cannot suppress Version 2 notifications.
A replayed pricing submission remains a successful no-op after the first
transaction commits.

Idempotency/uniqueness (the existing `notification_outbox` idempotency-key
pattern, plus stage/version-aware partial unique indexes on
`material_demand_approvals`) prevents duplicate decisions or notifications.
There is no IPO to duplicate in Checkpoint 5.

---

## 30. State Machine Design

Separate bounded state machines per domain (not one cross-domain status
field), each following the existing Gate Pass pattern: lock the row,
validate the transition against an explicit allowed-transition table,
apply, audit — all in one transaction.

**Demand** (implemented through `READY_FOR_IPO`):
```text
DRAFT → PENDING_INITIAL_REVIEW → READY_FOR_PRICING → PENDING_FINAL_APPROVAL
                                               ├─ both FINAL approved → READY_FOR_IPO
                                               └─ either rejected → PRICING_REVISION_REQUIRED
                                                    → READY_FOR_PRICING (new Pricing version)
```
plus initial-stage `REJECTED`. `CANCELLED`, official IPO, and Demand
reopen/revision remain unimplemented. The implemented `submit`
transition follows the exact lock-then-validate-then-transition-then-audit
pattern this section describes:
`backend/src/modules/material-demand/material-demand.service.js` locks
the row, checks `definition.from.includes(status)`, checks line count,
updates status + `submitted_at`, writes one audit row, and enqueues the
notification — all inside one transaction. `READY_FOR_PRICING`/`REJECTED`
are not plain declarative `TRANSITIONS` entries (they depend on *two*
independent approval records, not a single action) — the same
service's `recordApprovalDecision` locks the row, validates status +
scope, enforces the slot-already-filled and same-actor-both-slots guards,
inserts the immutable approval record, writes its own audit row, and only
then evaluates whether both slots are `APPROVED` (→ transition + a second
audit row + Procurement notification, all still in the one transaction) or
either is `REJECTED` (→ immediate transition, no further evaluation
needed).

**IPO** (unimplemented indicative target): `GENERATED → ACKNOWLEDGED → PURCHASING →
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
with an explicit status-specific notice; Edit/Submit actions only while
`DRAFT`). Reachable via a capability-gated "Demands" nav item.

**Implemented (Checkpoint 3):** the Initial Approval panel on
`DemandDetailPage.jsx` (`components/ApprovalPanel.jsx`) — two independent
slots (Management Review, Formal Approval), each showing either its
recorded decision (decider name, timestamp, reason if rejected) or
"Pending" with Approve/Reject actions for an eligible pending
reviewer/approver only. Approve reuses `ConfirmActionDialog`; Reject
reuses `ReasonActionDialog` (both existing shared components, no new
dialog primitive). Partial progress is always visible — one slot decided
and one pending is never presented as if the whole Demand were approved.
Checkpoint 3 itself added no pricing, IPO, Delivery Challan, or Receiving
UI; its `READY_FOR_PRICING` notice was the handoff point later completed
by Checkpoint 4 below.

**Implemented (Checkpoint 4):** capability-gated Procurement navigation,
the server-paginated Ready for Pricing queue, and a Procurement Pricing
page with exact Demand lines, read-only quantity/UOM, draft save, optional
notes, display-only totals, completeness gating, submit, and submitted
read-only state. Authorized management sees submitted pricing through a
reusable protected summary on Demand Detail. Users without financial
authority do not mount the pricing request or receive pricing data. No
final approval actions are shown.

**Implemented (Checkpoint 5):** a protected Final Pricing Approval panel
shows the exact Pricing version, quantities/UOM, prices/totals, submission
context, and independent Management/Formal progress. Only the actor's
permitted responsibility is actionable; rejection requires an internal
reason. Procurement sees repricing-required work, explicitly creates the
next version, edits only the current DRAFT, and can inspect older submitted
versions read-only. Operational users see status only and do not mount the
pricing request without financial permission.

**Target for later checkpoints:** Department — Receiving/Pending
Confirmation. Procurement — Ready for Purchase, IPO Detail, Purchase
Progress, Delivery Challan. Management — future IPO/purchasing views.
Receiving — Receive DC, Pending Department Handover, Pending TL
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

## 34. Reporting and History — **Implemented (Checkpoint 8)**

`GET /ipos/:id` returns the whole traceable chain in one call — the IPO, its
lines with every distinct quantity, its Delivery Challans, every receipt
(including temporary Admin custody, handover recipient and confirmation),
and the ordered `procurement_audit_log` stream — so the history view never
stitches four endpoints together. `GET /demands/:id` links to its IPO and
returns line dispositions. The frontend Procurement History page filters by
reference/status/date and links Demand → IPO → DC → Receipt.

Financial values in all of the above remain permission-redacted.

### Historical target text



No full reporting engine is built in V1, but data is structured so future
reports can answer: demands by department; demand status/history; approved
quantities; IPO references; purchase completion; DC references; received
quantities; receiver; Admin temporary receipt/handover; department
confirmation; unresolved discrepancies. Received totals are never labeled
as current stock (§24).

---

## 35. Formal PDF Documents — **Implemented (Checkpoint 8)**

Three backend-generated PDFs exist: **Demand List** (`GET /demands/:id/pdf`),
**IPO** (`GET /ipos/:id/pdf`) and **Delivery Challan**
(`GET /delivery-challans/:id/pdf`). All are rendered server-side from
authoritative persisted data; no client-supplied document content is ever
trusted, and no document is served from a public or guessable path.

Layout lives in replaceable templates over one shared primitive layer
(`shared/documents/pdf-layout.js`): `ipo.pdf.js` follows the authentic E-Set
Internal Purchase Order structure (FROM/TO, IPO # and date, Demand
reference, budget, Sr#/Item/Qty/UOM/Unit Price/Total Price, grand total,
management and Procurement signature blocks, company footer, system-
generated note); `delivery-challan.pdf.js` follows the modern E-Set Delivery
Challan (FROM/TO, date, IPO reference, subject, Sr#/Item/Quantity/UOM,
delivery confirmation statement, two representative signatures). Fields the
real samples show but ESDMS has no authoritative source for yet (Inquiry #,
Ref. CPO #, Fulfil By, per-item Brand/Specs) are rendered from real data
where it exists and left blank otherwise — never invented to fill a
template. Replacing a template changes no schema, no workflow and no
document identity. Gate Pass keeps its own bespoke QR layout untouched.

**Historical stability (§37/§42).** A finalized IPO/DC has its rendered
bytes stored in `procurement_documents` (append-only, one row per document).
Downloads serve the stored copy, so a later template change or master-data
rename cannot restate a document that was already issued and shared;
on-demand rendering is only the fallback in the window before the generation
job has run.

**Authorization is re-checked on every single download**, never assumed from
a URL:

- Demand List PDF: `demand.view`/`review`/`approve` plus the same
  `assertDemandViewable` scope rule the detail endpoint uses. It carries **no
  pricing for any viewer at all**, including CEO — one unpriced
  representation removes the possibility of this endpoint becoming a
  financial-authorization bypass, and the priced document already exists as
  the IPO PDF.
- IPO PDF: `ipo.view` plus commercial authority. A Team Lead or ADMIN with
  operational IPO visibility is refused (403).
- Delivery Challan PDF: `dc.view` — it contains no commercial data by
  schema, so a department receiver can obtain it with no price capability.
- Gate Guard is refused all three.
- Cross-department and cross-site ids are refused identically to
  nonexistent ones.

### Historical target text



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

## 36. Excel / Historical Data Export — **Implemented (Checkpoint 8)**

Real `.xlsx` workbooks via ExcelJS (never a renamed CSV — asserted by
loading the result with a real spreadsheet reader in test). Six datasets at
`GET /api/v1/reports/procurement/:datasetKey.xlsx`, plus a `/catalog`
endpoint so the UI only ever offers what the backend would actually serve:
`demand-history`, `ipo-history`, `procurement-history`,
`delivery-challan-history`, `receiving-history`, `traceability`.

Filters (`from`, `to`, `siteId`, `departmentId`, `status`, `reference`) are
applied server-side in SQL over a scoped query — the browser never receives
an unfiltered dataset to narrow itself.

**Export authority never widens data authority.** `procurement.export` only
means "may take out what you can already see". Every commercial column is
gated again on `procurement.view_prices` / `procurement.purchase` /
`procurement.pricing`, and — critically — redaction is a QUERY-PROJECTION
decision: an unauthorized export never SELECTs a price column at all, so
there is no window in which price data exists in the process and is merely
hidden. `procurement-history` is inherently commercial and is refused
outright (403) without price authority rather than served as an empty shell.
Gate Guard and EMPLOYEE hold no export capability; an individual DENY wins.

Formula injection is neutralized through the existing
`shared/reports/excel-safety.js#sanitizeCell` for every user-controllable
string, while numeric and date cells keep their real types (with explicit
number formats) rather than becoming text. Filenames come from
`safeExportFilename`. Every export writes a `PROCUREMENT_EXPORT_GENERATED`
row to the append-only governance audit log recording the dataset, row
count, whether pricing was included, and the exact filters applied.

### Historical target text



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
- A dedicated log-management UI (§37) — the platform invariant is
  documented now; UI/endpoints are introduced only when a checkpoint
  actually needs them. No Procurement/Receiving endpoint can modify or
  delete history: `procurement_audit_log` and `material_receipt_lines` are
  append-only at the database level, and issued IPO/DC/document rows cannot
  be deleted at all — for every role, Upper Management included.
- An admin UI for IPO/DC numbering configuration (§15) — the settings table
  is authoritative and changing it cannot restate an already-issued number,
  but there is no screen for it yet.
- Structured supplier/vendor master data, RFQ/quotation comparison, and
  per-item Brand/Specs on printed documents — no authoritative source exists
  in ESDMS yet, so those fields are left blank rather than invented (§35).
