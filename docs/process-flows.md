# Process Flows

Nodes use `path :: function()` notation.

## GCP architecture

```mermaid
flowchart LR
  Slack[Slack Socket Mode] --> Run[Cloud Run :: app.js main]
  Browser[Google OAuth browser] --> Run
  Run --> SQL[Cloud SQL PostgreSQL]
  Run --> SM[Secret Manager file mounts]
  Run --> KMS[Cloud KMS OAuth token key]
  Run --> Google[Google Calendar and Gmail]
  Run --> JazzHR[JazzHR API]
  Run --> Apps[Apps Script exports]
  Run --> Logs[Cloud Logging and Monitoring]
  Logs --> Alerts[Slack operations DMs / monitoring email]
  Scheduler[Cloud Scheduler] --> Retention[Cloud Run Job :: scripts/retention.js]
  Retention --> SQL
```

## Startup

```mermaid
flowchart TD
  A[app.js :: main] --> B[src/config.js :: loadConfig]
  B --> C[src/config.js :: validateStartupConfig]
  C --> D[src/store/index.js :: createStore]
  D --> E[src/store/postgres-connection.js :: createPostgresPool]
  E --> F[src/services/talent-directory.js :: loadTalentDirectory]
  F --> G[src/services/jazzhr.js :: refreshJazzhrOpenJobs]
  G --> H[src/services/jazzhr.js :: hydrateJazzhrCacheFromStore]
  H --> I[src/slack/handlers.js :: registerSlackHandlers]
  I --> J[src/http-server.js :: createHttpServer]
  J --> K[src/workflow/notifications.js :: startNotificationWorker]
  K --> L[src/services/slack-directory.js :: ensureSlackDirectory]
  C -->|invalid| X[src/logger.js :: logger.fatal]
```

## Slack intake and search

```mermaid
flowchart TD
  A[Slack command/event/action] --> B[src/security/slack-access.js :: installSlackSecurityMiddleware]
  B -->|not authorized| Z[Generic denial plus correlation ID]
  B --> C[src/store/* :: consumeRateLimit]
  C -->|limited| Z
  C --> D[src/slack/handlers.js :: openIntakeModal]
  D --> E[src/slack/views.js :: intakeModal]
  E --> F[src/services/jazzhr-live-search.js :: search]
  F --> G[src/store/* :: searchJazzhrCandidates]
  E --> H[src/slack/handlers.js :: roleAutofillSelections]
  H --> I[src/slack/handlers.js :: schedule_intake_submit]
  I --> J[src/store/* :: createCase]
  J --> K[src/store/* :: addAudit]
  K --> L[src/slack/handlers.js :: publishHome]
```

## Scheduling and finalization

```mermaid
flowchart TD
  A[src/slack/handlers.js :: scheduling_phase_one] --> B[src/workflow/scheduler.js :: runSchedulingPipeline]
  B --> C[src/workflow/scheduler.js :: generateCandidateSlots]
  C --> D[src/workflow/scheduler.js :: checkAvailability]
  D --> E[src/services/google.js :: checkFreeBusy]
  E --> F[src/workflow/scheduler.js :: intersectSlotsWithBusy]
  F --> G[src/workflow/scheduler.js :: detectConflicts]
  G --> H[src/workflow/scheduler.js :: rankSlots]
  H --> I[src/slack/handlers.js :: finalize_email_preview_submit]
  I --> J[src/services/resume-attachment.js :: resolveResumeAttachment]
  J --> K[src/services/google.js :: createCalendarEvent]
  K --> L[src/store/* :: updateCase and addAudit]
  L --> M[src/services/google.js :: sendRecruiterEmail]
  M --> N[src/slack/handlers.js :: sendAttendeeInviteEmails]
  N --> O[src/workflow/notifications.js :: scheduleCaseNotifications]
  D -->|failure| X[Safe Slack error plus structured alert]
  K -->|uncertain/failure| X
  M -->|failure| X
```

## Custom Invite

```mermaid
flowchart TD
  A[src/slack/handlers.js :: schedule_intake_submit] --> B[src/workflow/custom-invite.js :: validateCustomInviteDraft]
  B --> C[src/store/* :: createCase]
  C --> D[src/slack/handlers.js :: finalize_email_preview_submit]
  D --> E[src/services/google.js :: createCalendarEvent]
  E --> F[src/slack/handlers.js :: deliverCustomInviteEmails]
  F --> G[src/workflow/custom-invite.js :: buildCustomInviteEmail]
  G --> H[src/services/google.js :: sendRecruiterEmail]
  H --> I[src/store/* :: updateCase deliveryStatus]
  I -->|partial failure| J[src/slack/handlers.js :: retry_custom_invites]
  J --> F
```

