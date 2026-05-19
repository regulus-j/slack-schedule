# Configuration

## People Maps

V1 uses local sample people in `src/data/sample-data.js`. Replace these with imported Postgres records or a controlled CSV import before production.

Each person should include:

- `id`
- `name`
- `email`
- `role`: `recruiter` or `hiring_manager`
- `slackUserId`
- `zoomLink` for recruiters
- `signature` for recruiters
- `positionTitle` for hiring managers

All picker labels should render as `Name <email>`.

## Applicant Cache

V1 includes sample applicants in `src/data/sample-data.js`. The JazzHR adapter in `src/services/jazzhr.js` is the boundary for replacing sample data with cached JazzHR records.

Each applicant should include:

- `id`
- `jazzhrApplicationId`
- `firstName`
- `lastName`
- `email`
- `phone`
- `jobTitle`
- `stage`
- `hiringManagerId`
- `recruiterId`

## Resume Handling

Resume automation is intentionally disabled. Recruiters manually download and attach/share resumes outside this app for v1.
