import type { MiddlewareHandler } from 'hono'
import type { AppBindings } from '../env.js'

/**
 * Cloudflare Access enforcement — the only gate (DEVELOPMENT.md, F1).
 *
 * Every protected request must carry a verifiable Access JWT in the
 * `Cf-Access-Jwt-Assertion` header. The verified member email is stashed on the
 * context for downstream group filtering.
 *
 * Phase 0 ships a local-dev stub (DEV_STUB_ACCESS) so the slice runs without
 * Zero Trust configured. Real JWT verification against the team's public keys
 * lands in Phase 1.
 */
export const accessMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.env.DEV_STUB_ACCESS === 'true') {
    c.set('email', c.env.DEV_STUB_EMAIL || 'dev@example.com')
    return next()
  }

  const token = c.req.header('Cf-Access-Jwt-Assertion')
  if (!token) {
    return c.json({ error: 'unauthorized', message: 'Missing Access JWT' }, 401)
  }

  // TODO(phase-1): verify `token` against
  //   https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs
  // check `aud` === ACCESS_AUD and expiry, then derive the email from the
  // verified claims and `c.set('email', ...)`.
  return c.json({ error: 'not_implemented', message: 'JWT verification lands in Phase 1' }, 501)
}
