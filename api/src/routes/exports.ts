import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  auditEvents,
  cropCycles,
  expenses,
  harvestLots,
  inventoryItems,
  plots,
  tasks,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAccessFinance } from '../lib/rbac.js'

export const exportRoutes = new Hono<{ Variables: AppVariables }>()

exportRoutes.use('*', authMiddleware)

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  let raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  if (/^[=+\-@\t]/.test(raw)) {
    raw = `'${raw}`
  }
  return `"${raw.replaceAll('"', '""')}"`
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const headerLine = headers.map(csvValue).join(',')
  const bodyLines = rows.map((row) => headers.map((header) => csvValue(row[header])).join(','))
  return `${headerLine}\n${bodyLines.join('\n')}\n`
}

exportRoutes.get('/tasks.csv', async (c) => {
  const user = c.get('user')
  if (!canAccessFinance(user)) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      assignedToId: tasks.assignedToId,
      approvedById: tasks.approvedById,
      dueDate: tasks.dueDate,
      completedAt: tasks.completedAt,
      rejectionReason: tasks.rejectionReason,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(eq(tasks.farmId, user.farmId))
    .orderBy(desc(tasks.updatedAt))

  const csv = toCsv(
    [
      'id',
      'title',
      'status',
      'assignedToId',
      'approvedById',
      'dueDate',
      'completedAt',
      'rejectionReason',
      'createdAt',
      'updatedAt',
    ],
    rows,
  )
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', 'attachment; filename="tasks.csv"')
  return c.body(csv)
})

exportRoutes.get('/inventory.csv', async (c) => {
  const user = c.get('user')
  if (!canAccessFinance(user)) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({
      id: inventoryItems.id,
      name: inventoryItems.name,
      category: inventoryItems.category,
      unit: inventoryItems.unit,
      quantity: inventoryItems.quantity,
      reorderLevel: inventoryItems.reorderLevel,
      updatedAt: inventoryItems.updatedAt,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.farmId, user.farmId))
    .orderBy(inventoryItems.name)

  const csv = toCsv(
    ['id', 'name', 'category', 'unit', 'quantity', 'reorderLevel', 'updatedAt'],
    rows,
  )
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', 'attachment; filename="inventory.csv"')
  return c.body(csv)
})

exportRoutes.get('/expenses.csv', async (c) => {
  const user = c.get('user')
  if (!canAccessFinance(user)) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({
      id: expenses.id,
      category: expenses.category,
      description: expenses.description,
      amount: expenses.amount,
      currency: expenses.currency,
      vendor: expenses.vendor,
      approvalStatus: expenses.approvalStatus,
      expenseDate: expenses.expenseDate,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .where(eq(expenses.farmId, user.farmId))
    .orderBy(desc(expenses.expenseDate))

  const csv = toCsv(
    [
      'id',
      'category',
      'description',
      'amount',
      'currency',
      'vendor',
      'approvalStatus',
      'expenseDate',
      'createdAt',
    ],
    rows,
  )
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', 'attachment; filename="expenses.csv"')
  return c.body(csv)
})

exportRoutes.get('/audit.csv', async (c) => {
  const user = c.get('user')
  if (!canAccessFinance(user)) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({
      id: auditEvents.id,
      userId: auditEvents.userId,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(eq(auditEvents.farmId, user.farmId))
    .orderBy(desc(auditEvents.createdAt))

  const csv = toCsv(['id', 'userId', 'action', 'entityType', 'entityId', 'metadata', 'createdAt'], rows)
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', 'attachment; filename="audit.csv"')
  return c.body(csv)
})

exportRoutes.get('/farm-data.json', async (c) => {
  const user = c.get('user')
  if (!canAccessFinance(user)) return c.json({ error: 'Forbidden' }, 403)

  const [tasksRows, inventoryRows, expenseRows, lotsRows, cropRows, plotRows, userRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.farmId, user.farmId)).orderBy(desc(tasks.updatedAt)),
    db.select().from(inventoryItems).where(eq(inventoryItems.farmId, user.farmId)).orderBy(inventoryItems.name),
    db.select().from(expenses).where(eq(expenses.farmId, user.farmId)).orderBy(desc(expenses.expenseDate)),
    db.select().from(harvestLots).where(eq(harvestLots.farmId, user.farmId)).orderBy(desc(harvestLots.harvestedAt)),
    db.select().from(cropCycles).where(eq(cropCycles.farmId, user.farmId)).orderBy(desc(cropCycles.updatedAt)),
    db.select().from(plots).where(eq(plots.farmId, user.farmId)).orderBy(plots.name),
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        phone: users.phone,
        active: users.active,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.farmId, user.farmId))
      .orderBy(users.name),
  ])

  c.header('Content-Type', 'application/json; charset=utf-8')
  c.header(
    'Content-Disposition',
    `attachment; filename="farm-data-export-${new Date().toISOString().slice(0, 10)}.json"`,
  )
  return c.json({
    exportedAt: new Date().toISOString(),
    farmId: user.farmId,
    data: {
      users: userRows,
      plots: plotRows,
      cropCycles: cropRows,
      tasks: tasksRows,
      inventoryItems: inventoryRows,
      expenses: expenseRows,
      harvestLots: lotsRows,
    },
  })
})
