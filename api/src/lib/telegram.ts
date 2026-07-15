/**
 * Telegram Bot API client. Far simpler to set up than WhatsApp - create a bot with
 * @BotFather, drop the token in TELEGRAM_BOT_TOKEN, and it works (long-polling needs
 * no public URL, ideal for laptop testing).
 */

export type TelegramConfig = { botToken: string; apiBase: string }

/**
 * Which bot a call targets. The staff butler and the customer order bot are two
 * separate BotFather bots (two tokens), sharing this client. `staff` is the
 * default so all existing callers keep talking to the butler unchanged.
 */
export type TelegramBotKind = 'staff' | 'customer'

function tokenFor(kind: TelegramBotKind): string | undefined {
  const raw =
    kind === 'customer'
      ? process.env.TELEGRAM_CUSTOMER_BOT_TOKEN
      : process.env.TELEGRAM_BOT_TOKEN
  return raw?.trim() || undefined
}

function webhookSecretFor(kind: TelegramBotKind): string | undefined {
  const raw =
    kind === 'customer'
      ? process.env.TELEGRAM_CUSTOMER_WEBHOOK_SECRET
      : process.env.TELEGRAM_WEBHOOK_SECRET
  return raw?.trim() || undefined
}

export function getTelegramConfig(kind: TelegramBotKind = 'staff'): TelegramConfig | null {
  const botToken = tokenFor(kind)
  if (!botToken) return null
  return { botToken, apiBase: `https://api.telegram.org/bot${botToken}` }
}

export function isTelegramConfigured(kind: TelegramBotKind = 'staff'): boolean {
  return getTelegramConfig(kind) !== null
}

async function tgCall<T>(
  method: string,
  body: Record<string, unknown>,
  kind: TelegramBotKind = 'staff',
): Promise<T> {
  const config = getTelegramConfig(kind)
  if (!config) throw new Error('Telegram not configured - set TELEGRAM_BOT_TOKEN')

  const res = await fetch(`${config.apiBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string }
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`)
  return data.result as T
}

/** Inline keyboard button that asks the user to share their phone contact. */
const SHARE_CONTACT_KEYBOARD = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  opts?: { withContactButton?: boolean; kind?: TelegramBotKind },
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text }
  if (opts?.withContactButton) body.reply_markup = SHARE_CONTACT_KEYBOARD
  await tgCall('sendMessage', body, opts?.kind ?? 'staff')
}

export async function sendTelegramVoice(
  chatId: number | string,
  audioBuffer: Buffer,
  opts?: { caption?: string },
): Promise<void> {
  const config = getTelegramConfig()
  if (!config) throw new Error('Telegram not configured - set TELEGRAM_BOT_TOKEN')

  const format = (process.env.LLM_TTS_FORMAT?.trim().toLowerCase() || 'mp3').replace(/[^a-z0-9]/g, '')
  const filename = `reply.${format || 'mp3'}`
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('voice', new Blob([new Uint8Array(audioBuffer)]), filename)
  if (opts?.caption?.trim()) form.append('caption', opts.caption.trim().slice(0, 1024))

  const res = await fetch(`${config.apiBase}/sendVoice`, {
    method: 'POST',
    body: form,
  })
  const data = (await res.json()) as { ok: boolean; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram sendVoice failed: ${data.description ?? res.status}`)
  }
}

/** Resolve a Telegram file_id to a base64 data URL for the vision model. */
const MAX_TELEGRAM_MEDIA_BYTES = 10 * 1024 * 1024

export async function downloadTelegramFile(fileId: string): Promise<string> {
  const config = getTelegramConfig()
  if (!config) throw new Error('Telegram not configured')

  const file = await tgCall<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
  if (!file.file_path) throw new Error('Telegram file path missing')
  if (file.file_size != null && file.file_size > MAX_TELEGRAM_MEDIA_BYTES) {
    throw new Error('Telegram file too large')
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`)
  if (!fileRes.ok) throw new Error(`Telegram file download failed (${fileRes.status})`)

  const buffer = Buffer.from(await fileRes.arrayBuffer())
  if (buffer.length > MAX_TELEGRAM_MEDIA_BYTES) {
    throw new Error('Telegram file too large')
  }
  const ext = file.file_path.split('.').pop()?.toLowerCase()
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${buffer.toString('base64')}`
}

/** Download a Telegram file as raw bytes (for audio → transcription). */
export async function downloadTelegramFileBuffer(
  fileId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const config = getTelegramConfig()
  if (!config) throw new Error('Telegram not configured')

  const file = await tgCall<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
  if (!file.file_path) throw new Error('Telegram file path missing')
  if (file.file_size != null && file.file_size > MAX_TELEGRAM_MEDIA_BYTES) {
    throw new Error('Telegram file too large')
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`)
  if (!fileRes.ok) throw new Error(`Telegram file download failed (${fileRes.status})`)

  const buffer = Buffer.from(await fileRes.arrayBuffer())
  if (buffer.length > MAX_TELEGRAM_MEDIA_BYTES) {
    throw new Error('Telegram file too large')
  }
  const filename = file.file_path.split('/').pop() ?? 'audio.oga'
  return { buffer, filename }
}

