import { Hono } from 'hono'
import type { HealthResponse, MeResponse } from '@cf-mediashare/shared'
import type { AppBindings } from './env.js'
import { accessMiddleware } from './middleware/access.js'

const app = new Hono<AppBindings>()

/** Public liveness probe — used by CI and post-deploy canary checks. */
app.get('/api/health', (c) => {
  const body: HealthResponse = { ok: true, service: 'cf-mediashare' }
  return c.json(body)
})

/**
 * `GET /api/me` — identity + resolved groups (F1, F2).
 * Phase 0: returns the verified email with no groups. Phase 1 resolves real
 * groups from D1.
 */
app.get('/api/me', accessMiddleware, (c) => {
  const email = c.get('email')
  const body: MeResponse = {
    user: { id: email, email },
    groups: [],
  }
  return c.json(body)
})

/**
 * Everything else falls through to the built web app (static assets). The
 * `assets` config in wrangler.jsonc already routes non-`/api/*` paths to the
 * asset server with SPA fallback; this handler keeps the Worker correct even if
 * a request reaches it.
 */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
