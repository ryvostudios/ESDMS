# E-Set Digital Management System
## Security Requirements

## 1. Security Principle

Security is a system requirement, not a frontend feature.

The browser is an untrusted client.

Anything sent from React can potentially be:

- inspected,
- altered,
- replayed,
- automated,
- manually called,
- manipulated through browser developer tools.

The backend must independently verify sensitive operations.

---

## 2. Security Priority

When implementation choices conflict, prioritize:

1. Security
2. Data integrity
3. Authorization and isolation
4. Maintainability
5. Module independence
6. Auditability
7. Reliability
8. Testing
9. Simple UX
10. Development speed

Never weaken security simply to finish development faster.

---

## 3. Secrets

Never expose backend secrets to frontend JavaScript.

Examples of secrets that must remain server-side:

- database credentials,
- database URLs containing credentials,
- JWT/session signing secrets,
- private API keys,
- object-storage credentials,
- SMTP credentials,
- private keys,
- backend administrative credentials.

Actual `.env` files must not be committed.

Only safe `.env.example` templates may be committed.

Never log secrets.

---

## 4. Password Security

Passwords must never be stored in plaintext.

Use a reputable password-hashing implementation such as bcrypt/bcryptjs with an appropriate work factor.

Password-related rules:

- never log passwords,
- never return password hashes through APIs,
- never expose password hashes to the frontend,
- validate authentication inputs,
- rate-limit sensitive authentication endpoints.

---

## 5. Authentication

Authentication answers:

> Who is the user?

Authentication implementation must be server-controlled.

Before implementing authentication, explicitly decide the session/token architecture.

Preferred properties include:

- short-lived access authentication,
- secure HTTP-only cookies where appropriate,
- Secure cookies in production,
- SameSite protection,
- defined refresh/session behavior,
- logout/session revocation,
- token expiration,
- server-side verification.

Do not casually store long-lived bearer tokens in browser localStorage.

---

## 6. Authorization

Authorization answers:

> What is this authenticated user allowed to do?

Authorization must be enforced server-side.

Plan for:

- roles,
- departments,
- permissions,
- module access,
- action permissions,
- record/resource scope,
- ownership where applicable.

Do not scatter hard-coded authorization checks throughout controllers.

Use centralized authorization mechanisms where practical.

Frontend permission checks exist for user experience only.

---

## 7. Record-Level Authorization

Every protected record lookup must verify that the current user is authorized to access that record.

Changing an identifier must never allow access to another user's or department's data.

Example threat:

```text
/api/v1/gate-passes/123
must not become unauthorized access simply by changing it to:
/api/v1/gate-passes/124
```

Enforced in this codebase by `isWithinGatePassScope` (site check, then role-scoped department check) called from every service function that loads a Gate Pass by id — see `src/modules/gate-pass/gate-pass.authorization.js`.

---

## 8. Database Transport Security and Privilege Boundary

### 8.1 Transport (TLS)

The application must never connect to its production database over an unencrypted or unverified connection.

- In production (`NODE_ENV=production`), the runtime Postgres pool (`src/config/database.js`) requires TLS with certificate verification (`ssl: { rejectUnauthorized: true }`), not merely an encrypted-but-unverified connection.
- Local development connects to a local Postgres instance with no TLS, since `NODE_ENV` is not `production` there.
- The production Postgres instance itself must never be reachable on a public, unauthenticated port. When using Supabase, use its pooled/managed connection endpoint, not a raw exposed database port.

### 8.2 Privilege Boundary (Runtime vs. Migration)

The application must never run its normal request-handling workload as a database superuser or as a role that can alter schema, create/drop roles, or create databases. Two separate credentials are used:

- `MIGRATION_DATABASE_URL` — an owner-level role, used only to run `node-pg-migrate` (schema changes: `CREATE`/`ALTER`/`DROP TABLE`, etc.). Never used by the running API process.
- `DATABASE_URL` — the runtime role the API process actually connects as. Grants are limited to `SELECT`, `INSERT`, `UPDATE`, `DELETE` on application tables and `USAGE`/`SELECT` on sequences. It must not have `SUPERUSER`, `CREATEDB`, or `CREATEROLE`, and must not be able to `CREATE`/`ALTER`/`DROP` any table.

`scripts/provision-db-roles.sql` contains the exact `GRANT`/`REVOKE` statements to create and lock down the runtime role against a fresh schema. Run it once per environment, as the owner role, after migrations have created the schema. See `docs/DECISIONS.md` for the reasoning.