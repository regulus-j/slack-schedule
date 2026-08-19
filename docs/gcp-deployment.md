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

Secret values are never Terraform variables or state entries. The application VM and OAuth callback service read them through Secret Manager references.

## Database privileges

After the migration job creates the schema, grant the runtime database user only the required table/sequence CRUD privileges. Do not grant schema ownership, `CREATE`, `DROP`, or migration privileges to runtime.

## Deployment

The workflow:

1. Ensures Artifact Registry exists.
2. Builds and pushes an immutable commit-tagged image.
3. Applies infrastructure.
4. Runs the migration Cloud Run Job after PostgreSQL is ready.
5. Deploys the scale-to-zero OAuth callback service and refreshes the application VM.

Production environment approval must be enabled in GitHub.

## Secrets and rotation

- Slack, JazzHR, Apps Script, and Google client secrets: rotate every 90 days.
- KMS automatically creates a new primary version every 90 days.
- After KMS rotation, execute the application image as a one-off job with `npm run tokens:reencrypt`.
- Rotate immediately after suspected exposure or administrator departure.
- Configure Secret Manager rotation notifications and an overdue-rotation monitoring alert.

## Availability

The application VM and PostgreSQL VM run Monday-Friday in `Australia/Sydney`. Cloud Scheduler starts PostgreSQL at 08:30, starts the application VM at 08:40, stops the application VM at 18:20, and stops PostgreSQL at 18:30. The application VM waits for PostgreSQL before starting its containers. Slack actions and notification processing are available whenever the scheduled application VM is running; they are no longer rejected by an internal time gate. The scale-to-zero Cloud Run service handles only the existing Google OAuth callback URL.

The schedules reduce runtime compute cost but do not pause every billing item. Persistent disks, VPC Access connectors, Artifact Registry storage, Secret Manager, KMS, GCS backup storage, Cloud Scheduler, and retained static IPs remain billable. Configure a project billing budget separately with the billing account ID; budgets notify on thresholds but do not automatically disable all resources.

To enable the Terraform-managed budget, add these optional GitHub `production` environment variables: `BILLING_ACCOUNT_ID`, `BUDGET_AMOUNT`, and `BUDGET_CURRENCY_CODE`. `BUDGET_AMOUNT=0` leaves budget creation disabled. The currency must match the billing account currency. Threshold notifications are created at 50%, 90%, and 100% of the monthly budget.

## Backup and restore

- PostgreSQL VM backups are nightly `pg_dump` files in a lifecycle-managed GCS bucket.
- Run restore tests against a disposable PostgreSQL VM.
- Validate migrations, row counts, case state, notification locks, and KMS token decryption.
- Never point the restore workflow at the active staging or production instance.
