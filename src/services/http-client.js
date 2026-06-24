const DEFAULT_TIMEOUT_MS = 15000

export async function fetchWithTimeout(url, options = {}, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  retries = 0,
} = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchOnce(url, options, { timeoutMs, fetchImpl })
      if (attempt < retries && [429, 502, 503, 504].includes(response.status)) {
        await sleep(250 * (2 ** attempt))
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt >= retries) throw error
      await sleep(250 * (2 ** attempt))
    }
  }
  throw lastError
}

async function fetchOnce(url, options, { timeoutMs, fetchImpl }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`)), timeoutMs)
  timeout.unref?.()
  try {
    return await fetchImpl(url, {
      ...options,
      signal: options.signal || controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`HTTP request timed out after ${timeoutMs}ms`)
      timeoutError.code = 'HTTP_TIMEOUT'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
