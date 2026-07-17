import type { Context } from 'hono'
import { logAudit } from './audit.js'
import type { SessionUser } from './session.js'

const MAX_REASON_LEN = 500

export function parseExportReason(c: Context): string | undefined {
  const fromQuery = c.req.query('reason')?.trim()
  if (fromQuery) return fromQuery.slice(0, MAX_REASON_LEN)
  return undefined
}

export function exportWatermarkComment(user: SessionUser, reason?: string): string {
  const ts = new Date().toISOString()
  const reasonPart = reason ? ` Reason: ${reason}` : ''
  return `# Exported by ${user.name} (${user.email}) at ${ts}.${reasonPart}`
}

export function exportJsonMeta(user: SessionUser, reason?: string) {
  return {
    exportedBy: { id: user.id, name: user.name, email: user.email },
    exportedAt: new Date().toISOString(),
    reason: reason ?? null,
  }
}

export async function logDataExport(params: {
  user: SessionUser
  exportType: string
  reason?: string
  format: 'csv' | 'json'
}) {
  await logAudit({
    farmId: params.user.farmId,
    userId: params.user.id,
    action: 'data_export',
    entityType: 'export',
    metadata: {
      exportType: params.exportType,
      format: params.format,
      reason: params.reason ?? null,
    },
  })
}
