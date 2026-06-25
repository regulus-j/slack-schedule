# Security Review

Last reviewed: 2026-06-23

Owners:

- Application Engineering: application code and tests
- Platform/Security: GCP, IAM, CI/CD, backups, credentials, and privacy assessment

Statuses are `Pass`, `Fail`, `Accepted Risk`, or `Not Applicable`.

## Immediate findings

| Area | Status | Severity | Evidence and disposition | Owner | Review/expiry |
|---|---|---:|---|---|---|
| Server-side Slack authorization | Pass | High | `src/security/slack-access.js` enforces configured recruitment/admin IDs before handlers execute. | Application | Quarterly |
| Case ID authorization | Pass | High | All handlers run behind recruitment membership; the chosen policy permits all configured recruitment users to manage team cases. | Application | Quarterly |
| Administrative commands | Pass | High | `/slack-scheduler` and shared Google OAuth management require an admin ID. | Application | Quarterly |
| OAuth state replay/CSRF | Pass | High | Opaque hashed state is team-bound, expires after ten minutes, and is consumed once through store transactions. | Application | Annual |
| MIME header injection | Pass | High | `src/security/email-headers.js` rejects controls, validates addresses, and RFC-2047 encodes Unicode headers. | Application | Annual |
| Production dependencies | Pass | High | `npm audit --omit=dev` reported zero findings on 2026-06-23. CI blocks moderate or higher findings. | Application | Continuous |
| Moderate dependency findings | Pass | Medium | No current moderate findings. Future findings require remediation or a documented acceptance expiring within 30 days. | Application | Continuous |
| External HTTP timeouts | Pass | Medium | `src/services/http-client.js` supplies abort timeouts to Google, JazzHR, Apps Script, and resume downloads. | Application | Annual |
| SQL injection | Pass | High | Runtime queries use PostgreSQL parameters; migration SQL is read only from repository-owned migration files. | Application | Annual |
| Dynamic code/shell injection | Pass | High | Runtime code does not use `eval`, `Function`, or user-derived shell commands. | Application | Annual |
| File upload validation | Pass | High | Resume downloads enforce size and PDF/DOC/DOCX signatures and sanitize filenames. | Application | Annual |
| HTML output encoding | Pass | Medium | Template substitutions escape user-derived values by default; application-owned signatures remain trusted fragments. | Application | Annual |
| Logging PII/secrets | Pass | High | Structured logger uses field allow-listing plus credential, PII, token, URL, and control-character redaction. | Application | Quarterly |
| Central error handling | Pass | Medium | Bolt, HTTP flow, workers, process rejection/exception, and graceful shutdown paths log structured failures. | Application | Annual |
| Rate limiting | Pass | Medium | Persistent fixed-window limits apply per Slack user and operation class. | Application | Quarterly |
| Retention | Pass | Medium | Daily retention job supports legal holds, 12-month closed-case retention, token/candidate cleanup, and dry-run. | Platform | Quarterly |
| Public health information | Pass | Low | `/health` returns only readiness status. | Application | Annual |
| Security headers | Pass | Low | JSON and OAuth responses set nosniff, frame, referrer, CSP, and no-store controls. | Application | Annual |
| `.env` loading | Pass | High | Runtime no longer parses `.env`; secrets can be provided through read-only `*_FILE` mounts. | Platform | Continuous |
| Cloud SQL access | Pass | High | Terraform uses private IP and IAM database authentication with separate runtime/migration identities. | Platform | Quarterly |
| OAuth token encryption | Pass | High | GCP deployment uses a 90-day rotating Cloud KMS key. | Platform | Quarterly |
| Raw `.eml` personal information | Fail | High | The public repository exposed a real message from commit `c6750d2`. It is removed from the current tree, but remains in history pending the assessment in `docs/privacy-exposure-assessment.md`. Do not rewrite history before approval. | Privacy/Security | Immediate |
| Slack token rotation | Accepted Risk | Medium | Manifest token rotation remains disabled for current Socket Mode compatibility. Rotate manually every 90 days and after incidents/personnel changes. | Platform | 2026-09-21 |
| One Cloud Run instance | Accepted Risk | Medium | Required initially because Socket Mode and transient caches are process-local. Controls: restart, uptime checks, rollback, Cloud SQL HA. Exit after transient state is externalized and multi-instance behavior is tested. | Platform | 2026-12-23 |

## Checklist disposition

### Input, output, authentication, and logic

- Pass: parameterized SQL; no dynamic code execution; server-side validation; path inputs are repository/config controlled.
- Pass: HTML variables are escaped; JSON has an explicit content type.
- Not Applicable: passwords, browser sessions, password resets, cookies, local storage, and traditional form CSRF are not used.
- Pass: Slack authentication is performed by Bolt Socket Mode; application authorization uses explicit Slack user-ID lists.
- Pass: cryptographic identifiers use Node `crypto`.
- Pass: state changes occur through authenticated Slack interactions or the OAuth callback, not unauthenticated GET side effects.
- Pass: incoming objects are mapped to explicit case fields rather than persisted through unrestricted mass assignment.

### Development to production

- Pass: no debug endpoint or stack trace is returned to users.
- Pass: secrets are Secret Manager resources in GCP; Terraform contains no secret values.
- Pass: staging and production use distinct projects, service accounts, secrets, Slack applications, and databases.
- Pass: Cloud Run terminates TLS and Cloud SQL is private.
- Pass: GitHub Actions uses Workload Identity Federation.
- Pass: dependency lockfile, Dependabot, CodeQL, Gitleaks, and audit gates are configured.
- Not Applicable: source maps, directory listing, and browser CORS are not exposed by this Node service.

### Error handling and logging

- Pass: process-level failures are captured and logged.
- Pass: users receive generic messages and correlation IDs.
- Pass: alert DMs are immediate for error/fatal and thresholded for warnings, with cooldown and recursion prevention.
- Pass: Cloud Logging access and 90-day retention are deployment controls documented in Terraform/runbooks.
- Follow-up: narrow remaining deliberate parse-fallback catches when related modules are next changed.

### Infrastructure and process

- Pass: Cloud SQL runtime and migration identities are separated.
- Pass: GCP service accounts receive purpose-specific roles.
- Pass: private networking separates Cloud SQL from the public service endpoint.
- Pass: backups retain 35 copies and production enables point-in-time recovery.
- Pass: incident response, access control, process flows, retention, and restore testing are documented.
