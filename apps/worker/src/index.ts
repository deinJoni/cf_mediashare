import { Hono } from 'hono'
import type { HealthResponse } from '@cf-mediashare/shared'
import type { AppBindings } from './env.js'
import { apiError } from './lib/errors.js'
import { accessMiddleware } from './middleware/access.js'
import { memberMiddleware } from './middleware/member.js'
import { mediaRoutes } from './routes/media.js'
import { meRoutes } from './routes/me.js'
import { uploadRoutes } from './routes/uploads.js'

const app = new Hono<AppBindings>()

/** Public liveness probe — used by CI and post-deploy canary checks. */
app.get('/api/health', (c) => {
  const body: HealthResponse = { ok: true, service: 'cf-mediashare' }
  return c.json(body)
})

/**
 * Everything else under /api requires a verified Access identity (F1) that
 * resolves to a seeded member (F2). Registered after /api/health so the probe
 * stays public; per-group authorization happens inside each route, because D1
 * has no row-level security and the Worker is the single enforcement point.
 */
app.use('/api/*', accessMiddleware, memberMiddleware)

app.route('/api', meRoutes)
app.route('/api', uploadRoutes)
app.route('/api', mediaRoutes)

/** Unknown API paths get the JSON error envelope, never the SPA fallback. */
app.all('/api/*', (c) => c.json(apiError('not_found'), 404))

/** Uncaught errors stay inside the ApiError envelope contract. */
app.onError((err, c) => {
  console.error(err)
  return c.json(apiError('internal', 'Unexpected error'), 500)
})

/**
 * Everything else falls through to the built web app (static assets). The
 * `assets` config in wrangler.jsonc already routes non-`/api/*` paths to the
 * asset server with SPA fallback; this handler keeps the Worker correct even if
 * a request reaches it.
 */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
