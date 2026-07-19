import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const templatesPath = join(dirname(fileURLToPath(import.meta.url)), '../../../whatsapp/templates.json')

export type WhatsAppConfig = {
  accessToken: string
  phoneNumberId: string
  verifyToken: string
  apiVersion: string
}

export function getWhatsAppConfig(): WhatsAppConfig | null {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN
  if (!accessToken || !phoneNumberId || !verifyToken) return null
  return {
    accessToken,
    phoneNumberId,
    verifyToken,
    apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',
  }
}

export function isWhatsAppConfigured(): boolean {
  return getWhatsAppConfig() !== null
}

type TemplateDef = {
  id: string
  name: string
  en: string
  yo: string
  pcm: string
  fr: string
}

function loadTemplates(): TemplateDef[] {
  if (!existsSync(templatesPath)) return []
  const parsed = JSON.parse(readFileSync(templatesPath, 'utf-8')) as { templates?: TemplateDef[] }
  return parsed.templates ?? []
}

export function renderTemplate(
  templateId: string,
  lang: 'en' | 'yo' | 'pcm' | 'fr',
  vars: Record<string, string>,
): string | null {
  const tpl = loadTemplates().find((t) => t.id === templateId)
  if (!tpl) return null
  let text = tpl[lang] ?? tpl.en
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, value)
  }
  return text
}

export async function sendWhatsAppText(to: string, body: string): Promise<{ messageId: string }> {
  const config = getWhatsAppConfig()
  if (!config) {
    throw new Error('WhatsApp not configured - set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN')
  }

  const normalizedTo = to.replace(/\D/g, '')
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normalizedTo,
      type: 'text',
      text: { body },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp send failed (${res.status}): ${err.slice(0, 300)}`)
  }

  const data = (await res.json()) as { messages?: { id: string }[] }
  const messageId = data.messages?.[0]?.id ?? 'unknown'
  return { messageId }
}

export async function sendWhatsAppImage(
  to: string,
  imageBuffer: Buffer,
  opts?: { caption?: string; filename?: string },
): Promise<{ messageId: string }> {
  const config = getWhatsAppConfig()
  if (!config) {
    throw new Error('WhatsApp not configured - set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN')
  }

  const filename = opts?.filename?.trim() || 'qr.png'
  const { mediaId } = await uploadWhatsAppMedia(imageBuffer, 'image/png', filename)
  const normalizedTo = to.replace(/\D/g, '')
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normalizedTo,
      type: 'image',
      image: {
        id: mediaId,
        ...(opts?.caption?.trim() ? { caption: opts.caption.trim().slice(0, 1024) } : {}),
      },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp image send failed (${res.status}): ${err.slice(0, 300)}`)
  }

  const data = (await res.json()) as { messages?: { id: string }[] }
  const messageId = data.messages?.[0]?.id ?? 'unknown'
  return { messageId }
}

export async function uploadWhatsAppMedia(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<{ mediaId: string }> {
  const config = getWhatsAppConfig()
  if (!config) {
    throw new Error('WhatsApp not configured - set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN')
  }

  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/media`
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename)

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}` },
    body: form,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp media upload failed (${res.status}): ${err.slice(0, 300)}`)
  }

  const data = (await res.json()) as { id?: string }
  if (!data.id) throw new Error('WhatsApp media upload returned no media id')
  return { mediaId: data.id }
}

export async function sendWhatsAppAudio(
  to: string,
  audioBuffer: Buffer,
): Promise<{ messageId: string }> {
  const config = getWhatsAppConfig()
  if (!config) {
    throw new Error('WhatsApp not configured - set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN')
  }

  const normalizedTo = to.replace(/\D/g, '')
  const format = (process.env.LLM_TTS_FORMAT?.trim().toLowerCase() || 'mp3').replace(/[^a-z0-9]/g, '')
  const mimeByExt: Record<string, string> = {
    mp3: 'audio/mpeg',
    mpeg: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
  }
  const mimeType = mimeByExt[format] ?? 'audio/mpeg'
  const filename = `reply.${format || 'mp3'}`
  const { mediaId } = await uploadWhatsAppMedia(audioBuffer, mimeType, filename)
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normalizedTo,
      type: 'audio',
      audio: { id: mediaId },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp audio send failed (${res.status}): ${err.slice(0, 300)}`)
  }

  const data = (await res.json()) as { messages?: { id: string }[] }
  const messageId = data.messages?.[0]?.id ?? 'unknown'
  return { messageId }
}

/**
 * Download an inbound media file (image/audio) by its Meta media ID and return
 * it as a base64 data URL suitable for passing to a vision model.
 */
const MAX_WHATSAPP_MEDIA_BYTES = 10 * 1024 * 1024

export async function downloadWhatsAppMedia(mediaId: string): Promise<string> {
  const config = getWhatsAppConfig()
  if (!config) throw new Error('WhatsApp not configured')

  // Step 1: resolve the temporary download URL for this media ID
  const metaRes = await fetch(`https://graph.facebook.com/${config.apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })
  if (!metaRes.ok) {
    throw new Error(`Media lookup failed (${metaRes.status})`)
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number }
  if (!meta.url) throw new Error('Media URL missing')
  if (meta.file_size != null && meta.file_size > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new Error('WhatsApp media file too large')
  }

  // Step 2: download the actual bytes (also needs the bearer token)
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })
  if (!fileRes.ok) {
    throw new Error(`Media download failed (${fileRes.status})`)
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer())
  if (buffer.length > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new Error('WhatsApp media file too large')
  }
  const mime = meta.mime_type ?? 'image/jpeg'
  return `data:${mime};base64,${buffer.toString('base64')}`
}

/** Download inbound media as raw bytes (for audio → transcription). */
export async function downloadWhatsAppMediaBuffer(
  mediaId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const config = getWhatsAppConfig()
  if (!config) throw new Error('WhatsApp not configured')

  const metaRes = await fetch(`https://graph.facebook.com/${config.apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })
  if (!metaRes.ok) throw new Error(`Media lookup failed (${metaRes.status})`)
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number }
  if (!meta.url) throw new Error('Media URL missing')
  if (meta.file_size != null && meta.file_size > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new Error('WhatsApp media file too large')
  }

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })
  if (!fileRes.ok) throw new Error(`Media download failed (${fileRes.status})`)

  const buffer = Buffer.from(await fileRes.arrayBuffer())
  if (buffer.length > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new Error('WhatsApp media file too large')
  }
  const mime = meta.mime_type ?? 'audio/ogg'
  const ext = mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'ogg'
  return { buffer, filename: `voice.${ext}` }
}