// ── Update types (only the fields we use) ────────────────────────────────────
export type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; first_name?: string; username?: string }
    chat: { id: number }
    text?: string
    caption?: string
    contact?: { phone_number: string; user_id?: number }
    photo?: { file_id: string; file_size?: number }[]
    voice?: { file_id: string; duration?: number; mime_type?: string }
    audio?: { file_id: string; duration?: number; mime_type?: string }
  }
}

/** Long-poll for updates (no public URL needed). */
export async function getTelegramUpdates(
  offset: number,
  kind: TelegramBotKind = 'staff',
): Promise<TelegramUpdate[]> {
  const config = getTelegramConfig(kind)
  if (!config) return []
  const res = await fetch(`${config.apiBase}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset, timeout: 50, allowed_updates: ['message'] }),
  })
  const data = (await res.json()) as {
    ok: boolean
    result?: TelegramUpdate[]
    description?: string
    error_code?: number
  }
  if (!data.ok) {
    // Common: webhook still set → 409 Conflict; polling then receives zero updates forever.
    console.error(
      'Telegram getUpdates failed:',
      data.error_code ?? res.status,
      data.description ?? 'unknown error',
    )
    throw new Error(data.description ?? `Telegram getUpdates failed (${data.error_code ?? res.status})`)
  }
  return data.result ?? []
}

export async function setTelegramWebhook(
  url: string,
  kind: TelegramBotKind = 'staff',
): Promise<void> {
  const body: Record<string, unknown> = { url, allowed_updates: ['message'] }
  // Telegram echoes this back as X-Telegram-Bot-Api-Secret-Token on every update,
  // letting the webhook route reject forged requests.
  const secret = webhookSecretFor(kind)
  if (secret) body.secret_token = secret
  await tgCall('setWebhook', body, kind)
}

export async function deleteTelegramWebhook(kind: TelegramBotKind = 'staff'): Promise<void> {
  await tgCall('deleteWebhook', { drop_pending_updates: false }, kind)
}

/**
 * Generic long-poll loop for a given bot. Both the staff butler and the customer
 * order bot use this - each with its own token and update handler. No-op unless
 * that bot's token is set and TELEGRAM_MODE is `polling` (webhook mode uses the
 * per-bot webhook routes instead).
 */
const pollingKinds = new Set<TelegramBotKind>()

export function startTelegramPollLoop(
  kind: TelegramBotKind,
  handleUpdate: (update: TelegramUpdate) => Promise<void>,
): void {
  if (pollingKinds.has(kind) || !isTelegramConfigured(kind)) return
  if ((process.env.TELEGRAM_MODE ?? 'polling') !== 'polling') return
  pollingKinds.add(kind)

  let offset = 0
  console.log(`Telegram ${kind} bot: long-polling started`)

  const loop = async () => {
    while (pollingKinds.has(kind)) {
      try {
        const updates = await getTelegramUpdates(offset, kind)
        for (const u of updates) {
          offset = u.update_id + 1
          await handleUpdate(u)
        }
      } catch (err) {
        console.error(
          `Telegram ${kind} poll error:`,
          err instanceof Error ? err.message : err,
        )
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }
  void loop()
}
