import { afterEach, describe, expect, it, vi } from 'vitest'
import { externalFetch } from './external-http.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('externalFetch', () => {
  it('retries a retryable GET only within the configured bound', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await externalFetch('https://example.test', {}, { retries: 1, retryBaseMs: 1 })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry unsafe requests unless explicitly idempotent', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await externalFetch(
      'https://example.test',
      { method: 'POST' },
      { retries: 2, retryBaseMs: 1 },
    )

    expect(response.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts an attempt at its deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
      ),
    )

    await expect(
      externalFetch('https://example.test', {}, { timeoutMs: 5, retries: 0 }),
    ).rejects.toThrow(/deadline exceeded/)
  })
})
