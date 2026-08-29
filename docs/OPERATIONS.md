# Operations

## Database release

Use the one authoritative release sequence in `DEPLOYMENT.md`. Do not run only
the migrations and then start the API: schema compatibility does not prove that
the runtime role can serve requests. `npm run db:release` must complete before
traffic is enabled, followed by `/api/v1/health/ready` and login/`/me` smoke
checks.

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
