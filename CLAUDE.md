# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for build/test/lint commands, code style conventions, and module overview. This file covers architectural patterns that span multiple modules.

## Case State Machine

Cases progress through statuses: `Draft` → `Waiting for HM` → `Checking Calendar` → `Waiting for Candidate` → `Ready to Schedule` → `Scheduled`. Only `Scheduled` cases expose reschedule actions. The reschedule path has its own substates: `none` → `requested` → `completed` or `cancelled`. See `src/workflow/reschedule.js` for the full state machine, `visibleCaseActions()`, and guard functions (`canFinalizeSchedule`, `canStartReschedule`). The UI in `src/slack/views.js` uses `visibleCaseActions()` to conditionally render buttons.

## Scheduling Pipeline (6 steps)

`src/workflow/scheduler.js` exports `runSchedulingPipeline()` which orchestrates:
1. Resolve stage rules from template → stage key mapping (`src/workflow/stage-rules.js`)
2. Normalize attendees with role-based inclusion defaults (`src/workflow/attendees.js`)
3. Generate candidate slots within the interview window, weekdays only, business hours (`generateCandidateSlots`)
4. Check Google Calendar free/busy for all included attendees (`checkAvailability`)
5. Intersect slots with busy periods + detect conflicts (overlap, double-booking, buffer violations, Zoom conflicts) (`intersectSlotsWithBusy`, `detectConflicts`)
6. Rank remaining slots (morning preference bonus, decay with later hours) (`rankSlots`)

When any Google API call fails or credentials are missing, the pipeline returns `mocked: true` and shows all slots as available rather than throwing.

## OAuth & Token Lifecycle

Google OAuth tokens are per-recruiter and stored in the store (`store.saveGoogleToken` / `store.getGoogleToken`). In `src/services/google.js`, `resolveAccessToken()` checks expiry and auto-refreshes before each API call. Token payloads are encrypted at rest via `src/security/crypto.js` when `APP_ENCRYPTION_KEY` is set. The `http-server.js` `/oauth/google/callback` route receives the code, exchanges it, and saves the token.

## Store Abstraction

`src/store/index.js` chooses JSON or Postgres based on `DATABASE_URL`. Both stores expose the same interface: `init`, `createCase`, `getCase`, `updateCase`, `listCases`, `listCasesForUser`, `addAudit`, `saveGoogleToken`, `getGoogleToken`, `hasGoogleToken`, `stats`. The JSON store persists to `data/runtime/state.json` synchronously after every mutation. The Postgres store maps `camelCase` JS fields to `snake_case` columns.

## Slack Handler Registration

`src/slack/handlers.js` exports `registerSlackHandlers(app, context)` which takes `{ config, store, logger }`. All handlers — events (`app_home_opened`), commands (`/schedule-interview`), actions (button clicks), views (modal submissions), and options (dynamic select menus) — are registered in this single function. The `guards.js` `verifyChannel` function gates channel-restricted actions.

## Template Variables

Templates use `[bracket_notation]` (e.g., `[applicant_first_name]`, `[date]`, `[time]`, `[link]`). Variable keys are lowercased with underscores. `buildTemplateVariables()` in `handlers.js` builds the variable map from the case record. Templates in `email-templates/` are plain text files parsed by `Subject:` / `Body:` header lines.
