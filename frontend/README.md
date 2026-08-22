# E-Set Digital Management System — Frontend

React + Vite Progressive Web App for the Gate Pass module. See the
repository root `README.md` and `docs/` for the wider project.

## Setup

```bash
cp .env.example .env   # set VITE_API_URL to the backend's /api/v1 base
npm install
npm run dev
```

## Scripts

- `npm run dev` — dev server with HMR
- `npm run build` — production build (also generates the PWA service worker)
- `npm run preview` — serve the production build locally
- `npm run lint` — ESLint
- `npm test` — Vitest + Testing Library (`vitest.config.js`)

## Structure

- `src/app/` — routing, layout, app shell
- `src/core/` — auth context, API client, environment config (cross-module)
- `src/modules/<module>/` — one directory per business module (currently
  `gate-pass`, `guard`, `auth`), each with its own `pages/`, `components/`,
  `api.js`
- `src/shared/` — design-system components, hooks, and utilities used
  across modules

## Auth

The app authenticates via an HttpOnly session cookie the backend sets on
login (`credentials: "include"` on every request) — this client never
stores or attaches a token itself. See `docs/DECISIONS.md` in the repo
root.
