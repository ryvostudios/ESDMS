# AGENTS.md

# E-Set Digital Management System
## Instructions for AI-Assisted Development

This file defines mandatory rules for AI coding agents working on the E-Set Digital Management System.

These instructions apply to the entire repository unless a more specific documented rule exists for a particular module.

---

## 1. Core Principle

Do not treat chat history as the authoritative source for exact implementation details.

Before making substantial changes, inspect the current repository.

The current codebase, database migrations, configuration and repository documentation are the primary technical source of truth.

Never assume that remembered code, filenames, routes, database columns, APIs or dependency versions still exist unchanged.

---

## 2. Read Before Changing

Before substantial implementation, inspect the relevant current files.

Depending on the task, this may include:

- `README.md`
- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/MODULES.md`
- `docs/DECISIONS.md`
- relevant module specification
- relevant source files
- database schema and migrations
- tests
- configuration files

Do not change business workflow based only on assumptions.

If a requirement is uncertain, identify the uncertainty instead of silently inventing company policy.

---

## 3. Priority Order

When technical concerns conflict, prioritize:

1. Security
2. Data integrity
3. Authorization and isolation
4. Maintainability
5. Module independence
6. Auditability
7. Reliability
8. Testing
9. Simple user experience
10. Development speed

Development speed must never justify weakening security or data integrity.

---

## 4. Work in Small Changes

Do not attempt to build an entire module in one large change.

Break implementation into small, understandable and testable steps.

For each meaningful change:

1. inspect the current implementation,
2. understand the requirement,
3. identify affected components,
4. consider security implications,
5. implement the smallest justified change,
6. test it,
7. review the diff,
8. update documentation when necessary,
9. create a clean Git checkpoint when appropriate.

Avoid unrelated refactoring during focused changes.

---

## 5. Never Disable Security to Fix a Bug

Do not solve development problems by:

- bypassing authentication,
- bypassing authorization,
- disabling validation,
- allowing unrestricted CORS,
- making private storage public,
- committing credentials,
- exposing internal stack traces,
- granting unnecessary database privileges,
- accepting arbitrary uploads,
- weakening security middleware.

Diagnose the actual problem and fix its cause.

---

## 6. Secrets

Never commit:

- passwords,
- database credentials,
- JWT/session secrets,
- API keys,
- access tokens,
- refresh tokens,
- private keys,
- storage credentials,
- production `.env` files,
- sensitive QR/token values,
- real company database dumps.

Secrets belong in ignored environment files or approved secret-management systems.

`.env.example` files may contain variable names and safe placeholders only.

Frontend environment variables must never contain server secrets.

---

## 7. Backend Is the Security Boundary

Frontend visibility is not authorization.

Sensitive permissions and business rules must always be enforced server-side.

Never rely only on:

- hidden buttons,
- disabled controls,
- frontend route guards,
- frontend validation,
- client-provided status values.

Every protected backend operation must verify the authenticated user and required authorization.

---

## 8. Input Validation

Treat all external input as untrusted.

Validate relevant input on the backend, including:

- request bodies,
- URL parameters,
- query parameters,
- IDs,
- statuses,
- dates,
- pagination values,
- odometer readings,
- remarks,
- filenames,
- MIME types,
- uploaded files,
- search/filter values.

Frontend validation may improve user experience but never replaces backend validation.

---

## 9. Error Handling

Do not expose sensitive internal information to end users.

Production API responses must not reveal:

- stack traces,
- SQL errors,
- database structure,
- internal filesystem paths,
- credentials,
- secret configuration.

Use centralized backend error handling.

Log only information appropriate for secure diagnostics.

---

## 10. Dependencies

Before adding a dependency:

1. determine whether existing platform functionality already solves the problem,
2. explain why the dependency is required,
3. prefer established and maintained packages,
4. consider security and maintenance implications,
5. avoid unnecessary dependencies.

Do not change package versions randomly to make an error disappear.

---

## 11. Module Boundaries

Business-specific logic belongs inside its module.

Expected structure:

```text
backend/src/modules/<module>/
frontend/src/modules/<module>/