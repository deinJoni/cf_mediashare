import { Hono } from 'hono'
import type { MeResponse } from '@cf-mediashare/shared'
import type { AppBindings } from '../env.js'
import { listGroupsForUser } from '../lib/db.js'

/** `GET /api/me` — the signed-in member's identity and resolved groups (F1, F2). */
export const meRoutes = new Hono<AppBindings>().get('/me', async (c) => {
  const user = c.get('user')
  const body: MeResponse = {
    user,
    groups: await listGroupsForUser(c.env.DB, user.id),
  }
  return c.json(body)
})
