/** Client-side resize/compress so iPhone camera photos fit journal upload limits. */

const MAX_EDGE_PX = 1600
const MAX_DATA_URL_CHARS = 1_900_000
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45]

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('UNSUPPORTED_IMAGE'))
    }
    img.src = url
  })
}

function canvasToJpegDataUrl(canvas: HTMLCanvasElement, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('COMPRESS_FAILED'))
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result === 'string') resolve(reader.result)
          else reject(new Error('COMPRESS_FAILED'))
        }
        reader.onerror = () => reject(new Error('COMPRESS_FAILED'))
        reader.readAsDataURL(blob)
      },
      'image/jpeg',
      quality,
    )
  })
}

/**
 * Returns a JPEG data URL under the API journal media size budget.
 * Throws Error with code-like message: UNSUPPORTED_IMAGE | IMAGE_TOO_LARGE | COMPRESS_FAILED
 */
export async function prepareJournalCoverDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new Error('UNSUPPORTED_IMAGE')
  }

  const img = await loadImage(file)
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height))
  const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale))
  const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('COMPRESS_FAILED')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)

  let lastError: Error | null = null
  for (const quality of QUALITY_STEPS) {
    try {
      const dataUrl = await canvasToJpegDataUrl(canvas, quality)
      if (dataUrl.length <= MAX_DATA_URL_CHARS) return dataUrl
      lastError = new Error('IMAGE_TOO_LARGE')
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('COMPRESS_FAILED')
    }
  }
  throw lastError ?? new Error('IMAGE_TOO_LARGE')
}
