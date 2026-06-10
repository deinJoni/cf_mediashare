/**
 * Cloudflare Access allow-list sync (F2).
 *
 * D1 is the authoritative gate — the Worker enforces membership on every API
 * and serve request — but a member also has to clear the *outer* Access gate to
 * load the app at all. When the deployer configures a Cloudflare API token, the
 * admin UI keeps the two in step: inviting a member adds their email to the
 * Access policy's allow-list, removing one takes it back out.
 *
 * Everything here is best-effort and never throws into a route. The caller has
 * already committed the authoritative D1 change; an Access API hiccup yields a
 * `failed`/`skipped` status the UI surfaces so the operator can reconcile by
 * hand, not a 500 that masks the successful membership change.
 *
 * Assumes the deployment's Access app carries an `allow` policy whose `include`
 * holds individual email rules (the shape `DEPLOY.md` provisions). Emails
 * granted via domain / everyone / email-list rules are left untouched.
 */
import type { AccessSyncStatus } from '@cf-mediashare/shared'
import type { Env } from '../env.js'

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
/** Cap each Access API call so a slow CF response can't hang the admin request. */
const CF_API_TIMEOUT_MS = 8000

export interface AccessSyncResult {
  status: AccessSyncStatus
  message?: string
}

/** One rule inside a policy's include/exclude/require array. Only `email` is read. */
interface AccessRule {
  email?: { email: string }
  [key: string]: unknown
}

interface AccessApp {
  id: string
  aud?: string
  name?: string
}

interface AccessPolicy {
  id: string
  name?: string
  decision?: string
  include?: AccessRule[]
  exclude?: AccessRule[]
  require?: AccessRule[]
  precedence?: number
  session_duration?: string
}

interface CfEnvelope<T> {
  success: boolean
  errors?: { code?: number; message?: string }[]
  result: T
}

/** Resolved (appId, policyId) cached per isolate so we discover them at most once. */
const targetCache = new Map<string, { appId: string; policyId: string }>()

/**
 * True when the admin UI can edit the Access allow-list: an API token plus
 * enough config to locate the app (its AUD, or a pinned app id). When false the
 * admin surface manages D1 only and tells the operator to edit Access by hand.
 */
export function accessSyncEnabled(env: Env): boolean {
  return Boolean(
    env.CLOUDFLARE_API_TOKEN && env.CF_ACCOUNT_ID && (env.ACCESS_AUD || env.ACCESS_APP_ID),
  )
}

async function cfApi<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN ?? ''}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(CF_API_TIMEOUT_MS),
  })
  const body = (await res.json().catch(() => null)) as CfEnvelope<T> | null
  if (!res.ok || !body?.success) {
    const detail = body?.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join('; ')
    throw new Error(
      `Cloudflare API ${path} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  return body.result
}

/** Discover the Access application id by matching the configured AUD. */
async function resolveAppId(env: Env): Promise<string> {
  if (env.ACCESS_APP_ID) return env.ACCESS_APP_ID
  const apps = await cfApi<AccessApp[]>(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps`)
  const app = apps.find((a) => a.aud && a.aud === env.ACCESS_AUD)
  if (!app) {
    throw new Error('No Access application matches ACCESS_AUD (set ACCESS_APP_ID to pin it)')
  }
  return app.id
}

/** Pick the allow policy to manage — the one named "members" (DEPLOY.md default), else the first allow. */
function pickAllowPolicy(policies: AccessPolicy[]): AccessPolicy | undefined {
  const allow = policies.filter((p) => p.decision === 'allow')
  return allow.find((p) => p.name?.toLowerCase() === 'members') ?? allow[0]
}

async function resolveTarget(env: Env): Promise<{ appId: string; policyId: string }> {
  const cacheKey = `${env.CF_ACCOUNT_ID}|${env.ACCESS_APP_ID ?? ''}|${env.ACCESS_AUD ?? ''}|${env.ACCESS_POLICY_ID ?? ''}`
  const cached = targetCache.get(cacheKey)
  if (cached) return cached

  const appId = await resolveAppId(env)
  let policyId = env.ACCESS_POLICY_ID
  if (!policyId) {
    const policies = await cfApi<AccessPolicy[]>(
      env,
      `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}/policies`,
    )
    const policy = pickAllowPolicy(policies)
    if (!policy) {
      throw new Error('Access application has no allow policy to sync (set ACCESS_POLICY_ID)')
    }
    policyId = policy.id
  }
  const target = { appId, policyId }
  targetCache.set(cacheKey, target)
  return target
}

