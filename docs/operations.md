# Operations Guide

Production runs on GCP. Follow [gcp-deployment.md](gcp-deployment.md).

## Required production controls

- Separate staging and production projects, Slack apps, Cloud SQL databases, KMS keys, and secrets.
- Secret Manager file mounts; no `.env` or `.env.production`.
- `ACCESS_CONTROL_ENFORCED=true` with recruitment, admin, and alert Slack user lists.
- Cloud SQL IAM authentication and private networking.
- Production deployment approval and two reviewed pull-request approvals.

## Google OAuth Setup

Each environment (local dev, staging, production) requires its own Google Cloud OAuth client
configuration.

1. Go to **Google Cloud Console** → **APIs & Services** → **Credentials**.
2. Find or create an OAuth 2.0 Client ID of type **Web application**.
3. Under **Authorized redirect URIs**, add the exact callback URL for each environment:
   - Local dev: `http://localhost:3000/oauth/google/callback`
   - Staging: `https://<staging-cloud-run-url>/oauth/google/callback`
   - Production: `https://<production-cloud-run-url>/oauth/google/callback`
4. Set the corresponding env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
5. `GOOGLE_REDIRECT_URI` is optional — when unset, it defaults to
   `{PUBLIC_BASE_URL}/oauth/google/callback`. When set explicitly, it takes precedence.
6. The Google Cloud project must have the **Calendar API** and **Gmail API** enabled.
7. The OAuth consent screen must include the `calendar.events`, `calendar.freebusy`, and
   `gmail.send` scopes. The app is configured for **offline** access (refresh tokens).

**Troubleshooting**: If users see a Google error page mentioning `redirect_uri_mismatch`,
the `GOOGLE_REDIRECT_URI` (or the derived `PUBLIC_BASE_URL/oauth/google/callback`) does not
match any authorized URI in the Google Cloud Console. Add it or fix the env var.

## Routine operations

- Review configured Slack access lists quarterly.
- Rotate Slack, JazzHR, Google client, and Apps Script credentials every 90 days.
- Run `npm run tokens:reencrypt` after KMS primary-key rotation.
- Review failed notification jobs and `needs_attention` cases daily.
- Run the retention job daily and review its deletion counts.
- Apply or remove a case legal hold with `npm run legal-hold -- --case case-id --mode enable|disable`; record the authorizing ticket.
- Perform a staging backup restore test quarterly.
- Run `npm audit --omit=dev` and review Dependabot weekly.

## Verification

Expected signals:

- `health_server_started`
- `slack_app_started`
- successful `/health`
- successful Cloud SQL connection
- successful forced-error alert DM to configured users
- retention dry-run output before enabling scheduled deletion

## Notification testing

Preview without delivery:

```powershell
npm.cmd run notifications:test -- --case case-id --type candidate-reminder --email test@example.com
```

Deliver only to explicit test recipients:

```powershell
npm.cmd run notifications:test -- --case case-id --type all --email test@example.com --slack-user U12345678 --deliver
```

Using real case recipients requires the existing explicit `--use-case-recipients` opt-in.

## Recovery

Use [incident-response.md](incident-response.md) for credential exposure, OAuth compromise, unauthorized actions, duplicate sends, dependency vulnerabilities, and database recovery.
