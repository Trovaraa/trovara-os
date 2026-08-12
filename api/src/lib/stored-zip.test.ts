import { describe, expect, it } from 'vitest'
import { buildStoredZip } from './stored-zip.js'

describe('buildStoredZip', () => {
  it('builds a zip that contains local and central headers', () => {
    const zip = buildStoredZip([
      { name: 'logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: 'hero.jpg', data: Buffer.from('jpeg-bytes') },
    ])
    expect(zip.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true)
    expect(zip.includes(Buffer.from('logo.png'))).toBe(true)
    expect(zip.includes(Buffer.from('hero.jpg'))).toBe(true)
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true)
  })
})
