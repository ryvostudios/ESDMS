# Create / Add Inverse-Action Audit

This is the authoritative lifecycle map for management surfaces. “Inverse” means the safest business reversal; it does not imply hard deletion. Consequential actions require confirmation in the UI and server-side permission/scope enforcement.

| Entity | Create/add action | Supported inverse | Integrity rule |
| --- | --- | --- | --- |
| Employee | Add / edit / transfer | Deactivate / reactivate | Never hard-delete employment history; linked elevated accounts must be handled explicitly. |
| Department | Add / edit | Archive / reactivate | Archive is blocked while current employee assignments exist. Department names never grant application authority. |
| Position | Add / edit | Archive / reactivate | Archive is blocked while current employee assignments exist. Position names never grant application authority. |
| Employment Type | Add / edit | Archive / reactivate | Archive is blocked while active employees use it. |
| Document Type | Add / edit | Archive / reactivate | Existing employee documents retain their type/history. |
| Leave Type | Add / edit | Archive / reactivate | Existing leave records remain unchanged. |
| Company Item | Add / edit safe metadata | Archive / reactivate | Global archive is blocked until every department catalog relationship is inactive. Historical Demand lines use immutable name/UOM snapshots. Duplicate merge is not automated because identity equivalence requires a business decision. |
| Department Material Catalog | Add / edit default UOM | Remove from Catalog / Restore to Catalog | Removal archives only the department relationship. It hides the item from new Demand selection and never deletes the Company Item or historical Demand data. |
| User | Create / link | Deactivate / reactivate | No destructive deletion; role/capabilities are independent from HR Department and Position. |
| Demand | Create Draft | Protected Delete Draft | Only an eligible untouched Draft may be deleted. Submitted/historical Demands are immutable lifecycle records. |
| IPO | Generate | Cancel where lifecycle permits | Cancellation is separate authority and is blocked after purchasing/downstream history requires closure instead. |
| Delivery Challan | Create | Cancel where lifecycle permits | Completed or received Challans cannot be cancelled; numbering/history remains consumed. |
| Contract | Create Draft / finalize / amend | Supersede with amendment/new contract | A finalized Contract is never deleted or rewritten. |
| Employee Document | Upload / request | Supersede with a new version; cancel pending request | Uploaded evidence/history is retained; no casual destructive delete. |
| Gate Pass | Create Draft | Cancel where lifecycle permits | Approved/used history and evidence are retained. |
| Receipt / audit / history | Record | No removal allowed | Append-only or protected historical record. |
| Driver | Add / edit | Deactivate / reactivate | No hard delete after Gate Pass use; Gate Pass keeps a snapshot. |
| Vehicle | Add / edit | Deactivate / reactivate | No hard delete after Gate Pass use; Gate Pass keeps a snapshot. |

Company Item reactivation deliberately does not reactivate department catalog relationships. Each department relationship is restored separately so a global operation cannot silently republish materials into new Demand pickers.
