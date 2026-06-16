# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / Test / Lint

- **Run all tests:** `npm test` (Node built-in test runner — `node:test`, not Jest/Vitest)
- **Run a single test file:** `node --test tests/<file>.test.js`
- **Run a specific test by name:** `node --test --test-name-pattern "pattern" tests/<file>.test.js`
- **Playwright E2E tests:** `npx playwright test` (tests in `playwright-tests/`)
- **Syntax check:** `node --check app.js`
- **Start app:** `npm start` (requires Slack tokens in `.env`)
- **Run migrations:** `npm run migrate`
- **Notifications CLI:** `npm run notifications:test`
- **No linter/formatter configured**

## Project Architecture

This is a Slack Bolt interview scheduling app using **Socket Mode** (no HTTP endpoints for Slack). It integrates JazzHR (applicant data), Google Calendar (free/busy + event creation), and Gmail (candidate messaging).

- **Entry point:** `app.js` — loads config, creates store, registers Slack handlers, starts HTTP health server + notification worker
- **Store:** `src/store/index.js` selects JSON file store (`data/runtime/state.json`) or Postgres based on whether `DATABASE_URL` is set. Both implement the same interface.
- **Slack:** `src/slack/handlers.js` is the central handler registry (actions, views, commands, events). `src/slack/views.js` builds all Block Kit UI.
- **Scheduling pipeline:** `src/workflow/scheduler.js` — 5-step pipeline: generate candidate time slots → filter business hours → check calendar free/busy → rank by conflicts → present options
- **Reschedule:** `src/workflow/reschedule.js` — state machine (`none → requested → approved → completed` / `cancelled`)
- **Notifications:** `src/workflow/notifications.js` — polling worker for automated candidate reminders, completion reminders, and feedback requests
- **Config:** `src/config.js` — loads `.env` file, validates required vars at startup
- **HTTP server:** `src/http-server.js` — health endpoint (`/health`) and Google OAuth callback (`/oauth/google/callback`)
- **Slash commands:** `/schedule-interview` (opens intake modal or posts channel launcher), `/slack-scheduler` (admin: `refresh-jazz`)

## Key Non-Obvious Patterns

- **ESM-only** (`"type": "module"` in package.json) — all imports use `import`/`export`, no `require()` except `index.cjs` (legacy scratch file)
- **`node:assert/strict`** for tests, **`node:test`** for runner, **`structuredClone()`** for state copying, **`crypto.randomUUID()`** for IDs, **`fetch()`** for HTTP, **`Intl.DateTimeFormat`** for timezone-aware dates
- **No semicolons** — consistently omitted throughout
- **Dual store interface** — both `json-store.js` and `postgres-store.js` export identical method signatures (`createCase`, `updateCase`, `getCase`, `listCases`, `saveGoogleToken`, etc.). New store methods must be added to both.
- **Google/Gmail/JazzHR services safely mock** when credentials are absent — all API calls return `{ mocked: true, ... }` instead of throwing
- **Google OAuth tokens encrypted** with `APP_ENCRYPTION_KEY` using AES-256-GCM before storage at rest (`src/security/crypto.js`)
- **Logger auto-redacts** email addresses and phone numbers from all log output (`src/logger.js:4`)
- **Email templates** are plain text files in `email-templates/` with `Subject:` / `Body:` headers, parsed by `src/templates.js`. Variables use `[bracket_notation]` (not `{{mustache}}`)
- **Mojibake normalization** built into template parsing for copy-pasted emoji/Unicode corruption (`src/templates.js:44`)
- **Timezones:** Business hours default to Sydney (`Australia/Sydney`, 07:00-16:00), calendar events default to Philippines (`Asia/Manila`)
- **In-memory cache** (`src/data/cache.js`) holds applicants, recruiters, hiring managers, slack users, and role assignments loaded at startup
- **`camelCase`** for JS identifiers, **`snake_case`** for Postgres column names (mapped in `src/store/postgres-store.js`)
- **`emailTestMode`** — when enabled, Gmail sends go only to `EMAIL_TEST_RECIPIENT` and Calendar attendee update emails are suppressed
- **Sample data** in `src/data/sample-data.js` is the default when JazzHR is unreachable
- **Resume handling is intentionally manual** — no automated upload/storage
- **Error logging** uses structured event names (e.g., `logger.warn('calendar_freebusy_mocked', { ... })`)
- **Postgres migrations** in `migrations/` are plain SQL, run via `node scripts/migrate.js`
- **Docker Compose** stack: app + Postgres 16 + Caddy reverse proxy, with a separate `migrate` service that runs migrations then exits
