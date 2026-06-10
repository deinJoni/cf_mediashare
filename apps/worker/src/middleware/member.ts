import type { MiddlewareHandler } from 'hono'
import type { AppBindings } from '../env.js'
import { getUserByEmail } from '../lib/db.js'
import { apiError } from '../lib/errors.js'

/**
 * Member resolution (F2) — maps the Access-verified email to a `users` row.
 *
 * Access only proves *who* the requester is; whether they exist in this
 * deployment's member list is decided here, against D1. Runs after
 * `accessMiddleware`, so `email` is always set.
 */
export const memberMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const row = await getUserByEmail(c.env.DB, c.get('email'))
  if (!row) {
    return c.json(apiError('not_a_member'), 403)
  }
  c.set('user', { id: row.id, email: row.email, isAdmin: !!row.is_admin })
  return next()
}
