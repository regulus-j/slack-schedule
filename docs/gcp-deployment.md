# GCP Deployment

## Environments

Use separate staging and production GCP projects in `us-central1`, with separate Slack apps, private PostgreSQL VMs, Secret Manager secrets, KMS keys, and service accounts.

## Bootstrap

1. Create a GCS Terraform state bucket per environment.
2. Apply `infra/terraform` with the matching example tfvars.
3. Add secret values manually to Secret Manager, including `DATABASE_URL` and `DATABASE_PASSWORD`.
4. Configure GitHub environment variables used by `.github/workflows/deploy-gcp.yml`.
5. Configure the GitHub Workload Identity provider/service account outputs.
6. Apply `infra/github` using a GitHub token with repository administration permission.
7. Add the real Platform/Security GitHub team to `CODEOWNERS`.

Secret values are never Terraform variables or state entries. Cloud Run reads them through Secret Manager references.

## Database privileges

After the migration job creates the schema, grant the runtime database user only the required table/sequence CRUD privileges. Do not grant schema ownership, `CREATE`, `DROP`, or migration privileges to runtime.

## Deployment

The workflow:

1. Ensures Artifact Registry exists.
2. Builds and pushes an immutable commit-tagged image.
3. Applies infrastructure.
4. Runs the migration Cloud Run Job.
5. Promotes the Cloud Run service revision.

Production environment approval must be enabled in GitHub.

## Secrets and rotation

- Slack, JazzHR, Apps Script, and Google client secrets: rotate every 90 days.
- KMS automatically creates a new primary version every 90 days.
- After KMS rotation, execute the application image as a one-off job with `npm run tokens:reencrypt`.
- Rotate immediately after suspected exposure or administrator departure.
- Configure Secret Manager rotation notifications and an overdue-rotation monitoring alert.

## Availability

Cloud Run runs at most one instance with instance-based CPU during Monday-Friday business hours (`Australia/Sydney`, 09:00-18:00). Scheduler jobs start PostgreSQL at 08:30, enable Cloud Run at 08:45, disable it at 18:30, and stop PostgreSQL at 19:00. Socket Mode reconnects on the next workday.

## Backup and restore

- PostgreSQL VM backups are nightly `pg_dump` files in a lifecycle-managed GCS bucket.
- Run restore tests against a disposable PostgreSQL VM.
- Validate migrations, row counts, case state, notification locks, and KMS token decryption.
- Never point the restore workflow at the active staging or production instance.