## Reschedule, cancel, and complete

```mermaid
flowchart TD
  A[src/slack/handlers.js :: reschedule_submit] --> B[src/workflow/reschedule.js :: applyRescheduleRequest]
  B --> C[src/store/* :: updateCase]
  C --> D[src/slack/handlers.js :: reschedule_approval_submit]
  D --> E[src/services/google.js :: updateCalendarEvent]
  E --> F[src/services/google.js :: sendRecruiterEmail]
  F --> G[src/workflow/reschedule.js :: applyCompletedReschedule]
  G --> H[src/workflow/notifications.js :: scheduleCaseNotifications]
  I[src/slack/handlers.js :: cancel_interview] --> J[src/workflow/reschedule.js :: applyCancelledInterview]
  J --> K[src/services/google.js :: sendRecruiterEmail]
  L[src/slack/handlers.js :: mark_event_complete] --> M[src/workflow/notifications.js :: markCaseComplete]
```

## Notifications

```mermaid
flowchart TD
  A[src/workflow/notifications.js :: startNotificationWorker] --> B[src/workflow/notifications.js :: processDueNotificationJobs]
  B --> C[src/store/* :: claimDueNotificationJobs]
  C --> D[src/workflow/notifications.js :: deliverNotification]
  D --> E[src/services/jazzhr.js :: fetchApplicantDetail]
  D --> F[src/services/google.js :: sendRecruiterEmail]
  D --> G[Slack completion DM]
  D -->|success| H[src/store/* :: finishNotificationJob]
  D -->|failure| I[src/store/* :: retryNotificationJob]
  I --> J[src/logger.js :: logger.error]
  J --> K[src/observability/slack-alerts.js :: dispatcher]
```

## Google OAuth

```mermaid
flowchart TD
  A[src/slack/handlers.js :: open_google_oauth] --> B[src/security/slack-access.js :: requireAdminSlackUser if shared]
  B --> C[src/security/oauth-state.js :: issueOAuthState]
  C --> D[src/store/* :: createOAuthState]
  D --> E[src/services/google.js :: buildGoogleOAuthUrl]
  E --> F[Google authorization]
  F --> G[src/http-server.js :: OAuth callback]
  G --> H[src/security/oauth-state.js :: consumeOAuthState]
  H -->|invalid expired replay| X[HTTP 400 and structured warning]
  H --> I[src/services/google.js :: exchangeGoogleOAuthCode]
  I --> J[src/security/token-cipher.js :: KMS encrypt]
  J --> K[src/store/* :: saveGoogleToken]
```

## Retention and errors

```mermaid
flowchart TD
  A[Cloud Scheduler] --> B[scripts/retention.js :: runRetention]
  B --> C[src/store/* :: purgeRetention]
  C --> D[Closed cases older than 12 months unless legal hold]
  C --> E[Stale candidate cache older than 30 days]
  C --> F[Inactive Google tokens older than 90 days or unauthorized owner]
  C --> G[Expired OAuth states]

  H[Any handler/service failure] --> I[src/logger.js :: structured allow-listed log]
  I --> J{Severity}
  J -->|error/fatal| K[src/observability/slack-alerts.js :: immediate DM]
  J -->|3 warnings/5m| K
  K --> L[15-minute fingerprint cooldown]
  K -->|Slack unavailable| M[Cloud Monitoring email policy]
```

## Trigger matrix

| Trigger | Entry handler | Primary downstream work | Persistent/external effects |
|---|---|---|---|
| `/schedule-interview` | `src/slack/handlers.js :: command` | `openIntakeModal` | Slack modal/message |
| `/slack-scheduler` | `src/slack/handlers.js :: command` | cache/directory refresh | JazzHR/Apps Script reads |
| App Home | `app_home_opened` | `publishHome` | PostgreSQL reads, Slack Home publish |
| Intake actions/options | action/options handlers | search, role mapping, modal refresh | JazzHR reads, Slack updates |
| `schedule_intake_submit` | view handler | `createCase`, `addAudit` | PostgreSQL writes |
| Scheduling phase one | view handler | `runSchedulingPipeline` | Google free/busy, PostgreSQL writes |
| Scheduling/finalize submit | view handlers | Calendar, email, notifications | Google Calendar/Gmail, PostgreSQL |
| Reschedule/cancel/complete | action/view handlers | state transitions and notifications | Calendar/Gmail/Slack/PostgreSQL |
| Notification tick | `processDueNotificationJobs` | claim/deliver/retry | PostgreSQL/JazzHR/Gmail/Slack |
| `/oauth/google/callback` | HTTP server | state consumption/token exchange | Google OAuth, KMS, PostgreSQL |
| Daily retention | Cloud Run Job | `purgeRetention` | PostgreSQL deletes |
