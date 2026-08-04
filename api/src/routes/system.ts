import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission, requirePermission } from '../lib/rbac.js'
import { SESSION_COOKIE, getUserFromSession } from '../lib/session.js'
import { isLlmConfigured } from '../lib/llm.js'
import { isWhatsAppConfigured } from '../lib/whatsapp-meta.js'
import { getLastBackupInfo } from '../lib/backup-status.js'
import { enrichAccessLocation } from '../lib/ip-location.js'
import { selectSecurityDashboardEvents } from '../lib/security-log.js'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '../../..')

function getGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: rootDir, timeout: 2000 })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

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
  return c.json({ status: 'ok', service: 'trovara-os-api', ts: new Date().toISOString() })
})

// Public: readiness probe (needs DB)
systemRoutes.get('/ready', async (c) => {
  const db_ = await checkDbConnection()
  if (!db_.ok) {
    return c.json({ status: 'not_ready', db: 'error' }, 503)
  }
  return c.json({ status: 'ready', db: 'ok', latencyMs: db_.latencyMs })
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
    commit: getGitCommit(),
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
    whatsappConfigured,
    aiMode,
    commit: getGitCommit(),
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
