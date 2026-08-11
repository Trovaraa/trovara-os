import { describe, expect, it } from 'vitest'
import {
  hasMomentMediaSignature,
  parseMomentRange,
  stripMomentImageMetadata,
} from './moments-media.js'

describe('Moments media integrity', () => {
  it('rejects bytes that do not match the declared MIME', () => {
    expect(hasMomentMediaSignature('image/jpeg', Buffer.from('not a jpeg'))).toBe(false)
    expect(
      hasMomentMediaSignature(
        'image/png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(true)
  })

  it('removes JPEG EXIF application segments', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66,
      0xff, 0xda, 0x00, 0x02,
      0x11, 0x22, 0xff, 0xd9,
    ])
    const stripped = stripMomentImageMetadata('image/jpeg', jpeg)
    expect(stripped.includes(Buffer.from('Exif'))).toBe(false)
    expect(stripped.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('parses normal and suffix ranges and rejects unsatisfiable ranges', () => {
    expect(parseMomentRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseMomentRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseMomentRange('bytes=20-30', 10)).toBe('invalid')
    expect(parseMomentRange('items=0-1', 10)).toBe('invalid')
  })
})