/** Drop the cached target so the next call re-discovers (after a 404/edit error). */
function invalidateTarget(env: Env): void {
  const cacheKey = `${env.CF_ACCOUNT_ID}|${env.ACCESS_APP_ID ?? ''}|${env.ACCESS_AUD ?? ''}|${env.ACCESS_POLICY_ID ?? ''}`
  targetCache.delete(cacheKey)
}

async function getPolicy(env: Env, appId: string, policyId: string): Promise<AccessPolicy> {
  return cfApi<AccessPolicy>(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}/policies/${policyId}`,
  )
}

async function putPolicy(env: Env, appId: string, policy: AccessPolicy): Promise<void> {
  // Echo back only the writable fields; CF rejects unknown/read-only keys.
  const payload: Record<string, unknown> = {
    name: policy.name,
    decision: policy.decision,
    include: policy.include ?? [],
    exclude: policy.exclude ?? [],
    require: policy.require ?? [],
  }
  if (policy.precedence !== undefined) payload.precedence = policy.precedence
  if (policy.session_duration !== undefined) payload.session_duration = policy.session_duration
  await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}/policies/${policy.id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

function individualEmails(policy: AccessPolicy): string[] {
  return (policy.include ?? [])
    .map((r) => r.email?.email)
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.toLowerCase())
}

/**
 * The set of individually-listed allow-list emails, or `null` if sync is off or
 * the list couldn't be read. Emails granted via domain/everyone/email-list
 * rules are not represented here (they can't be expanded in one call).
 */
export async function getAllowlistEmails(env: Env): Promise<Set<string> | null> {
  if (!accessSyncEnabled(env)) return null
  try {
    const { appId, policyId } = await resolveTarget(env)
    const policy = await getPolicy(env, appId, policyId)
    return new Set(individualEmails(policy))
  } catch (err) {
    console.error('Access allow-list read failed', err)
    invalidateTarget(env)
    return null
  }
}

export async function addEmailToAllowlist(env: Env, email: string): Promise<AccessSyncResult> {
  if (!accessSyncEnabled(env)) {
    return { status: 'disabled', message: 'Access sync is not configured.' }
  }
  const wanted = email.toLowerCase()
  try {
    const { appId, policyId } = await resolveTarget(env)
    const policy = await getPolicy(env, appId, policyId)
    if (individualEmails(policy).includes(wanted)) {
      return { status: 'synced' } // already allowed
    }
    policy.include = [...(policy.include ?? []), { email: { email: wanted } }]
    await putPolicy(env, appId, policy)
    return { status: 'synced' }
  } catch (err) {
    console.error('Access allow-list add failed', err)
    invalidateTarget(env)
    return {
      status: 'failed',
      message:
        'Added to the member list, but updating the Cloudflare Access allow-list failed — add the email in the Access dashboard.',
    }
  }
}

export async function removeEmailFromAllowlist(env: Env, email: string): Promise<AccessSyncResult> {
  if (!accessSyncEnabled(env)) {
    return { status: 'disabled', message: 'Access sync is not configured.' }
  }
  const wanted = email.toLowerCase()
  try {
    const { appId, policyId } = await resolveTarget(env)
    const policy = await getPolicy(env, appId, policyId)
    const before = policy.include ?? []
    const after = before.filter((r) => r.email?.email?.toLowerCase() !== wanted)
    if (after.length === before.length) {
      // Not individually listed — likely allowed via a domain/everyone/list rule.
      return {
        status: 'skipped',
        message:
          'Removed from the member list. Their email was not an individual Access entry — if they still have access via a broader Access rule, adjust it in the dashboard.',
      }
    }
    policy.include = after
    await putPolicy(env, appId, policy)
    return { status: 'synced' }
  } catch (err) {
    console.error('Access allow-list remove failed', err)
    invalidateTarget(env)
    return {
      status: 'failed',
      message:
        'Removed from the member list, but updating the Cloudflare Access allow-list failed — remove the email in the Access dashboard.',
    }
  }
}
