import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { plots, taskTemplates, tasks, users, zones } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canAssignTasks } from './rbac.js'
import { logAudit } from './audit.js'

export const HANDOVER_TEMPLATES = [
  {
    systemTemplateKey: 'handover_zone_map',
    name: 'Map and verify a zone',
    description: 'Walk the zone boundary, confirm name/location, and note access points.',
    actionType: 'zone_map',
    defaultPayload: {},
  },
  {
    systemTemplateKey: 'handover_create_block',
    name: 'Create and label a block',
    description: 'Create or confirm a block under a zone with code and notes.',
    actionType: 'create_block',
    defaultPayload: {},
  },
  {
    systemTemplateKey: 'handover_crop_census',
    name: 'Count crops in a block',
    description: 'Record plant counts and height ranges for each crop in the block.',
    actionType: 'crop_census',
    defaultPayload: { crops: ['plantain', 'oil_palm', 'coconut'] },
  },
  {
    systemTemplateKey: 'handover_height_range',
    name: 'Measure crop height range',
    description: 'Record minimum, maximum, and average crop heights for a block.',
    actionType: 'height_range',
    defaultPayload: {},
  },
  {
    systemTemplateKey: 'handover_asset_count',
    name: 'Count fixed assets and PPE',
    description: 'Count reusable equipment and PPE and log condition.',
    actionType: 'asset_count',
    defaultPayload: {},
  },
  {
    systemTemplateKey: 'handover_inventory_count',
    name: 'Count consumable materials',
    description: 'Submit opening stock counts for consumable inventory items.',
    actionType: 'inventory_count',
    defaultPayload: {},
  },
  {
    systemTemplateKey: 'handover_verify_submission',
    name: 'Verify a submitted count',
    description: 'Review and verify or reject a submitted block, asset, or inventory count.',
    actionType: 'verify_submission',
    defaultPayload: {},
  },
] as const

export async function seedHandoverTemplates(farmId: string): Promise<number> {
  let created = 0
  for (const tpl of HANDOVER_TEMPLATES) {
    const [existing] = await db
      .select({ id: taskTemplates.id })
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.farmId, farmId),
          eq(taskTemplates.systemTemplateKey, tpl.systemTemplateKey),
        ),
      )
      .limit(1)

    if (existing) continue

    await db.insert(taskTemplates).values({
      farmId,
      name: tpl.name,
      description: tpl.description,
      actionType: tpl.actionType,
      systemTemplateKey: tpl.systemTemplateKey,
      defaultPayload: tpl.defaultPayload,
    })
    created += 1
  }
  return created
}

export type GenerateHandoverTasksInput = {
  templateKeys?: string[]
  plotIds?: string[]
  assignedToId?: string | null
  dueDate?: string | null
}

export async function generateHandoverTasks(user: SessionUser, input: GenerateHandoverTasksInput) {
  if (!canAssignTasks(user)) throw new Error('FORBIDDEN')

  await seedHandoverTemplates(user.farmId)

  const keys = input.templateKeys?.length
    ? input.templateKeys
    : HANDOVER_TEMPLATES.map((t) => t.systemTemplateKey)

  const templates = await db
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.farmId, user.farmId))

  const selected = templates.filter(
    (t) => t.systemTemplateKey && keys.includes(t.systemTemplateKey),
  )
  if (!selected.length) throw new Error('No matching templates')

  if (input.assignedToId) {
    const [assignee] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!assignee) throw new Error('Invalid assignee')
  }

  let targetPlots: { id: string; name: string }[] = []
  if (input.plotIds?.length) {
    targetPlots = await db
      .select({ id: plots.id, name: plots.name })
      .from(plots)
      .where(
        and(
          eq(plots.farmId, user.farmId),
          eq(plots.active, true),
          inArray(plots.id, input.plotIds),
        ),
      )
  }

  const created: { id: string; title: string }[] = []
  const dueDate = input.dueDate ? new Date(input.dueDate) : null

  for (const tpl of selected) {
    const needsPlot = ['crop_census', 'height_range', 'create_block'].includes(tpl.actionType ?? '')
    const plotTargets = needsPlot
      ? targetPlots.length
        ? targetPlots
        : await db
            .select({ id: plots.id, name: plots.name })
            .from(plots)
            .where(and(eq(plots.farmId, user.farmId), eq(plots.active, true)))
      : [null]

    for (const plot of plotTargets) {
      const title = plot ? `${tpl.name}: ${plot.name}` : tpl.name
      const [task] = await db
        .insert(tasks)
        .values({
          farmId: user.farmId,
          title,
          description: tpl.description,
          templateId: tpl.id,
          plotId: plot?.id ?? null,
          assignedToId: input.assignedToId ?? null,
          createdById: user.id,
          dueDate,
          actionType: tpl.actionType,
          actionPayload: {
            ...(tpl.defaultPayload ?? {}),
            systemTemplateKey: tpl.systemTemplateKey,
          },
          status: 'pending',
        })
        .returning({ id: tasks.id, title: tasks.title })
      created.push(task)
    }
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'handover_generate_tasks',
    entityType: 'task',
    metadata: { count: created.length, keys },
  })

  return created
}

export async function getHandoverProgress(farmId: string) {
  await seedHandoverTemplates(farmId)

  const [zoneCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(zones)
    .where(eq(zones.farmId, farmId))

  const [blockCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(plots)
    .where(and(eq(plots.farmId, farmId), eq(plots.active, true)))

  const handoverTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      actionType: tasks.actionType,
      plotId: tasks.plotId,
      dueDate: tasks.dueDate,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.farmId, farmId),
        sql`${tasks.actionType} IS NOT NULL`,
        ne(tasks.status, 'completed'),
      ),
    )
    .orderBy(tasks.dueDate)

  const [completedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.farmId, farmId),
        sql`${tasks.actionType} IS NOT NULL`,
        eq(tasks.status, 'completed'),
      ),
    )

  const [openCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.farmId, farmId),
        sql`${tasks.actionType} IS NOT NULL`,
        ne(tasks.status, 'completed'),
      ),
    )

  return {
    zones: zoneCount?.count ?? 0,
    activeBlocks: blockCount?.count ?? 0,
    handoverTasksCompleted: completedCount?.count ?? 0,
    handoverTasksOpen: openCount?.count ?? 0,
    openTasks: handoverTasks,
  }
}

export type HandoverProgress = Awaited<ReturnType<typeof getHandoverProgress>>

/** Plain-text handover summary for Telegram / WhatsApp. */
export function formatHandoverProgressText(progress: HandoverProgress): string {
  const openLines =
    progress.openTasks.length > 0
      ? progress.openTasks.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} (${t.status})`)
      : ['None']

  return [
    'Handover progress',
    `Zones: ${progress.zones}`,
    `Active blocks: ${progress.activeBlocks}`,
    `Open handover tasks: ${progress.handoverTasksOpen}`,
    `Completed: ${progress.handoverTasksCompleted}`,
    '',
    'Open items:',
    ...openLines,
  ].join('\n')
}
