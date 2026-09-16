// The routes in index.js are bounded JSON handlers, not arbitrary HTTP proxy
// handlers. Register them through both carriers: the legacy Web server routes
// (kind/exact) and Connection's authenticated carrier-neutral channel (desktop
// IPC, /api prefix). Either service may arrive after the plugin, so both
// registrations are reactive ctx.inject children.
import { Readable } from 'node:stream'

const MAX_BODY_BYTES = 1024 * 1024

export function connectionRoute(route) {
  if (!route.path.startsWith('/dsh-remote-status/')) {
    throw new Error('dsh-remote-status: expected a plugin route under /dsh-remote-status/')
  }
  return {
    path: '/api' + route.path,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const chunks = []
      let size = 0
      const reader = request.body?.getReader()
      try {
        if (reader) {
          while (true) {
            request.signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_BODY_BYTES) {
              await reader.cancel()
              return Response.json({ ok: false, error: 'request body too large' }, { status: 413 })
            }
            chunks.push(Buffer.from(value))
          }
        }
      } finally {
        reader?.releaseLock()
      }
      request.signal.throwIfAborted()
      const url = new URL(request.url)
      const req = Readable.from(size ? [Buffer.concat(chunks, size)] : [])
      req.method = request.method
      req.url = route.path + url.search
      const headers = new Headers()
      let response
      const res = {
        statusCode: 200,
        setHeader(key, value) { headers.set(key, value) },
        end(body) { response = new Response(body, { status: this.statusCode, headers }) },
      }
      try {
        await route.handler(req, res)
        if (!response) throw new Error('JSON handler did not finish its response')
        return response
      } finally {
        req.destroy()
      }
    },
  }
}

export function registerHttpTransports(ctx, routes) {
  ctx.inject(['webServer'], (inner) => {
    const disposers = routes.map((route) => inner.get('webServer').register(route))
    inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-remote-status.web-routes')
  })
  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    if (typeof connection.fetch?.register !== 'function') return
    const disposers = []
    const failed = []
    for (const route of routes) {
      try {
        disposers.push(connection.fetch.register(connectionRoute(route)))
      } catch (err) {
        failed.push(route.path + ': ' + String((err && err.message) || err))
      }
    }
    inner.effect(() => () => Promise.all(disposers.map((dispose) => dispose())), 'dsh-remote-status.fetch-routes')
    if (failed.length) {
      console.warn('[dsh-remote-status] some Connection Fetch routes did not register:', failed.join('; '))
    }
  })
}