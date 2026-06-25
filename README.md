# Slack Scheduler

Slack-first interview scheduling across JazzHR, Google Calendar, Gmail, and Slack.

## Security model

- Production secrets are stored in GCP Secret Manager and mounted as read-only files.
- Google OAuth tokens are encrypted with Cloud KMS before being stored in Cloud SQL.
- Recruitment, administrator, and alert access use explicit Slack user-ID lists.
- PostgreSQL production access uses Cloud SQL IAM authentication and private networking.
- The application does not load `.env` or `.env.production` files.

See:

- [Security review](docs/security-review.md)
- [Access control](docs/access-control.md)
- [Process flows](docs/process-flows.md)
- [Incident response](docs/incident-response.md)
- [GCP deployment](docs/gcp-deployment.md)

## Local development

Requirements:

- Node.js 20+
- A development Slack app with Socket Mode enabled

Install:

```powershell
npm.cmd ci
```

Set values in the current shell or use read-only secret files through `NAME_FILE`:

```powershell
$env:SLACK_BOT_TOKEN_FILE = 'C:\secure\slack-bot-token'
$env:SLACK_APP_TOKEN_FILE = 'C:\secure\slack-app-token'
$env:JAZZHR_API_KEY_FILE = 'C:\secure\jazzhr-api-key'
$env:ACCESS_CONTROL_ENFORCED = 'true'
$env:SLACK_RECRUITMENT_USER_IDS = 'U12345678'
$env:SLACK_ADMIN_USER_IDS = 'U12345678'
$env:SLACK_ALERT_USER_IDS = 'U12345678'
npm.cmd start
```

The JSON store is permitted only for local development and tests. Production validation requires Cloud SQL configuration.

## Slack entry points

- `/schedule-interview` opens intake.
- `/schedule-interview button` posts a reusable launcher.
- `/slack-scheduler` is administrator-only.
- Workflow Builder can send `/schedule-interview` or `/schedule-interview button` to a configured channel or DM.

## Architecture

```text
app.js
  -> src/config.js                    secret-file/config loading and validation
  -> src/security/slack-access.js     authorization and throttling
  -> src/store/index.js               JSON or Cloud SQL store
  -> src/slack/handlers.js            Slack workflows
  -> src/http-server.js               health and Google OAuth callback
  -> src/logger.js                    structured allow-listed logging
  -> src/observability/slack-alerts.js operational alert DMs
```

## Tests and security checks

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run security:audit
```

CI also runs full-history Gitleaks scanning and CodeQL.

## Production

Production infrastructure is defined under `infra/terraform`:

- Cloud Run in `australia-southeast1`
- Cloud SQL PostgreSQL 16
- Secret Manager
- Cloud KMS
- Artifact Registry
- Cloud Scheduler retention job
- GitHub Actions Workload Identity Federation

Deployment-specific identifiers belong in Terraform/GitHub environment configuration. Secret values must be added directly to Secret Manager and must not be committed or passed as Terraform variables.
