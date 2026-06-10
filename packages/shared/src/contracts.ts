/**
 * API contracts — request/response shapes shared by web and worker.
 *
 * Working principle (DEVELOPMENT.md): contracts first. Zod schemas are the single
 * source of truth; TS types are inferred from them so the wire format and the
 * compile-time types can never drift.
 *
 * Phase 0 establishes the pattern with the identity endpoint. Phase 1 fills in
 * `/me`; Phase 2 *locks* the upload/serve contracts. Add new schemas here.
 */
import { z } from 'zod'

/** Standard error envelope returned by every failing endpoint. */
export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
})

/** `GET /api/me` — the signed-in member's identity and resolved groups. (F1, F2) */
export const MeResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
  }),
  groups: z.array(GroupSchema),
})
export type MeResponse = z.infer<typeof MeResponseSchema>

/** `GET /api/health` — liveness, used by CI and canary checks. */
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>
