# Repository Personal-Information Exposure Assessment

Status: Open — confirmed public-repository exposure; privacy/security decision required before history rewriting.

## Preserved evidence

- File: `email-templates/Greetings from Outsourced Pro Global!.eml`
- First tracked commit found locally: `c6750d2` (`2026-05-19`, `Add assets, email templates, and database migrations`)
- The file contains real email transport metadata and a personal recipient address.
- GitHub API verification on 2026-06-23 reported that `regulus-j/slack-schedule` is public, was created at `2026-05-19T02:31:13Z`, and currently reports zero forks.
- Zero current forks does not rule out clones, deleted forks, mirrors, caches, indexing, or downloaded archives.
- The file was removed from the current tree on 2026-06-23 as containment. Reachable Git history was not rewritten and remains available for evidence and assessment.
- `.gitignore` now blocks new `.eml` files.

## Required investigation

- Confirm repository visibility from 2026-05-19 until removal.
- Export the collaborator and outside-collaborator history.
- Inventory forks, mirrors, CI artifacts, caches, backups, release archives, and known clones.
- Classify every personal-data field in the message.
- Determine whether any person or system outside the authorized organisation could access it.
- Record the privacy officer/legal conclusion and whether the Australian NDB assessment process is triggered.
- If an eligible breach is suspected, complete the assessment as soon as possible and within the OAIC maximum assessment period.

## Cleanup after approval

1. Add a synthetic fixture only if a future test requires one.
2. Rewrite all reachable Git history with the approved tool.
3. Force-update controlled mirrors and invalidate CI/cache artifacts.
4. Require fresh clones.
5. Record that rewriting cannot revoke copies already downloaded.
6. Preserve the assessment and evidence in the approved restricted incident system, not this repository.
