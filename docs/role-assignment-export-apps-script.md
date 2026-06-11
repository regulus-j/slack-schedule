# Role Assignment Export Apps Script

The Node app can reuse the existing Apps Script deployment and token. `ROLE_ASSIGNMENT_EXPORT_URL` and `ROLE_ASSIGNMENT_EXPORT_TOKEN` fall back to `RECRUITER_PHONE_EXPORT_URL` and `RECRUITER_PHONE_EXPORT_TOKEN` when omitted.

In a Google spreadsheet, `fileId` identifies the whole spreadsheet file. `sheetName` identifies one tab inside that file. The mapping URL provided for this workflow points to `gid=664392081`, so the safest config is:

```env
ROLE_ASSIGNMENT_EXPORT_FILE_ID=1PQlbAXZT-uTr8xpDQJPfI4F3pvM86fomYWbS5Bu6Ufg
ROLE_ASSIGNMENT_EXPORT_SHEET_GID=664392081
```

The current script already supports `token`, `fileId`, and `sheetName`. Add the `gid` handling below if the tab name is not known or may be renamed.

```javascript
function doGet(e) {
  try {
    const expectedToken = PropertiesService.getScriptProperties().getProperty('TOKEN');
    const token = e.parameter.token;
    const fileId = e.parameter.fileId;
    const sheetName = e.parameter.sheetName || null;
    const gid = e.parameter.gid || null;

    if (token !== expectedToken) return json_({ error: 'Unauthorized' }, 401);
    if (!fileId) return json_({ error: 'Missing fileId' }, 400);

    const data = xlsxToJson_(fileId, sheetName, gid);
    return json_(data);
  } catch (err) {
    return json_({ error: err.message }, 500);
  }
}

function xlsxToJson_(fileId, sheetName, gid) {
  const ss = SpreadsheetApp.openById(fileId);
  const sheet = resolveSheet_(ss, sheetName, gid);

  if (!sheet) throw new Error(`Sheet not found: ${sheetName || gid || 'first sheet'}`);

  const values = sheet.getDataRange().getDisplayValues();
  const headers = values.shift() || [];
  const headerCounts = {};

  const rows = values
    .filter(row => row.some(cell => String(cell || '').trim()))
    .map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        const base = String(header || '').trim() || `Column ${columnName_(i + 1)}`;
        headerCounts[base] = (headerCounts[base] || 0) + 1;
        const key = headerCounts[base] === 1 ? base : `${base} ${headerCounts[base]}`;
        obj[key] = row[i];
      });
      Object.keys(headerCounts).forEach(key => delete headerCounts[key]);
      return obj;
    });

  return {
    ok: true,
    sourceFileId: fileId,
    sheet: sheet.getName(),
    sheetId: sheet.getSheetId(),
    count: rows.length,
    rows
  };
}

function columnName_(number) {
  let value = number;
  let name = '';
  while (value > 0) {
    value--;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function resolveSheet_(ss, sheetName, gid) {
  if (sheetName) return ss.getSheetByName(sheetName);
  if (gid) {
    const numericGid = Number(gid);
    return ss.getSheets().find(sheet => sheet.getSheetId() === numericGid) || null;
  }
  return ss.getSheets()[0];
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}
```

The app accepts the current response shape: `{ sourceFileId, sheet, count, rows }`.

## Hiring Manager Free/Busy

The same deployment can handle hiring-manager availability without changing the spreadsheet export route. This version uses the built-in `CalendarApp` service, so you do not need to add anything under **Services**.

```javascript
function doPost(e) {
  try {
    const expectedToken = PropertiesService.getScriptProperties().getProperty('TOKEN');
    const token = e.parameter.token;
    if (!expectedToken || token !== expectedToken) {
      return json_({ ok: false, error: 'Unauthorized' });
    }

    const request = JSON.parse(e.postData && e.postData.contents || '{}');
    if (request.action !== 'freeBusy') {
      return json_({ ok: false, error: 'Unsupported action' });
    }

    const timeMin = String(request.timeMin || '');
    const timeMax = String(request.timeMax || '');
    const emails = (request.attendees || [])
      .map(item => String(item.email || '').trim().toLowerCase())
      .filter(Boolean);

    if (!timeMin || !timeMax || emails.length === 0) {
      return json_({ ok: false, error: 'timeMin, timeMax, and attendees are required' });
    }

    const start = new Date(timeMin);
    const end = new Date(timeMax);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
      return json_({ ok: false, error: 'Invalid availability window' });
    }

    const calendars = {};
    const errors = {};
    emails.forEach(email => {
      try {
        const calendar = CalendarApp.getCalendarById(email);
        if (!calendar) {
          errors[email] = { reason: 'calendar_unavailable' };
          return;
        }

        calendars[email] = {
          busy: calendar.getEvents(start, end)
            .filter(event =>
              event.getTransparency() !== CalendarApp.EventTransparency.TRANSPARENT
            )
            .map(event => ({
              start: event.getStartTime().toISOString(),
              end: event.getEndTime().toISOString()
            }))
        };
      } catch (calendarError) {
        errors[email] = { reason: 'calendar_unavailable' };
      }
    });

    return json_({
      ok: true,
      timeMin,
      timeMax,
      calendars,
      errors
    });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}
```

Redeploy the web app after adding `doPost`. During deployment, authorize Calendar access if prompted. The deployment account must have each hiring-manager calendar shared with it and available in its Google Calendar list. The response intentionally excludes event titles and descriptions.

The Node app uses `HM_AVAILABILITY_SCRIPT_URL` and `HM_AVAILABILITY_SCRIPT_TOKEN` when set. They otherwise fall back to the role-assignment export deployment, then the recruiter export deployment.

For the current `Open Roles and Recruiter Assignment` tab, the exported row keys are:

- `4`: role title or section label such as `Open Roles`.
- `Recruiters  to manage`: date/status/comment field; values like `cancelled` or `On hold...` are treated as inactive role markers, not recruiter names.
- `For Automation`: second/final interviewer names, often comma-separated.

The current tab does not expose a recruiter-name column in its first-row headers. The app therefore uses an explicitly mapped recruiter when one is exported, otherwise it resolves the selected open JazzHR job's `hiring_lead` and enriches that person from the recruiter contact/Zoom export.
