/** Shared Brand Kit upload / transcode limits. */

export const BRAND_MAX_UPLOAD_BYTES = Number(
  process.env.BRAND_UPLOAD_MAX_BYTES?.trim() || 500 * 1024 * 1024,
)
export const BRAND_MAX_VIDEO_DURATION_SEC = Number(
  process.env.BRAND_UPLOAD_MAX_DURATION_SEC?.trim() || 600,
)
/** Legacy JSON data-URL path for small static images. */
export const BRAND_MAX_DATA_URL_DECODED = 10_000_000
export const BRAND_MAX_DATA_URL_LENGTH = 14_000_000

export const BRAND_CRF = 18

export type BrandMediaKind = 'image' | 'video'
export type BrandAssetStatus = 'uploading' | 'processing' | 'ready' | 'failed'

export const BRAND_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'image/heic',
  'image/heif',
])

export const BRAND_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime',
  'video/hevc',
  'video/x-hevc',
  'video/3gpp',
  'video/3gpp2',
])

export const BRAND_PASSTHROUGH_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
])

export function mediaKindForMime(mime: string): BrandMediaKind | null {
  const normalized = mime.toLowerCase()
  if (BRAND_IMAGE_MIME.has(normalized)) return 'image'
  if (BRAND_VIDEO_MIME.has(normalized)) return 'video'
  return null
}

export function normalizeBrandMime(raw: string | null | undefined, filename?: string): string | null {
  const fromHeader = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (fromHeader && (BRAND_IMAGE_MIME.has(fromHeader) || BRAND_VIDEO_MIME.has(fromHeader))) {
    return fromHeader
  }
  const name = (filename ?? '').toLowerCase()
  if (name.endsWith('.heic')) return 'image/heic'
  if (name.endsWith('.heif')) return 'image/heif'
  if (name.endsWith('.mov')) return 'video/quicktime'
  if (name.endsWith('.mp4') || name.endsWith('.m4v')) return 'video/mp4'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.3gp')) return 'video/3gpp'
  return fromHeader || null
}
