# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Build / Test / Lint

- **Run all tests:** `npm test` (uses Node's built-in test runner, not Jest/Vitest)
- **Run a single test file:** `node --test tests/<file>.test.js`
- **Run a specific test by name:** `node --test --test-name-pattern "pattern" tests/<file>.test.js`
- **Playwright E2E tests:** `npx playwright test` (tests in `playwright-tests/`)
- **Syntax check:** `node --check app.js`
- **Start app:** `npm start` (requires Slack tokens through process environment or `*_FILE` secret mounts; `.env` files are not loaded)
- **No linter/formatter configured** — no ESLint, Prettier, or equivalent

## Project Architecture (Non-Obvious)

- **ESM-only** (`"type": "module"` in package.json) — all imports use `import`/`export`, no `require()` except [`index.cjs`](index.cjs) (legacy Selenium scratch file, not part of the app)
- **Dual storage:** JSON file store at [`data/runtime/state.json`](data/runtime/state.json) is local/test-only; production uses Cloud SQL IAM configuration through [`src/store/index.js`](src/store/index.js)
- **Google/Gmail/JazzHR services are safely mocked** when credentials are absent — all API calls return `{ mocked: true, ... }` instead of throwing ([`src/services/google.js`](src/services/google.js:84))
- **Google OAuth tokens are encrypted** with Cloud KMS in production; local/test storage can use AES-256-GCM ([`src/security/token-cipher.js`](src/security/token-cipher.js))
- **Logger auto-redacts** email addresses and phone numbers from all log output ([`src/logger.js`](src/logger.js:4))
- **Email templates** are plain text files in [`email-templates/`](email-templates/) with `Subject:` / `Body:` headers, parsed by [`src/templates.js`](src/templates.js:59)
- **Template variables** use `[bracket_notation]` (not `{{mustache}}` or `${js}`) — see [`src/templates.js`](src/templates.js:96)
- **Mojibake normalization** is built into template parsing for copy-pasted emoji/Unicode corruption ([`src/templates.js`](src/templates.js:37))
- **Sample data** in [`src/data/sample-data.js`](src/data/sample-data.js) is the default — replace with real data before production
- **Resume handling is intentionally manual** — no automated upload/storage ([`docs/configuration.md`](docs/configuration.md:39))
- **Business hours default to Sydney timezone** (`Australia/Sydney`, 09:00-18:00) — see [`src/time.js`](src/time.js:2)
- **Calendar events default to Philippines timezone** (`Asia/Manila`) — see [`src/time.js`](src/time.js:1)

## Code Style (Discovered from Code, Not Config)

- **No semicolons** — project omits semicolons consistently
- **`node:assert/strict`** for tests (not `chai`, `jest`, or `node:assert`)
- **`node:test`** for test runner (not Jest, Mocha, or Vitest)
- **`node:` protocol** for Node built-in imports (e.g., `import path from 'node:path'`)
- **`camelCase`** for all identifiers, `snake_case` for Postgres column names (mapped in [`postgres-store.js`](src/store/postgres-store.js:44))
- **Error-first logging** with structured event names (e.g., `logger.warn('calendar_freebusy_mocked', { ... })`)
- **`structuredClone()`** used for state copying in JSON store
- **`crypto.randomUUID()`** for ID generation (not `uuid` package or `nanoid`)
- **`fetch()`** for HTTP calls (no `axios` or `got`)
- **`Intl.DateTimeFormat`** for timezone-aware date formatting (no `moment` or `date-fns`)
