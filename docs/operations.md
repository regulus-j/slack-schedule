# Operations Guide

## Environments

Use separate Slack apps and Google OAuth credentials for local, staging, and production.

Required production variables:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `JAZZHR_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_SHARED_CALENDAR_ID`
- `DATABASE_URL`
- `APP_ENCRYPTION_KEY`

Local development can run the Slack workflow with only Slack tokens. Google and JazzHR calls are safely mocked until credentials are present.

## Deployment

Deploy the Node service as an always-on Render web service.

Recommended Render settings:

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/health`
- Runtime: Node 20 or newer

Run `migrations/001_initial.sql` against the managed Postgres database before production launch. If `DATABASE_URL` is present, the app uses Postgres. Without it, local development falls back to JSON state in `data/runtime/state.json`.

## Security

- Keep `.env` local only.
- Store Render secrets in environment variables.
- Encrypt Google refresh tokens with `APP_ENCRYPTION_KEY` before storage.
- Do not store resumes in this app.
- Review Slack, Google, JazzHR, and encryption secrets quarterly.
- Redacted structured logs are used by default for email and phone-like values.

## Maintenance

- Refresh the JazzHR cache on a schedule after JazzHR field mapping is finalized.
- Review `email-templates` whenever recruiting copy changes.
- Run `npm audit` monthly.
- Review OAuth scopes quarterly.
- Check stuck cases daily: statuses other than `Scheduled` that have not changed recently.

## Recovery Playbooks

- Google OAuth reconnect: ask the recruiter to reconnect Gmail/Calendar and replace encrypted token payload.
- Slack reinstall: update app manifest, reinstall workspace app, rotate bot/app tokens if needed.
- JazzHR key replacement: rotate `JAZZHR_API_KEY`, restart service, trigger cache refresh.
- Failed Calendar event: inspect case audit, confirm no stored `calendarEventId`, then retry from the Finalize modal.
- Stuck case: move to `Needs Attention`, review audit history, and resume from the last approval step.
