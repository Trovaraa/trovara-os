import { describe, expect, it } from 'vitest'
import { isAllowedAudioDataUrl, parseAudioDataUrl } from './sanitize-input.js'

const tiny = Buffer.from('hello').toString('base64')

describe('parseAudioDataUrl / isAllowedAudioDataUrl', () => {
  it('accepts clean webm and mp4 data URLs', () => {
    expect(isAllowedAudioDataUrl(`data:audio/webm;base64,${tiny}`)).toBe(true)
    expect(isAllowedAudioDataUrl(`data:audio/mp4;base64,${tiny}`)).toBe(true)
    expect(parseAudioDataUrl(`data:audio/mp4;base64,${tiny}`)?.filename).toBe('voice.m4a')
  })

  it('accepts iOS Safari mime with space after semicolon and codecs', () => {
    const url = `data:audio/mp4; codecs=mp4a.40.2;base64,${tiny}`
    expect(isAllowedAudioDataUrl(url)).toBe(true)
    expect(parseAudioDataUrl(url)?.mime).toBe('audio/mp4')
  })

  it('accepts quoted codec params', () => {
    const url = `data:audio/mp4;codecs="mp4a.40.2";base64,${tiny}`
    expect(isAllowedAudioDataUrl(url)).toBe(true)
  })

  it('accepts audio/aac and video/mp4 (iOS mislabel)', () => {
    expect(isAllowedAudioDataUrl(`data:audio/aac;base64,${tiny}`)).toBe(true)
    expect(isAllowedAudioDataUrl(`data:video/mp4;base64,${tiny}`)).toBe(true)
    expect(parseAudioDataUrl(`data:video/mp4;base64,${tiny}`)?.filename).toBe('voice.m4a')
  })

  it('rejects non-audio and empty payloads', () => {
    expect(isAllowedAudioDataUrl(`data:image/png;base64,${tiny}`)).toBe(false)
    expect(isAllowedAudioDataUrl(`data:application/octet-stream;base64,${tiny}`)).toBe(false)
    expect(isAllowedAudioDataUrl('data:audio/mp4;base64,')).toBe(false)
  })
})
