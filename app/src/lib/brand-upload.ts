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
      throw new Error(asset.processingError || 'Processing failed')
    }
    onProgress?.({
      phase: 'processing',
      uploadPercent: 100,
      message: 'Processing…',
    })
  }
  throw new Error('Processing timed out')
}
