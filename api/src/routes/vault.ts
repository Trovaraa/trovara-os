import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { portalVaultEntries, portalVaultShares, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requirePermission, hasPermission } from '../lib/rbac.js'
import type { SessionUser } from '../lib/session.js'
import { encryptVaultSecret, decryptVaultSecret } from '../lib/vault-box.js'
import { logAudit } from '../lib/audit.js'
import { logSecurityEvent } from '../lib/security-log.js'
import { withAccessMeta } from '../lib/request-access-meta.js'
import { isBreakGlassEmail, verifyArmedBreakGlassPassword } from '../lib/registration.js'
import { verifyTokenForUser } from '../lib/totp.js'
import { decryptSecretForVerify } from '../lib/secret-box.js'
import {
  checkDurableRateLimit,
  resetDurableRateLimit,
  vaultRevealRateKey,
  VAULT_REVEAL_MAX_ATTEMPTS,
} from '../middleware/security.js'

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

function metadataRow(
  row: typeof portalVaultEntries.$inferSelect,
  options: {
    includeNotes: boolean
    canManage: boolean
    canReveal: boolean
    sharedWithMe: boolean
    sharedUserIds: string[]
  },
) {
  return {
    id: row.id,
    label: row.label,
    category: row.category,
    loginUrl: row.loginUrl,
    loginEmail: row.loginEmail,
    // Notes often hold recovery codes / secondary secrets — manage-only.
    notes: options.includeNotes ? row.notes : null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasPassword: Boolean(row.passwordCiphertext),
    canManage: options.canManage,
    canReveal: options.canReveal,
    sharedWithMe: options.sharedWithMe,
    sharedUserIds: options.sharedUserIds,
  }
}

function canViewAllVault(user: SessionUser) {
  return hasPermission(user, 'vault.view') || hasPermission(user, 'vault.manage')
}

async function sharedEntryIdsForUser(farmId: string, userId: string): Promise<string[]> {
  const shares = await db
    .select({
      entryId: portalVaultShares.entryId,
      farmId: portalVaultEntries.farmId,
    })
    .from(portalVaultShares)
    .innerJoin(portalVaultEntries, eq(portalVaultShares.entryId, portalVaultEntries.id))
    .where(and(eq(portalVaultShares.userId, userId), eq(portalVaultEntries.farmId, farmId)))
  return shares.map((row) => row.entryId)
}

async function isEntrySharedWith(entryId: string, userId: string): Promise<boolean> {
  const [share] = await db
    .select({ entryId: portalVaultShares.entryId })
    .from(portalVaultShares)
    .where(and(eq(portalVaultShares.entryId, entryId), eq(portalVaultShares.userId, userId)))
    .limit(1)
  return Boolean(share)
}

async function sharesByEntry(entryIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (!entryIds.length) return map
  const rows = await db
    .select({
      entryId: portalVaultShares.entryId,
      userId: portalVaultShares.userId,
    })
    .from(portalVaultShares)
    .where(inArray(portalVaultShares.entryId, entryIds))
  for (const row of rows) {
    const list = map.get(row.entryId) ?? []
    list.push(row.userId)
    map.set(row.entryId, list)
  }
  return map
}

