import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'

type WhatsAppMessageIdentity = { id: string; type: string }
type ClaimedMessageRow = { message_id: string }

/**
 * Claims failed deliveries and abandoned processing leases, while completed
 * messages remain permanent no-ops.
 */
export async function claimInboundWhatsAppMessage(
  phoneNumberId: string,
  message: WhatsAppMessageIdentity,
): Promise<boolean> {
  const rows = await db.execute<ClaimedMessageRow>(sql`
    INSERT INTO whatsapp_processed_messages (
      phone_number_id,
      message_id,
      status,
      created_at
    )
    VALUES (${phoneNumberId || 'unknown'}, ${message.id}, 'processing', now())
    ON CONFLICT (phone_number_id, message_id) DO UPDATE SET
      status = 'processing',
      last_error = null,
      processed_at = null,
      created_at = now()
    WHERE whatsapp_processed_messages.status = 'failed'
       OR (
         whatsapp_processed_messages.status = 'processing'
         AND whatsapp_processed_messages.created_at < now() - interval '5 minutes'
       )
    RETURNING message_id
  `)
  return rows.length === 1
}

export async function completeInboundWhatsAppMessage(
  phoneNumberId: string,
  messageId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE whatsapp_processed_messages
    SET status = 'processed', processed_at = now(), last_error = null
    WHERE phone_number_id = ${phoneNumberId || 'unknown'} AND message_id = ${messageId}
  `)
}

export async function failInboundWhatsAppMessage(
  phoneNumberId: string,
  messageId: string,
  error: unknown,
): Promise<void> {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
  await db.execute(sql`
    UPDATE whatsapp_processed_messages
    SET status = 'failed', last_error = ${detail}
    WHERE phone_number_id = ${phoneNumberId || 'unknown'} AND message_id = ${messageId}
  `)
}
