import 'server-only'

import { S3Client } from '@aws-sdk/client-s3'

/**
 * Cloudflare R2, spoken to over its S3-compatible API.
 *
 * Credentials are server-side only. The browser never holds them — it gets a
 * presigned PUT URL, uses it once, and that is the whole of its access.
 */
export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

export const R2_BUCKET = process.env.R2_BUCKET!
