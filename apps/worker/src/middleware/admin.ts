import type { MiddlewareHandler } from 'hono'
import type { AppBindings } from '../env.js'
import { apiError } from '../lib/errors.js'

/**
 * Admin gate (F2) for `/api/admin/*`. Runs after `memberMiddleware`, so `user`
 * is always set; only operators (`is_admin = 1`) may manage members and groups.
 * Everyone else — ordinary members included — gets a 403, the same way the
 * per-item F7 gate keeps non-owners out of delete/recaption.
 */
export const adminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get('user').isAdmin) {
    return c.json(apiError('forbidden', 'Admin only'), 403)
  }
  return next()
}
