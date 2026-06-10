/**
 * Direct-to-R2 presigning via the S3 API (F3): bytes go straight from the
 * browser to R2 and never transit the Worker — required so a 500 MB video
 * upload can't exhaust Worker limits. Available only when the deployer has
 * provisioned an R2 API token; otherwise callers fall back to the same-origin
 * `/api/upload-proxy/...` path.
 */
import { AwsClient } from 'aws4fetch'
import { PRESIGN_EXPIRY_SECONDS } from '@cf-mediashare/shared'
import type { UploadTarget } from '@cf-mediashare/shared'
import type { Env } from '../env.js'

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  accountId: string
  bucketName: string
}

/** Null when any piece is missing (always true in local dev) → proxy fallback. */
export function s3Credentials(env: Env): S3Credentials | null {
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CF_ACCOUNT_ID) {
    return {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      accountId: env.CF_ACCOUNT_ID,
      bucketName: env.R2_BUCKET_NAME,
    }
  }
  return null
}

/**
 * Presign a PUT for one object. With `signQuery` only the host header is part
 * of the signature, so the client stays free to send Content-Type — R2 stores
 * it as the object's httpMetadata, which the serve path later echoes back.
 */
export async function presignPut(
  creds: S3Credentials,
  key: string,
  contentType: string,
): Promise<UploadTarget> {
  const client = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  const url = new URL(
    `https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucketName}/${key}`,
  )
  url.searchParams.set('X-Amz-Expires', String(PRESIGN_EXPIRY_SECONDS))
  const signed = await client.sign(new Request(url.toString(), { method: 'PUT' }), {
    aws: { signQuery: true },
  })
  return { url: signed.url, method: 'PUT', headers: { 'Content-Type': contentType } }
}
