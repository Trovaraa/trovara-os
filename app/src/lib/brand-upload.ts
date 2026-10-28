import { getCsrfToken, resolveApiUrl } from './api'

export type BrandAssetDto = {
  id: string
  originalName: string
  mimeType: string
  byteSize: number | null
  width: number | null
  height: number | null
  mediaKind: 'image' | 'video'
  status: 'uploading' | 'processing' | 'ready' | 'failed'
  processingError: string | null
  durationSeconds: number | null
  previewUrl: string | null
  posterUrl: string | null
  createdAt: string
  updatedAt?: string
}

export type BrandUploadProgress = {
  phase: 'upload' | 'processing'
  uploadPercent: number
  message: string
}

function messageFromBody(body: unknown, status: number): string {
  if (!body || typeof body !== 'object') return `Request failed (${status})`
  const err = (body as { error?: unknown }).error
  if (typeof err === 'string' && err.trim()) return err
  return `Request failed (${status})`
}

export function uploadBrandAsset(
  file: File,
  options: {
    replaceAssetId?: string
    onProgress?: (progress: BrandUploadProgress) => void
  } = {},
): Promise<BrandAssetDto> {
  const { replaceAssetId, onProgress } = options
  if (!replaceAssetId) return uploadResumable(file, onProgress)
  const path = replaceAssetId
    ? `/api/brand/assets/upload/${replaceAssetId}`
    : '/api/brand/assets/upload'
  const method = replaceAssetId ? 'PATCH' : 'POST'

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, resolveApiUrl(path))
    xhr.withCredentials = true
    const csrf = getCsrfToken()
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('X-Brand-Original-Name', file.name)

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)))
      onProgress?.({
        phase: 'upload',
        uploadPercent: percent,
        message: `Uploading… ${percent}%`,
      })
    }

    xhr.onload = async () => {
      let body: unknown = {}
      try {
        body = JSON.parse(xhr.responseText || '{}')
      } catch {
        /* ignore */
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(messageFromBody(body, xhr.status)))
        return
      }
      const asset = (body as { asset: BrandAssetDto }).asset
      if (!asset) {
        reject(new Error('Upload response missing asset'))
        return
      }
      if (asset.status === 'ready') {
        resolve(asset)
        return
      }
      onProgress?.({
        phase: 'processing',
        uploadPercent: 100,
        message: 'Processing…',
      })
      try {
        resolve(await pollBrandAsset(asset.id, onProgress))
      } catch (error) {
        reject(error)
      }
    }

    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.send(file)
  })
}

type Session = { id: string; offset: number; total: number; chunkBytes: number; completed: boolean }
const sessions = new WeakMap<File, Session>()

class UploadError extends Error {
  constructor(message: string, public status: number) { super(message) }
}
async function uploadRequest<T>(path: string, method = 'GET', body?: BodyInit, extra: Record<string, string> = {}): Promise<T> {
  const csrf = getCsrfToken()
  const response = await fetch(resolveApiUrl(path), {
    method, body, credentials: 'include', signal: AbortSignal.timeout(120_000),
    headers: { Accept: 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new UploadError(messageFromBody(data, response.status), response.status)
  return data as T
}

async function uploadResumable(file: File, onProgress?: (progress: BrandUploadProgress) => void): Promise<BrandAssetDto> {
  if (!file.size || file.size > 500 * 1024 * 1024) throw new Error('Select a file between 1 byte and 500 MiB.')
  const base = '/api/brand/assets/upload/session'
  let session = sessions.get(file)
  if (!session) {
    const result = await uploadRequest<{ session: Session }>(base, 'POST', JSON.stringify({ name: file.name, mime: file.type, total: file.size }), { 'Content-Type': 'application/json' })
    session = result.session
    sessions.set(file, session)
  }
  let failures = 0
  while (true) {
    try {
      // Always ask for the committed offset: a response may have been lost.
      session = (await uploadRequest<{ session: Session }>(`${base}/${session.id}`)).session
      sessions.set(file, session)
      if (session.offset >= file.size) break
      onProgress?.({ phase: 'upload', uploadPercent: Math.round(session.offset / file.size * 100), message: `Uploading… ${Math.round(session.offset / file.size * 100)}%` })
      session = (await uploadRequest<{ session: Session }>(`${base}/${session.id}`, 'PATCH', file.slice(session.offset, session.offset + session.chunkBytes), {
        'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(session.offset),
      })).session
      sessions.set(file, session)
      failures = 0
    } catch (error) {
      if (error instanceof UploadError && (error.status === 404 || (error.status === 409 && error.message.includes('expired')))) {
        sessions.delete(file)
        throw error
      }
      if (error instanceof UploadError && [400, 401, 403, 413].includes(error.status)) throw error
      if (++failures > 3) throw error
      await new Promise(resolve => setTimeout(resolve, failures * 1000))
    }
  }
  const { asset } = await uploadRequest<{ asset: BrandAssetDto }>(`${base}/${session.id}/complete`, 'POST')
  if (asset.status === 'failed') {
    sessions.delete(file)
    throw new Error(asset.processingError || 'Processing failed. Retry to upload a fresh copy.')
  }
  if (asset.status === 'ready') return asset
  onProgress?.({ phase: 'processing', uploadPercent: 100, message: 'Uploaded. Scanning and optimizing video…' })
  try { return await pollBrandAsset(asset.id, onProgress) }
  catch (error) {
    if (error instanceof UploadError && error.status === 422) sessions.delete(file)
    throw error
  }
}

async function pollBrandAsset(
  assetId: string,
  onProgress?: (progress: BrandUploadProgress) => void,
): Promise<BrandAssetDto> {
  const started = Date.now()
  const timeoutMs = 15 * 60 * 1000
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const res = await fetch(resolveApiUrl(`/api/brand/assets/${assetId}`), {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(messageFromBody(body, res.status))
    }
    const data = (await res.json()) as { asset: BrandAssetDto }
    const asset = data.asset
    if (asset.status === 'ready') return asset
    if (asset.status === 'failed') {
      throw new UploadError(asset.processingError || 'Processing failed', 422)
    }
    onProgress?.({
      phase: 'processing',
      uploadPercent: 100,
      message: 'Processing…',
    })
  }
  throw new Error('Processing timed out')
}
