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

/**
 * Two buckets, deliberately.
 *
 * ORIGINALS holds the file exactly as the phone produced it — the evidence of
 * record. Rule 4 is enforced on the EXIF capture time read out of it, and a
 * disputed claim is re-derivable from it later, so nothing may ever overwrite
 * or rewrite an object in here.
 *
 * DISPLAY holds what the browser actually renders: HEIC transcoded to
 * something browsers understand, resized for the review screen and the map.
 * Everything in here is disposable and can be regenerated from the original.
 *
 * The same object key is used in both, so claims.photo_key stays a single
 * column — the bucket is chosen by what the caller needs, not by the key.
 */
export const R2_BUCKET_ORIGINALS = process.env.R2_BUCKET_ORIGINALS!
export const R2_BUCKET_DISPLAY = process.env.R2_BUCKET_DISPLAY!
