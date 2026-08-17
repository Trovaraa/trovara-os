import { logApiEvent } from './api-log.js'
import { getLlmConfig } from './llm.js'

export const EMBEDDING_DIMENSIONS = 1536

export function embeddingModel(): string {
  return process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small'
}

export function isEmbeddingConfigured(): boolean {
  return getLlmConfig() !== null
}

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return []
  const config = getLlmConfig()
  if (!config) throw new Error('Embedding service is not configured')

  const model = embeddingModel()
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: inputs, dimensions: EMBEDDING_DIMENSIONS }),
  })
  if (!response.ok) {
    const body = await response.text()
    logApiEvent('llm_error', { status: response.status, endpoint: 'embeddings' })
    console.error('Embedding request failed:', { status: response.status, body: body.slice(0, 300) })
    throw new Error(`Embedding request failed (${response.status})`)
  }

  const payload = (await response.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>
  }
  const ordered = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  if (ordered.length !== inputs.length) throw new Error('Embedding service returned an incomplete result')
  return ordered.map((item) => {
    const embedding = item.embedding
    if (
      !Array.isArray(embedding) ||
      embedding.length !== EMBEDDING_DIMENSIONS ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error('Embedding service returned an invalid vector')
    }
    return embedding
  })
}
