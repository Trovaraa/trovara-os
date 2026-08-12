import { describe, expect, it } from 'vitest'
import { BRAND_CRF, mediaKindForMime, normalizeBrandMime } from './brand-limits.js'
import { videoTranscodeArgs } from './brand-transcode.js'
import { isBrandUploadPath } from '../middleware/security.js'

describe('brand limits', () => {
  it('classifies iPhone photo and video MIME types', () => {
    expect(mediaKindForMime('image/heic')).toBe('image')
    expect(mediaKindForMime('image/heif')).toBe('image')
    expect(mediaKindForMime('video/quicktime')).toBe('video')
    expect(mediaKindForMime('video/mp4')).toBe('video')
    expect(mediaKindForMime('application/pdf')).toBeNull()
  })

  it('normalizes extension-based MIME when the header is missing', () => {
    expect(normalizeBrandMime(null, 'clip.MOV')).toBe('video/quicktime')
    expect(normalizeBrandMime('', 'photo.HEIC')).toBe('image/heic')
    expect(normalizeBrandMime('video/mp4; codecs=avc1', 'x.mp4')).toBe('video/mp4')
  })
})

describe('brand transcode flags', () => {
  it('preserves source dimensions and uses visually-lossless CRF', () => {
    const args = videoTranscodeArgs('/tmp/in.mov', '/tmp/out.mp4')
    expect(args).toContain('-vf')
    expect(args).toContain('scale=iw:ih')
    expect(args).toContain('-crf')
    expect(args).toContain(String(BRAND_CRF))
    expect(args).toContain('libx264')
    expect(args).toContain('+faststart')
  })
})

describe('brand upload body limit path', () => {
  it('matches only streaming upload routes', () => {
    expect(isBrandUploadPath('/api/brand/assets/upload')).toBe(true)
    expect(isBrandUploadPath('/api/brand/assets/upload/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(
      true,
    )
    expect(isBrandUploadPath('/api/brand/assets')).toBe(false)
    expect(isBrandUploadPath('/api/brand/packs')).toBe(false)
  })
})
