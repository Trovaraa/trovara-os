import { describe, expect, it } from 'vitest'
import { validateLlmBaseUrl } from './llm.js'

describe('validateLlmBaseUrl', () => {
  it('accepts https OpenAI default', () => {
    const result = validateLlmBaseUrl('https://api.openai.com/v1')
    expect(result.ok).toBe(true)
  })

  it('rejects localhost', () => {
    const result = validateLlmBaseUrl('https://127.0.0.1:11434/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/127\.0\.0\.1/)
  })

  it('rejects private RFC1918 hosts', () => {
    const result = validateLlmBaseUrl('https://10.0.0.5/v1')
    expect(result.ok).toBe(false)
  })

  it('strips trailing slashes', () => {
    const result = validateLlmBaseUrl('https://api.openai.com/v1/')
    expect(result).toEqual({ ok: true, url: 'https://api.openai.com/v1' })
  })
})
