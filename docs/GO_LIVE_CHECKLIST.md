# Go-live checklist

Tick each item during the first company production deployment. Details:
[PRODUCTION_RUNBOOK.md](./PRODUCTION_RUNBOOK.md) and
[PRODUCTION_ENVIRONMENT.md](./PRODUCTION_ENVIRONMENT.md).
Never write secret values on this list.

## Ownership
- [ ] Company GitHub `E-SET-DIGITAL/esdms`; approved commit recorded
- [ ] Company Supabase organization; new dedicated ESDMS project (not the Permit System)
- [ ] Company Render workspace; new services (not `esdms-api-test` / `esdms-app-test`)
- [ ] Company DNS control for the chosen domain
- [ ] Secrets stored in the company password manager

## Database
- [ ] Production plan and region chosen; backups enabled
- [ ] `npm run db:release` succeeded from the operator machine
- [ ] 47/47 migrations applied
- [ ] `esdms_runtime` verified by the release (grants, RLS, provisioning marker)
- [ ] Migration credentials are **not** in the Render API environment

## Security
- [ ] API `DATABASE_URL` uses `esdms_runtime` only
- [ ] Fresh `JWT_SECRET` (≥32 chars); no values reused from demo/QA
- [ ] `SUPABASE_SERVICE_ROLE_KEY` only in the API environment; no secrets in `VITE_*`
- [ ] WhatsApp disabled (`WHATSAPP_ENABLED=false`); Google Drive unset
- [ ] No personal or QA OAuth connections, tokens or accounts

## Backend
- [ ] Web service from `backend/`, `npm ci` / `npm start`, health check `/api/v1/health/ready`
- [ ] Paid always-on plan; auto-deploy off; no pre-deploy migrations
- [ ] Environment variables per PRODUCTION_ENVIRONMENT.md §3
- [ ] `/api/v1/health` ok; `/api/v1/health/ready` ready, 47/47, no problems

## Frontend
- [ ] Static site from `frontend/`, `npm ci && npm run build`, publish `dist`
- [ ] `VITE_API_URL` = frontend origin + `/api/v1`
- [ ] Rewrites: `/api/v1/*` → API; `/*` → `/index.html`

## Domain/TLS
- [ ] `app.<domain>` and `api.<domain>` on the same registrable domain
- [ ] HTTPS certificates active on both
- [ ] `FRONTEND_ORIGIN`, `APP_PUBLIC_URL`, `API_PUBLIC_URL` set; `COOKIE_DOMAIN` unset
- [ ] Login cookie is `Secure; HttpOnly; SameSite=Lax`; no CORS errors
- [ ] `TRUST_PROXY_HOPS` set and client IPs confirmed behind the proxy

## CEO
- [ ] Permanent CEO created with `npm run user:create-ceo` (hidden password prompt)
- [ ] `ESDMS_ORIGINAL_CEO_EMAIL` recorded in the secure operations record
- [ ] CEO signed in; password set by the CEO (or changed at `/change-password`)
- [ ] CEO protection confirmed in Users & Access

## CMS/branding
- [ ] Issuer name decided and set (legal name vs "E-Set Engineering Services")
- [ ] Real E-Set logo uploaded (tightly cropped PNG/JPEG) if not using the default
- [ ] Company contact details set (optional)
- [ ] Unused seeded departments deactivated; positions reviewed
- [ ] Real staff added through Employees; roles and bundles assigned

## Storage
- [ ] Private Supabase bucket created; `STORAGE_PROVIDER=supabase`
- [ ] New file written and downloaded by an authorized user; unauthorized access denied
- [ ] Company Dropbox deferred (or connected later via CMS → Integrations)

## Smoke test
- [ ] Auth, system, workforce, Demand→IPO→DC→receiving, Gate Pass, documents, storage (runbook §3)
- [ ] Smoke-test data handled per the approved policy

## Backup
- [ ] Database backup confirmed; logical dump taken and stored securely
- [ ] Storage bucket backed up separately
- [ ] Restore rehearsed into an isolated environment and result recorded

## Handover
- [ ] HANDOVER.md, PRODUCTION_RUNBOOK.md and this checklist handed to company IT
- [ ] Production accepted and signed off

## Legacy cleanup (after acceptance only)
- [ ] Retire Render `esdms-api-test` / `esdms-app-test`
- [ ] Retire Supabase `esdms-demo`
- [ ] Clean the local QA environment, personal Dropbox connection and QA files
