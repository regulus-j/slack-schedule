# Issue Tracker

Created: 2026-08-21

## Template selection review

Interview email templates are selected by interview stage/template ID, not by the selected company email.

- `1st-interview` uses `1st-interview-invite`
- `2nd-interview` and `final-interview` use `2nd-or-Final-invite`
- `job-offer-discussion` uses `job-offer-discussion`

The selected company account (`accountKey`) scopes the JazzHR data and account routing. Its display name is available as `[company_name]`, but the current job-offer subject is the only interview-template location that uses it. The template bodies still hardcode `Outsourced Pro Global`. Google account email selection is for Calendar/OAuth routing and does not select email templates.

## Recorded issues

| Date | Area | Issue | Status |
|---|---|---|---|
| 2026-08-21 | Reschedule interview | Review submission acknowledged the modal and attempted to open the approval modal with the submission trigger, so the approval modal did not appear. | Fixed |
| 2026-08-21 | Cancel interview | Cancel interview had no confirmation dialog before the cancellation side effects. | Fixed |
| 2026-08-21 | Recruiter sheet import | Zoom links and phone/number fields were only recognized for a narrow set of exact headers, causing descriptive sheet columns to be missed. | Fixed |
| 2026-08-21 | Unresponsive-candidate template | The template uses `[Schedule Your Interview Here]`, but the app variable is `schedule_your_interview_here`; the placeholder can remain unresolved. | Open |
| 2026-08-21 | Interview template HTML | `2nd-or-Final-invite` and `job-offer-discussion` contain `<li>` elements outside a `<ul>`, which may render inconsistently in email clients. | Open |
| 2026-08-21 | Interview contact details | `2nd-or-Final-invite` and `job-offer-discussion` hardcode `+61 489 275 966 (AU)` while also rendering the dynamic recruiter phone line, potentially showing stale or conflicting numbers. | Open |
| 2026-08-21 | 2nd/final template | The body assumes `[hiring_manager_name]` and `[position_title]` are populated, which can produce awkward blank grammar when the hiring manager is optional. | Open |
| 2026-08-21 | Interview template consistency | Only the first-interview template displays interview duration even though duration is available for every stage. | Open |
| 2026-08-21 | Template maintenance | Date/time/link placeholders use mixed casing (`[Date]` versus `[date]`). This currently works because the app supplies both forms, but is unnecessarily fragile. | Open |
| 2026-08-21 | Company branding | Interview template branding was not fully account-aware; bodies and footer copy hardcoded Outsourced Pro Global instead of using the selected company branding. | Partially fixed |

The three standard interview templates now use `[company_name]` in their subject/body branding. The shared email signature, logo, legal entity, and generated reschedule/reminder/cancellation messages still use the OPG branding and require a separate per-company branding configuration if those assets must also vary.
