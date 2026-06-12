export async function readAppsScriptJson(response) {
  const contentType = String(response?.headers?.get?.('content-type') || '').trim()
  if (typeof response?.text !== 'function') {
    return {
      payload: await response.json(),
      contentType,
      error: '',
    }
  }

  const text = await response.text()
  try {
    return {
      payload: JSON.parse(text),
      contentType,
      error: '',
    }
  } catch {
    return {
      payload: null,
      contentType,
      error: appsScriptResponseError(text, contentType),
    }
  }
}

function appsScriptResponseError(text, contentType) {
  const plainText = stripHtml(text)
  if (
    contentType.toLowerCase().includes('text/html') ||
    /^\s*<!doctype html/i.test(text) ||
    /^\s*<html/i.test(text)
  ) {
    const doGetHint = plainText.toLowerCase().includes('doget')
      ? ' The deployed web app could not find doGet; add doGet(e) and deploy a new web-app version.'
      : ' Verify the Apps Script web-app deployment and access settings.'
    return `Expected JSON but Apps Script returned HTML.${doGetHint}`
  }
  return 'Expected a JSON response from Apps Script.'
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
