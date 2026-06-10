/** R2 helpers shared by the byte routes and the admin cascade deletes (F2). */

/** R2's bulk delete accepts at most 1000 keys per call. */
const R2_DELETE_BATCH = 1000

/**
 * Delete many objects, chunked under R2's per-call key limit. Used when
 * removing a member or a group purges every derived blob they owned — a small
 * trusted-group deployment rarely exceeds one chunk, but bound it anyway so a
 * large group can't throw on the bulk delete.
 */
export async function deleteR2Objects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH))
  }
}
