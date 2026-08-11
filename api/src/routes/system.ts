import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { and, desc, eq, gte, inArray, lte, notInArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { auditEvents, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission, requirePermission } from '../lib/rbac.js'
import { SESSION_COOKIE, getUserFromSession } from '../lib/session.js'
import { isLlmConfigured } from '../lib/llm.js'
import { isWhatsAppConfigured } from '../lib/whatsapp-meta.js'
import { getLastBackupInfo } from '../lib/backup-status.js'
import { enrichAccessLocation } from '../lib/ip-location.js'
import { selectSecurityDashboardEvents } from '../lib/security-log.js'
import {
  AUDIT_DOMAIN_LABELS,
  type AuditDomain,
  auditDomainForEntityType,
  entityTypesForAuditDomain,
} from '../lib/audit-catalog.js'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deploymentSha } from '../lib/deployment.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '../../..')

async function checkDbConnection(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now()
  try {
    await db.execute(sql`SELECT 1`)
    return { ok: true, latencyMs: Date.now() - start }
  } catch {
    return { ok: false, latencyMs: Date.now() - start }
  }
}

export const systemRoutes = new Hono<{ Variables: AppVariables }>()

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

async function canViewIntegrationsInProduction(c: Context): Promise<boolean> {
  if (!isProduction()) return true
  const token = getCookie(c, SESSION_COOKIE)
  const user = await getUserFromSession(token)
  return Boolean(user && hasPermission(user, 'integrations.view'))
}

// Public: basic liveness probe
systemRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'trovara-os-api',
    deploymentSha: deploymentSha(rootDir),
    ts: new Date().toISOString(),
  })
})

// Public: readiness probe (needs DB)
systemRoutes.get('/ready', async (c) => {
  const db_ = await checkDbConnection()
  if (!db_.ok) {
    return c.json({ status: 'not_ready', db: 'error' }, 503)
  }
  return c.json({
    status: 'ready',
    db: 'ok',
    latencyMs: db_.latencyMs,
    deploymentSha: deploymentSha(rootDir),
  })
})

// Public: version info (minimal in production unless integrations.view)
systemRoutes.get('/version', async (c) => {
  if (!(await canViewIntegrationsInProduction(c))) {
    return c.json({ ok: true })
  }

  let version = '0.1.0'
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'))
    version = pkg.version ?? version
  } catch {
    // no-op
  }
  return c.json({
    version,
    commit: deploymentSha(rootDir),
    deploymentSha: deploymentSha(rootDir),
    env: process.env.NODE_ENV ?? 'development',
  })
})

// Staff with integrations.view: full system status
systemRoutes.get('/system-status', authMiddleware, async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'integrations.view')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [dbCheck, backup] = await Promise.all([
    checkDbConnection(),
    Promise.resolve(getLastBackupInfo(rootDir)),
  ])

  const whatsappConfigured = isWhatsAppConfigured()
  const aiMode = isLlmConfigured()
    ? process.env.OLLAMA_URL?.trim()
      ? 'ollama'
      : 'openai'
    : 'stub'

  return c.json({
    api: 'ok',
    db: dbCheck.ok ? 'ok' : 'error',
    dbLatencyMs: dbCheck.latencyMs,
    lastBackup: backup.lastBackup,
    backupCount: backup.backupCount,
    backupEvidence: backup.backupEvidence,
    backupReportStatus: backup.backupReportStatus,
    remoteDeliveryStatus: backup.remoteDeliveryStatus,
    lastRestoreTest: backup.lastRestoreTest,
    restoreTestStatus: backup.restoreTestStatus,
    restoreTestAgeHours: backup.restoreTestAgeHours,
    restoreTestFresh: backup.restoreTestFresh,
    whatsappConfigured,
    aiMode,
    commit: deploymentSha(rootDir),
    deploymentSha: deploymentSha(rootDir),
    env: process.env.NODE_ENV ?? 'development',
    ts: new Date().toISOString(),
  })
})

// Security admin: recent security log entries (JSONL tail)
systemRoutes.get('/api/system/security-events', authMiddleware, async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'security.admin')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const logPath = join(rootDir, 'logs', 'security.log')
  if (!existsSync(logPath)) {
    return c.json({ events: [] })
  }

  const raw = readFileSync(logPath, 'utf8')
  const lines = raw.split('\n')
  const events = selectSecurityDashboardEvents(lines, 100).map((event) => ({
    ...event,
    metadata: enrichAccessLocation(event.metadata),
  }))

  return c.json({ events })
})

const AUDIT_DOMAINS = Object.keys(AUDIT_DOMAIN_LABELS) as AuditDomain[]

/** Farm audit trail (Postgres) — parallel to the security JSONL dashboard. */
systemRoutes.get('/api/system/audit-events', authMiddleware, async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'audit.export')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const domainRaw = (c.req.query('domain') || 'all').trim().toLowerCase()
  const domain =
    domainRaw === 'all' || AUDIT_DOMAINS.includes(domainRaw as AuditDomain)
      ? domainRaw
      : 'all'
  const action = (c.req.query('action') || '').trim().toLowerCase()
  const actorUserId = (c.req.query('actorUserId') || '').trim()
  const fromRaw = c.req.query('from')
  const toRaw = c.req.query('to')
  const limitRaw = Number(c.req.query('limit') || '100')
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 100

  const filters = [eq(auditEvents.farmId, user.farmId)]

  if (domain !== 'all') {
    const types = entityTypesForAuditDomain(domain as AuditDomain | 'all')
    if (domain === 'other' && types) {
      filters.push(notInArray(auditEvents.entityType, types))
    } else if (types?.length) {
      filters.push(inArray(auditEvents.entityType, types))
    }
  }

  if (action) {
    filters.push(sql`lower(${auditEvents.action}) = ${action}`)
  }
  if (actorUserId) {
    filters.push(eq(auditEvents.userId, actorUserId))
  }
  if (fromRaw) {
    const from = new Date(fromRaw)
    if (!Number.isNaN(from.getTime())) filters.push(gte(auditEvents.createdAt, from))
  }
  if (toRaw) {
    const to = new Date(toRaw)
    if (!Number.isNaN(to.getTime())) filters.push(lte(auditEvents.createdAt, to))
  }

  const rows = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
      userId: auditEvents.userId,
      userName: users.name,
      userEmail: users.email,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.userId, users.id))
    .where(and(...filters))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)

  const events = rows.map((row) => {
    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? enrichAccessLocation(row.metadata as Record<string, unknown>)
        : {}
    return {
      id: row.id,
      ts: row.createdAt.toISOString(),
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      domain: auditDomainForEntityType(row.entityType),
      actor: row.userId
        ? { id: row.userId, name: row.userName, email: row.userEmail }
        : null,
      metadata,
    }
  })

  return c.json({
    events,
    domains: AUDIT_DOMAINS.map((key) => ({ key, label: AUDIT_DOMAIN_LABELS[key] })),
  })
})
