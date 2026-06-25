# GCP Deployment

## Environments

Use separate staging and production GCP projects in `australia-southeast1`, with separate Slack apps, Cloud SQL instances, Secret Manager secrets, KMS keys, and service accounts.

## Bootstrap

1. Create a GCS Terraform state bucket per environment.
2. Apply `infra/terraform` with the matching example tfvars.
3. Add secret values manually to the Secret Manager containers output by Terraform.
4. Configure GitHub environment variables used by `.github/workflows/deploy-gcp.yml`.
5. Configure the GitHub Workload Identity provider/service account outputs.
6. Apply `infra/github` using a GitHub token with repository administration permission.
7. Add the real Platform/Security GitHub team to `CODEOWNERS`.

Secret values are never Terraform variables or state entries. Cloud Run receives them as read-only files and the app reads `NAME_FILE`.

## Database privileges

After the migration identity creates the schema, grant the runtime IAM database user only the required table/sequence CRUD privileges. Do not grant schema ownership, `CREATE`, `DROP`, or migration privileges to runtime.

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

Cloud Run runs exactly one always-on instance with instance-based CPU. This is an accepted initial risk because Socket Mode and transient sessions are process-local. Cloud Run may reconnect the Socket Mode WebSocket periodically. Do not increase maximum instances until transient state and connection ownership are externalized and tested.

## Backup and restore

- Production Cloud SQL uses regional HA, PITR, and 35 retained backups.
- Run the restore-test workflow against a dedicated staging restore instance.
- Validate migrations, row counts, case state, notification locks, and KMS token decryption.
- Never point the restore workflow at the active staging or production instance.