vaultRoutes.get('/', async (c) => {
  const user = c.get('user')
  const includeNotes = hasPermission(user, 'vault.manage')
  const canManage = hasPermission(user, 'vault.manage')
  const canRevealAll = hasPermission(user, 'vault.reveal')
  const viewAll = canViewAllVault(user)

  const allRows = await db
    .select()
    .from(portalVaultEntries)
    .where(eq(portalVaultEntries.farmId, user.farmId))
  const mine = viewAll ? allRows : []
  const sharedIds = viewAll ? [] : await sharedEntryIdsForUser(user.farmId, user.id)
  const rows = viewAll ? mine : allRows.filter((row) => sharedIds.includes(row.id))
  const shareMap = await sharesByEntry(rows.map((row) => row.id))

  return c.json({
    canManage,
    canRevealAll,
    entries: rows
      .map((row) => {
        const sharedUserIds = shareMap.get(row.id) ?? []
        const sharedWithMe = sharedUserIds.includes(user.id)
        return metadataRow(row, {
          includeNotes,
          canManage,
          canReveal: canRevealAll || sharedWithMe,
          sharedWithMe,
          sharedUserIds: canManage ? sharedUserIds : sharedWithMe ? [user.id] : [],
        })
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  })
})

vaultRoutes.get('/share-candidates', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'vault.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const staff = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      jobTitle: users.jobTitle,
    })
    .from(users)
    .where(and(eq(users.farmId, user.farmId), eq(users.active, true)))
  return c.json({
    users: staff
      .filter((row) => row.id !== user.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
})

const sharesSchema = z.object({
  userIds: z.array(z.string().uuid()).max(200),
})

vaultRoutes.put('/:id/shares', zValidator('json', sharesSchema), async (c) => {
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

  const requested = [...new Set(c.req.valid('json').userIds.filter((userId) => userId !== user.id))]
  if (requested.length) {
    const valid = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.farmId, user.farmId), eq(users.active, true), inArray(users.id, requested)),
      )
    if (valid.length !== requested.length) {
      return c.json({ error: 'One or more users are not active staff on this farm' }, 400)
    }
  }

  await db.delete(portalVaultShares).where(eq(portalVaultShares.entryId, id))
  if (requested.length) {
    await db.insert(portalVaultShares).values(
      requested.map((userId) => ({
        entryId: id,
        userId,
        sharedById: user.id,
      })),
    )
  }

  logSecurityEvent(
    'vault_entry_updated',
    withAccessMeta((name) => c.req.header(name), {
      actorUserId: user.id,
      entryId: id,
      sharedUserCount: requested.length,
      farmId: user.farmId,
    }),
  )
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'portal_vault_entry',
    entityId: id,
    metadata: { label: existing.label, sharedUserIds: requested },
  })
  return c.json({ sharedUserIds: requested })
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

  return c.json({
    entry: metadataRow(created, {
      includeNotes: true,
      canManage: true,
      canReveal: true,
      sharedWithMe: false,
      sharedUserIds: [],
    }),
  }, 201)
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
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'portal_vault_entry',
    entityId: id,
    metadata: {
      label: updated.label,
      category: updated.category,
      passwordRotated: body.password !== undefined,
    },
  })
  const shareMap = await sharesByEntry([id])
  return c.json({
    entry: metadataRow(updated, {
      includeNotes: true,
      canManage: true,
      canReveal: true,
      sharedWithMe: false,
      sharedUserIds: shareMap.get(id) ?? [],
    }),
  })
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
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'portal_vault_entry',
    entityId: id,
    metadata: { label: existing.label },
  })
  return c.json({ ok: true })
})

const revealSchema = z.object({
  totpToken: z.string().trim().regex(/^\d{6}$/).optional(),
  breakGlassPassword: z.string().min(8).max(128).optional(),
})

vaultRoutes.post('/:id/reveal', zValidator('json', revealSchema), async (c) => {
  const user = c.get('user')
  const canRevealAll = hasPermission(user, 'vault.reveal')

  const revealKey = vaultRevealRateKey(user.id)
  if (!(await checkDurableRateLimit(revealKey, VAULT_REVEAL_MAX_ATTEMPTS))) {
    logSecurityEvent(
      'vault_reveal_failed',
      withAccessMeta((name) => c.req.header(name), {
        reason: 'rate_limited',
        userId: user.id,
        farmId: user.farmId,
      }),
    )
    return c.json({ error: 'Too many reveal attempts. Try again later.' }, 429)
  }

  const id = c.req.param('id')
  const body = c.req.valid('json')
  const [entry] = await db
    .select()
    .from(portalVaultEntries)
    .where(and(eq(portalVaultEntries.id, id), eq(portalVaultEntries.farmId, user.farmId)))
    .limit(1)
  if (!entry) return c.json({ error: 'Not found' }, 404)
  if (!canRevealAll && !(await isEntrySharedWith(id, user.id))) {
    logSecurityEvent(
      'vault_reveal_failed',
      withAccessMeta((name) => c.req.header(name), {
        reason: 'not_shared',
        entryId: id,
        userId: user.id,
        farmId: user.farmId,
      }),
    )
    return c.json({ error: 'Forbidden' }, 403)
  }

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
      return c.json({ error: '2FA/TOTP code required to reveal password -> Kindly add a 2FA/TOTP code to your account' }, 403)
    }
    const { plaintext } = decryptSecretForVerify(owner.totpSecret)
    if (!(await verifyTokenForUser(user.id, plaintext, body.totpToken))) {
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

  await resetDurableRateLimit(revealKey)

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
