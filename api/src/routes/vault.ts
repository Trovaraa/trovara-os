import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { portalVaultEntries, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requirePermission } from '../lib/rbac.js'
import { encryptVaultSecret, decryptVaultSecret } from '../lib/vault-box.js'
import { logAudit } from '../lib/audit.js'
import { logSecurityEvent } from '../lib/security-log.js'
import { withAccessMeta } from '../lib/request-access-meta.js'
import { isBreakGlassEmail, verifyArmedBreakGlassPassword } from '../lib/registration.js'
import { verifyTokenForUser } from '../lib/totp.js'
import { decryptSecretForVerify } from '../lib/secret-box.js'

export const vaultRoutes = new Hono<{ Variables: AppVariables }>()
vaultRoutes.use('*', authMiddleware)

const entrySchema = z.object({
  label: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(60).default('other'),
  loginUrl: z.string().trim().url().max(500),
  loginEmail: z.string().trim().email().max(320),
  password: z.string().min(1).max(500).optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
})

function metadataRow(row: typeof portalVaultEntries.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    category: row.category,
    loginUrl: row.loginUrl,
    loginEmail: row.loginEmail,
    notes: row.notes,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasPassword: Boolean(row.passwordCiphertext),
  }
}

vaultRoutes.get('/', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'vault.view')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const rows = await db
    .select()
    .from(portalVaultEntries)
    .where(eq(portalVaultEntries.farmId, user.farmId))
  return c.json({
    entries: rows
      .map(metadataRow)
      .sort((a, b) => a.label.localeCompare(b.label)),
  })
})

vaultRoutes.post('/', zValidator('json', entrySchema), async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'vault.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = c.req.valid('json')
  if (!body.password) return c.json({ error: 'Password is required' }, 400)

  const [created] = await db
    .insert(portalVaultEntries)
    .values({
      farmId: user.farmId,
      label: body.label,
      category: body.category,
      loginUrl: body.loginUrl,
      loginEmail: body.loginEmail.toLowerCase(),
      passwordCiphertext: encryptVaultSecret(body.password),
      notes: body.notes ?? null,
      createdById: user.id,
      updatedById: user.id,
    })
    .returning()

  logSecurityEvent(
    'vault_entry_created',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      entryId: created.id,
      label: created.label,
      farmId: user.farmId,
    }),
  )
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'portal_vault_entry',
    entityId: created.id,
    metadata: { label: created.label, category: created.category },
  })

  return c.json({ entry: metadataRow(created) }, 201)
})

vaultRoutes.patch('/:id', zValidator('json', entrySchema.partial()), async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'vault.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const id = c.req.param('id')
  const body = c.req.valid('json')
  const [existing] = await db
    .select()
    .from(portalVaultEntries)
    .where(and(eq(portalVaultEntries.id, id), eq(portalVaultEntries.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const [updated] = await db
    .update(portalVaultEntries)
    .set({
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.loginUrl !== undefined ? { loginUrl: body.loginUrl } : {}),
      ...(body.loginEmail !== undefined ? { loginEmail: body.loginEmail.toLowerCase() } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.password !== undefined
        ? { passwordCiphertext: encryptVaultSecret(body.password) }
        : {}),
      updatedById: user.id,
      updatedAt: new Date(),
    })
    .where(eq(portalVaultEntries.id, id))
    .returning()

  logSecurityEvent(
    'vault_entry_updated',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      entryId: id,
      passwordRotated: body.password !== undefined,
      farmId: user.farmId,
    }),
  )
  return c.json({ entry: metadataRow(updated) })
})

vaultRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'vault.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const id = c.req.param('id')
  const [existing] = await db
    .select({ id: portalVaultEntries.id, label: portalVaultEntries.label })
    .from(portalVaultEntries)
    .where(and(eq(portalVaultEntries.id, id), eq(portalVaultEntries.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(portalVaultEntries).where(eq(portalVaultEntries.id, id))
  logSecurityEvent(
    'vault_entry_deleted',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      entryId: id,
      label: existing.label,
      farmId: user.farmId,
    }),
  )
  return c.json({ ok: true })
})

const revealSchema = z.object({
  totpToken: z.string().trim().regex(/^\d{6}$/).optional(),
  breakGlassPassword: z.string().min(8).max(128).optional(),
})

vaultRoutes.post('/:id/reveal', zValidator('json', revealSchema), async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'vault.reveal')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const id = c.req.param('id')
  const body = c.req.valid('json')
  const [entry] = await db
    .select()
    .from(portalVaultEntries)
    .where(and(eq(portalVaultEntries.id, id), eq(portalVaultEntries.farmId, user.farmId)))
    .limit(1)
  if (!entry) return c.json({ error: 'Not found' }, 404)

  if (isBreakGlassEmail(user.email)) {
    if (!body.breakGlassPassword || !verifyArmedBreakGlassPassword(body.breakGlassPassword)) {
      logSecurityEvent(
        'vault_reveal_failed',
        withAccessMeta((name) => c.req.header(name), {
          reason: 'break_glass_step_up_failed',
          entryId: id,
          userId: user.id,
        }),
      )
      return c.json({ error: 'Armed break-glass password required to reveal' }, 403)
    }
  } else {
    const [owner] = await db
      .select({ totpEnabled: users.totpEnabled, totpSecret: users.totpSecret })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    if (!owner?.totpEnabled || !owner.totpSecret || !body.totpToken) {
      logSecurityEvent(
        'vault_reveal_failed',
        withAccessMeta((name) => c.req.header(name), {
          reason: 'totp_required',
          entryId: id,
          userId: user.id,
        }),
      )
      return c.json({ error: 'TOTP code required to reveal password' }, 403)
    }
    const { plaintext } = decryptSecretForVerify(owner.totpSecret)
    if (!verifyTokenForUser(user.id, plaintext, body.totpToken)) {
      logSecurityEvent(
        'vault_reveal_failed',
        withAccessMeta((name) => c.req.header(name), {
          reason: 'invalid_totp',
          entryId: id,
          userId: user.id,
        }),
      )
      return c.json({ error: 'Invalid authentication code' }, 403)
    }
  }

  let password: string
  try {
    password = decryptVaultSecret(entry.passwordCiphertext)
  } catch {
    return c.json({ error: 'Could not decrypt vault entry' }, 500)
  }

  logSecurityEvent(
    'vault_password_revealed',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      entryId: id,
      label: entry.label,
      farmId: user.farmId,
    }),
  )
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'vault_password_revealed',
    entityType: 'portal_vault_entry',
    entityId: id,
    metadata: { label: entry.label },
  })

  return c.json({
    password,
    loginEmail: entry.loginEmail,
    loginUrl: entry.loginUrl,
  })
})
