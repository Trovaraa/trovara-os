import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIMENSIONS, embedTexts } from './embeddings.js'

const originalApiKey = process.env.OPENAI_API_KEY
const originalBaseUrl = process.env.LLM_BASE_URL

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalApiKey
  if (originalBaseUrl === undefined) delete process.env.LLM_BASE_URL
  else process.env.LLM_BASE_URL = originalBaseUrl
})

describe('embedTexts', () => {
  it('requests fixed-size vectors and preserves input order', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.LLM_BASE_URL = 'https://api.openai.com/v1'
    const first = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1)
    const second = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.2)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 1, embedding: second }, { index: 0, embedding: first }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedTexts(['first', 'second'])
    expect(result).toEqual([first, second])
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request).toMatchObject({ model: 'text-embedding-3-small', dimensions: 1536 })
  })

  it('rejects vectors with an unexpected dimension', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.LLM_BASE_URL = 'https://api.openai.com/v1'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), { status: 200 }),
    ))
    await expect(embedTexts(['bad vector'])).rejects.toThrow(/invalid vector/)
  })
})
