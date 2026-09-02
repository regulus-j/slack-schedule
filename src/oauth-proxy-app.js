import { createServer } from 'node:http'
import { URL } from 'node:url'
import { logger } from './logger.js'

export async function main() {
  const targetBaseUrl = process.env.TARGET_URL
  if (!targetBaseUrl) throw new Error('TARGET_URL is required for the OAuth proxy')
  const target = new URL(targetBaseUrl)

  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/oauth/google/callback')) {
      res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' })
      res.end(req.url === '/health' ? JSON.stringify({ ok: true }) : JSON.stringify({ ok: false, error: 'not_found' }))
      return
    }

    const upstream = new URL(req.url, target)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch(upstream, {
        method: 'GET',
        headers: { accept: req.headers.accept || '*/*' },
        signal: controller.signal,
      })
      const headers = {}
      for (const name of ['content-type', 'cache-control', 'location']) {
        const value = response.headers.get(name)
        if (value) headers[name] = value
      }
      res.writeHead(response.status, headers)
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      logger.error('oauth_proxy_upstream_failed', { error })
      res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'oauth_upstream_unavailable' }))
    } finally {
      clearTimeout(timeout)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(process.env.PORT || 3000), () => {
      server.removeListener('error', reject)
      logger.info('oauth_proxy_started', { targetHost: target.host })
      resolve()
    })
  })

  const shutdown = () => new Promise((resolve) => server.close(resolve))
  process.once('SIGTERM', () => shutdown())
  process.once('SIGINT', () => shutdown())
  return { server, shutdown }
}
