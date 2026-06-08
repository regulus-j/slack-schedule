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

  const rows = values
    .filter(row => row.some(cell => String(cell || '').trim()))
    .map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        const key = String(header || '').trim();
        if (key) obj[key] = row[i];
      });
      return obj;
    });

  return {
    sourceFileId: fileId,
    sheet: sheet.getName(),
    sheetId: sheet.getSheetId(),
    count: rows.length,
    rows
  };
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

For the current `Open Roles and Recruiter Assignment` tab, the exported row keys are:

- `4`: role title or section label such as `Open Roles`.
- `Recruiters  to manage`: date/status/comment field; values like `cancelled` or `On hold...` are treated as inactive role markers, not recruiter names.
- `For Automation`: second/final interviewer names, often comma-separated.
