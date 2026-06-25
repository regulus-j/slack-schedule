# Access Control

## Configuration

The following deployment values are comma/space-separated Slack user IDs:

- `SLACK_RECRUITMENT_USER_IDS`: users allowed to open, search, view, and mutate scheduling cases.
- `SLACK_ADMIN_USER_IDS`: includes recruitment access and permits refresh commands and shared Google OAuth management.
- `SLACK_ALERT_USER_IDS`: recipients of sanitized operational error DMs.

Production requires all three lists and `ACCESS_CONTROL_ENFORCED=true`.

## Change control

- Changes are made through Terraform/GitHub environment variables, never source-code defaults.
- Any membership change requires a pull request or an auditable environment change ticket.
- `main` requires two approvals and code-owner review.
- Platform/Security must be one of the reviewers. Until a GitHub Platform/Security team exists, `@regulus-j` is the configured code owner and the second approval must be recorded in the change ticket.
- Emergency changes require an incident ID, named approver, reason, exact before/after membership, and a follow-up PR within one business day.
- Review all three lists quarterly and immediately after personnel or role changes.

## Removal

1. Remove the Slack user ID from recruitment/admin lists.
2. Redeploy Cloud Run.
3. Run the retention job; Google tokens owned by users no longer authorized are deleted.
4. Review audits for activity after the effective removal time.
5. Rotate shared credentials if the removed user had administrative access to them.

## Rate limits

| Class | Limit |
|---|---:|
| Reads/searches | 60/minute/user |
| Case mutations | 20/5 minutes/user |
| Calendar, email, retry, cancel, complete | 10/10 minutes/user |
| Administrative commands | 3/10 minutes/user |

Rate limiting does not replace duplicate-send and state-transition guards.
