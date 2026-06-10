import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { MiddlewareHandler } from 'hono'
import type { AppBindings } from '../env.js'
import { apiError } from '../lib/errors.js'

/**
 * Cloudflare Access enforcement — the only gate (DEVELOPMENT.md, F1).
 *
 * Every protected request must carry a verifiable Access JWT in the
 * `Cf-Access-Jwt-Assertion` header. The verified member email is stashed on
 * the context for downstream group filtering.
 *
 * Local dev keeps the Phase-0 stub (DEV_STUB_ACCESS) so the slice runs without
 * Zero Trust configured; production verifies against the team's public keys.
 */

/**
 * Remote JWKS fetchers, cached at module scope per team domain so the certs
 * endpoint is fetched once per isolate instead of once per request (jose
 * refreshes on its own when it sees an unknown kid / key rotation).
 */
const jwksByTeamDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByTeamDomain.get(teamDomain)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))
    jwksByTeamDomain.set(teamDomain, jwks)
  }
  return jwks
}

export const accessMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.env.DEV_STUB_ACCESS === 'true') {
    // Stub mode only: an X-Dev-Stub-Email header lets local testing switch
    // identities per-request (e.g. to exercise the permission matrix) without
    // editing .dev.vars. Unreachable in production — the stub is never set there.
    const override = c.req.header('X-Dev-Stub-Email')
    c.set('email', (override || c.env.DEV_STUB_EMAIL || 'dev@example.com').toLowerCase())
    return next()
  }

  // Tolerate a pasted-in "https://team.cloudflareaccess.com" — we need the bare host.
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(
    /\/+$/,
    '',
  )
  if (!teamDomain || !c.env.ACCESS_AUD) {
    return c.json(
      apiError(
        'unauthorized',
        'ACCESS_TEAM_DOMAIN / ACCESS_AUD are not configured and DEV_STUB_ACCESS is off',
      ),
      401,
    )
  }

  const token = c.req.header('Cf-Access-Jwt-Assertion')
  if (!token) {
    return c.json(apiError('unauthorized', 'Missing Access JWT'), 401)
  }

  try {
    const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience: c.env.ACCESS_AUD,
    })
    const email = payload.email
    if (typeof email !== 'string' || email === '') {
      return c.json(apiError('unauthorized', 'Access JWT carries no email claim'), 401)
    }
    // Lowercased so membership lookups are case-insensitive on the seam.
    c.set('email', email.toLowerCase())
  } catch {
    return c.json(apiError('unauthorized', 'Invalid Access JWT'), 401)
  }

  return next()
}
