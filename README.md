# slack-schedule

FPI-OPG Slack Bolt app for scheduling interviews within slack and ensuring no conflict scheduling.

Slack-first workflow assistant for interview scheduling across JazzHR applicant data, Google Calendar, recruiter Gmail, and manual resume handling. Built on [Bolt for JavaScript](https://slack.dev/bolt-js/) with Socket Mode.

## Features

- **App Home dashboard** with "My Cases" and "Team Queue" views
- **Guided intake modal** — searchable applicant, recruiter, and hiring manager pickers
- **Scheduling pipeline** — generate candidate slots, check calendar availability, rank conflict-free times
- **Calendar event creation** via Google Calendar API with attendee invitations
- **Candidate messaging** — templated email sent via Gmail, pre-prepared SMS draft for manual sending
- **Reschedule workflow** — state machine with audit trail and schedule versioning
- **Interview stage rules** — configurable duration, buffer times, attendee inclusion per stage
- **Dual storage** — JSON file store for local dev, PostgreSQL for production
- **Safe mocking** — all Google/Gmail/JazzHR service calls return `{ mocked: true }` when credentials are absent

## Prerequisites

- **Node.js 20+**
- **Slack app** with Socket Mode enabled — use [`manifest.json`](manifest.json) to configure
- **Google Cloud project** (optional, for Calendar and Gmail) with OAuth 2.0 credentials
- **PostgreSQL** (optional, defaults to JSON file store)

## Quick Start

```sh
# Clone and install
git clone <repo-url>
cd slack-scheduler
npm install

# Copy and fill the environment file
cp .env.example .env

# Start (Socket Mode + HTTP health server)
npm start
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Slack Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | Slack App-Level Token for Socket Mode (`xapp-...`) |
| `JAZZHR_API_KEY` | No | JazzHR API key for applicant data |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | No | OAuth callback URL |
| `GOOGLE_SHARED_CALENDAR_ID` | No | Calendar ID for event creation |
| `APP_ENCRYPTION_KEY` | No | AES-256-GCM key for encrypting OAuth tokens at rest |
| `DATABASE_URL` | No | PostgreSQL connection string (falls back to JSON store) |

See [`.env.example`](.env.example) for a ready-to-copy template.

## Slack Setup

Use [`manifest.json`](manifest.json) to create or update your Slack app. Reinstall the app after changing scopes or enabling App Home.

Commands:
- `/schedule-interview` — open the intake modal
- `/schedule-interview button` — post a reusable channel launcher

## Architecture

```
app.js                         # Entry point
  -> src/config.js             # Env loading, defaults, validation
  -> src/store/index.js        # Store factory (JSON or Postgres)
  -> src/slack/handlers.js     # All Slack event/action/view handlers
  -> src/http-server.js        # Health endpoint + Google OAuth callback
  -> src/logger.js             # Structured JSON logging
```

Key modules:
- `src/slack/views.js` — Slack Block Kit UI builders (modals, home tab, messages)
- `src/workflow/scheduler.js` — 5-step scheduling pipeline
- `src/workflow/reschedule.js` — Reschedule state machine
- `src/workflow/stage-rules.js` — Per-stage interview configuration
- `src/services/google.js` — Google Calendar and Gmail API
- `src/templates.js` — Email template loading, parsing, and rendering
- `src/signature.js` — OPG-branded email signature with inline logo

For a deeper dive, see [`docs/scheduling-architecture.md`](docs/scheduling-architecture.md).

## Testing

```sh
npm test                    # Node built-in test runner
npx playwright test         # E2E browser tests
node --check app.js         # Syntax check
```

## Production

See:
- [`docs/operations.md`](docs/operations.md) — deployment, security, maintenance
- [`docs/configuration.md`](docs/configuration.md) — data model shapes and JazzHR adapter
- [`migrations/`](migrations/) — PostgreSQL migration files

The production storage target is PostgreSQL. The JSON store is for local development.

## License

MIT — see [LICENSE](LICENSE).
