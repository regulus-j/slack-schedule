# Incident Response

## Severity

- Critical: active credential compromise, unauthorized scheduling/email/calendar activity, or confirmed material personal-data exposure.
- High: exploitable authorization/OAuth flaw, high-risk dependency, duplicate external side effects, or database access incident.
- Medium: contained service failure, repeated upstream errors, or policy drift without confirmed misuse.
- Low: isolated recoverable defect with no sensitive-data or external-side-effect impact.

## Standard response

1. Open an incident and assign commander, application owner, platform owner, and privacy/security owner.
2. Preserve logs, audit records, deployment revisions, affected case IDs, and timestamps.
3. Contain: disable affected actions, remove users, stop workers, revoke credentials, or route traffic to the previous revision.
4. Assess scope and notification obligations.
5. Recover using tested revisions/backups without replaying uncertain email or Calendar operations.
6. Verify authorization, idempotency, database integrity, and alerting.
7. Complete a post-incident review with corrective actions and owners.

## Playbooks

### Leaked secret

- Disable/rotate immediately in the provider.
- Update Secret Manager with a new version and redeploy.
- Review access and provider audit logs from the earliest possible exposure.
- Rotate adjacent credentials if trust boundaries overlap.

### OAuth compromise

- Disable Google actions and revoke affected refresh tokens.
- Delete encrypted token records and all outstanding OAuth states.
- Rotate the OAuth client secret and KMS permissions if implicated.
- Require reconnection after remediation.

### Unauthorized Slack action

- Remove the user from configured lists and redeploy.
- Inspect `slack_access_denied`, case audits, Calendar, Gmail, and JazzHR activity.
- Cancel or correct only actions confirmed to have occurred.

### Duplicate or uncertain send

- Stop retries for the case and set it to `needs_attention`.
- Check Gmail message IDs and Calendar event IDs before retrying.
- Do not infer failure solely from a client timeout.

### Dependency vulnerability

- Reproduce `npm audit`, determine reachability, and patch.
- Critical/high blocks deployment.
- Moderate must be patched or documented as accepted risk for at most 30 days.

### Database recovery

- Stop application writes and notification workers.
- Restore the selected Cloud SQL backup to a dedicated recovery instance.
- Validate migrations, row counts, case state, notification locks, and token decryptability.
- Promote only after written approval.

### Repository PII exposure

- Follow `docs/privacy-exposure-assessment.md`.
- Preserve evidence before cleanup.
- Involve the privacy/security owner before determining NDB applicability.
