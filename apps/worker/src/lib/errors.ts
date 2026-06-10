import type { ApiError } from '@cf-mediashare/shared'

/**
 * Build the standard `{ error, message? }` envelope (ApiErrorSchema). Routes
 * pass the result to `c.json(...)` with an explicit status so every failing
 * response matches the locked contract shape.
 */
export function apiError(error: string, message?: string): ApiError {
  return message === undefined ? { error } : { error, message }
}

/**
 * Structural stand-in for `z.ZodError` — the worker doesn't declare zod as a
 * direct dependency (it only consumes the schemas re-exported by shared), so
 * we type the bits we read instead of importing the module.
 */
interface ZodIssueLike {
  path: (string | number)[]
  message: string
}

/** Compact, human-readable summary of zod issues for 400 messages. */
export function zodMessage(error: { issues: ZodIssueLike[] }): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ')
}
