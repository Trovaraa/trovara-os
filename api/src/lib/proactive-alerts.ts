import { and, eq, gte, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  assets,
  assetLogs,
  cropCycles,
  inventoryItems,
  livestockLogs,
  plots,
  tasks,
} from '../db/schema.js'
import type { ReplyLocale } from './reply-locale.js'

export type ProactiveAlertType =
  | 'low_stock'
  | 'overdue_tasks'
  | 'mortality_spike'
  | 'crop_stage_reminder'
  | 'asset_log_missing'
  | 'asset_verification_pending'

export type ProactiveAlert = {
  type: ProactiveAlertType
  severity: 'high' | 'medium'
  /** Canonical English, for the web UI and API consumers. */
  title: string
  /** Canonical English. Render with `renderProactiveAlert` for a push. */
  message: string
  count: number
  metadata?: Record<string, unknown>
}

/** Window the mortality-spike counter looks back over, in days. */
const MORTALITY_WINDOW_DAYS = 7

/** Mortality logs in the window before this alert fires. */
const MORTALITY_SPIKE_THRESHOLD = 3

type MsgTable = Record<ReplyLocale, string>

function pick(locale: ReplyLocale, table: MsgTable): string {
  return table[locale] ?? table.en
}

/**
 * Every alert here is templated system copy: a fixed sentence with a numeric
 * slot, written in our own code. That makes it a deterministic locale table
 * rather than a translation call - instant, and it works with the LLM off.
 * The only variable is a count, which is never translated.
 */
const ALERT_TITLES: Record<ProactiveAlertType, MsgTable> = {
  low_stock: {
    en: 'Low stock items',
    fr: 'Articles en stock faible',
    yo: 'Ọjà tó ń tán',
    pcm: 'Store wey dey finish',
  },
  overdue_tasks: {
    en: 'Overdue tasks',
    fr: 'Tâches en retard',
    yo: 'Iṣẹ́ tó ti kọjá àkókò',
    pcm: 'Work wey pass im time',
  },
  mortality_spike: {
    en: 'Mortality spike detected',
    fr: 'Pic de mortalité détecté',
    yo: 'Ìlọsókè ikú ẹran',
    pcm: 'Plenty animal dey die',
  },
  crop_stage_reminder: {
    en: 'Crop stage reminders',
    fr: 'Rappels d’étape de culture',
    yo: 'Ìránnilétí ìpele ọ̀gbìn',
    pcm: 'Crop stage reminder',
  },
  asset_log_missing: {
    en: 'Equipment not logged today',
    fr: 'Équipements non enregistrés aujourd’hui',
    yo: 'Ohun èlò tí a kò kọ sílẹ̀ lónìí',
    pcm: 'Equipment wey dem no log today',
  },
  asset_verification_pending: {
    en: 'Asset logs awaiting verification',
    fr: 'Registres d’équipement en attente de vérification',
    yo: 'Àkọsílẹ̀ ohun èlò tó ń dúró fún ìjẹ́rìí',
    pcm: 'Equipment log wey dey wait check',
  },
}

function alertBody(locale: ReplyLocale, type: ProactiveAlertType, count: number): string {
  switch (type) {
    case 'low_stock':
      return pick(locale, {
        en: `${count} inventory item(s) are at or below reorder level.`,
        fr: `${count} article(s) d’inventaire sont au niveau de réapprovisionnement ou en dessous.`,
        yo: `Ọjà ${count} wà ní ìpele ìkúnjú tàbí ní ìsàlẹ̀ rẹ̀.`,
        pcm: `${count} store item don reach or pass reorder level.`,
      })
    case 'overdue_tasks':
      return pick(locale, {
        en: `${count} task(s) are overdue and not completed.`,
        fr: `${count} tâche(s) sont en retard et non terminées.`,
        yo: `Iṣẹ́ ${count} ti kọjá àkókò, wọn kò tíì parí.`,
        pcm: `${count} work don pass im time and dem no finish am.`,
      })
    case 'mortality_spike':
      return pick(locale, {
        en: `${count} mortality logs were recorded in the last ${MORTALITY_WINDOW_DAYS} days.`,
        fr: `${count} enregistrements de mortalité ont été notés durant les ${MORTALITY_WINDOW_DAYS} derniers jours.`,
        yo: `Àkọsílẹ̀ ikú ${count} ni a kọ sílẹ̀ ní ọjọ́ ${MORTALITY_WINDOW_DAYS} tó kọjá.`,
        pcm: `${count} mortality log dem record for di last ${MORTALITY_WINDOW_DAYS} days.`,
      })
    case 'crop_stage_reminder':
      return pick(locale, {
        en: `${count} crop cycle(s) need attention soon (harvest window or stage stall).`,
        fr: `${count} cycle(s) de culture demandent une attention prochaine (fenêtre de récolte ou étape bloquée).`,
        yo: `Ìgbà ọ̀gbìn ${count} nílò àfiyèsí láìpẹ́ (àkókò ìkórè tàbí ìpele tó dúró).`,
        pcm: `${count} crop cycle need attention soon (harvest window or stage wey stuck).`,
      })
    case 'asset_log_missing':
      return pick(locale, {
        en: `${count} asset(s) have no daily log yet today.`,
        fr: `${count} équipement(s) n’ont pas encore de journal aujourd’hui.`,
        yo: `Ohun èlò ${count} kò ní àkọsílẹ̀ ojoojúmọ́ lónìí.`,
        pcm: `${count} equipment no get daily log yet today.`,
      })
    case 'asset_verification_pending':
      return pick(locale, {
        en: `${count} asset log(s) reported by staff need a supervisor to verify.`,
        fr: `${count} journal/journaux d’équipement signalés par le personnel doivent être vérifiés par un superviseur.`,
        yo: `Àkọsílẹ̀ ohun èlò ${count} tí àwọn òṣìṣẹ́ ròyìn nílò kí alábojútó jẹ́rìí sí i.`,
        pcm: `${count} equipment log wey staff report need supervisor to verify.`,
      })
  }
}

/** Title and body for one alert. English is a locale here, not a second copy. */
export function renderProactiveAlert(
  locale: ReplyLocale,
  alert: Pick<ProactiveAlert, 'type' | 'count'>,
): { title: string; message: string } {
  return {
    title: pick(locale, ALERT_TITLES[alert.type]),
    message: alertBody(locale, alert.type, alert.count),
  }
}

/**
 * The whole proactive push, ready for one recipient. Callers fanning out to
 * several recipients should pass this as a renderer so each gets their own
 * language from a single notify call. The farm name is never translated.
 */
export function renderProactiveAlertPush(
  locale: ReplyLocale,
  farmName: string,
  alerts: ProactiveAlert[],
): string {
  if (alerts.length === 0) {
    return pick(locale, {
      en: `✅ Proactive check (${farmName}): no urgent issues detected.`,
      fr: `✅ Contrôle proactif (${farmName}) : aucun problème urgent détecté.`,
      yo: `✅ Àyẹ̀wò ìṣáájú (${farmName}): kò sí ìṣòro kánkán.`,
      pcm: `✅ Proactive check (${farmName}): no urgent wahala.`,
    })
  }

  const header = pick(locale, {
    en: `⚠️ Proactive alerts for ${farmName}:`,
    fr: `⚠️ Alertes proactives pour ${farmName} :`,
    yo: `⚠️ Ìkìlọ̀ ìṣáájú fún ${farmName}:`,
    pcm: `⚠️ Proactive alert for ${farmName}:`,
  })
  const lines = alerts.map((alert) => {
    const copy = renderProactiveAlert(locale, alert)
    return `- ${copy.title}: ${copy.message}`
  })
  return [header, ...lines].join('\n')
}

/** Canonical-English copy stored on the alert row. */
function englishCopy(
  type: ProactiveAlertType,
  count: number,
): { title: string; message: string } {
  return renderProactiveAlert('en', { type, count })
}

export async function checkProactiveAlerts(farmId: string): Promise<ProactiveAlert[]> {
  const now = new Date()
  const last7Days = new Date(now.getTime() - MORTALITY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)

  const [
    lowStockItems,
    [overdue],
    [mortality],
    cropReminders,
    activeAssets,
    loggedTodayRows,
    [pendingVerification],
  ] = await Promise.all([
    db
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        unit: inventoryItems.unit,
        quantity: inventoryItems.quantity,
        reorderLevel: inventoryItems.reorderLevel,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.farmId, farmId),
          sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
        ),
      ),
    db
      .select({
        count:
          sql<number>`COALESCE(COUNT(*), 0)`.mapWith(Number),
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.farmId, farmId),
          sql`${tasks.dueDate} IS NOT NULL`,
          lt(tasks.dueDate, now),
          ne(tasks.status, 'completed'),
        ),
      ),
    db
      .select({
        count:
          sql<number>`COALESCE(COUNT(*), 0)`.mapWith(Number),
      })
      .from(livestockLogs)
      .where(
        and(
          eq(livestockLogs.farmId, farmId),
          eq(livestockLogs.logType, 'mortality'),
          gte(livestockLogs.createdAt, last7Days),
        ),
      ),
    db
      .select({
        id: cropCycles.id,
        cropType: cropCycles.cropType,
        stage: cropCycles.stage,
        plantedAt: cropCycles.plantedAt,
        expectedHarvestAt: cropCycles.expectedHarvestAt,
        plotName: plots.name,
      })
      .from(cropCycles)
      .leftJoin(plots, eq(cropCycles.plotId, plots.id))
      .where(
        and(
          eq(cropCycles.farmId, farmId),
          or(
            and(
              sql`${cropCycles.expectedHarvestAt} IS NOT NULL`,
              gte(cropCycles.expectedHarvestAt, now),
              lt(cropCycles.expectedHarvestAt, in14Days),
              ne(cropCycles.stage, 'harvested'),
            ),
            and(eq(cropCycles.stage, 'planted'), lt(cropCycles.plantedAt, ninetyDaysAgo)),
          ),
        ),
      ),
    db
      .select({ id: assets.id, name: assets.name })
      .from(assets)
      .where(and(eq(assets.farmId, farmId), eq(assets.active, true))),
    db
      .selectDistinct({ assetId: assetLogs.assetId })
      .from(assetLogs)
      .where(and(eq(assetLogs.farmId, farmId), gte(assetLogs.logDate, todayStart))),
    db
      .select({ count: sql<number>`COALESCE(COUNT(*), 0)`.mapWith(Number) })
      .from(assetLogs)
      .where(and(eq(assetLogs.farmId, farmId), eq(assetLogs.verificationStatus, 'reported'))),
  ])

  const alerts: ProactiveAlert[] = []

  if (lowStockItems.length > 0) {
    alerts.push({
      type: 'low_stock',
      severity: 'high',
      ...englishCopy('low_stock', lowStockItems.length),
      count: lowStockItems.length,
      metadata: {
        items: lowStockItems.slice(0, 5),
      },
    })
  }

  if ((overdue?.count ?? 0) > 0) {
    alerts.push({
      type: 'overdue_tasks',
      severity: 'medium',
      ...englishCopy('overdue_tasks', overdue.count),
      count: overdue.count,
    })
  }

  if ((mortality?.count ?? 0) >= MORTALITY_SPIKE_THRESHOLD) {
    alerts.push({
      type: 'mortality_spike',
      severity: 'high',
      ...englishCopy('mortality_spike', mortality.count),
      count: mortality.count,
      metadata: { windowDays: MORTALITY_WINDOW_DAYS },
    })
  }

  if (cropReminders.length > 0) {
    alerts.push({
      type: 'crop_stage_reminder',
      severity: 'medium',
      ...englishCopy('crop_stage_reminder', cropReminders.length),
      count: cropReminders.length,
      metadata: {
        items: cropReminders.slice(0, 8).map((cycle) => ({
          id: cycle.id,
          cropType: cycle.cropType,
          stage: cycle.stage,
          plotName: cycle.plotName,
          plantedAt: cycle.plantedAt,
          expectedHarvestAt: cycle.expectedHarvestAt,
        })),
      },
    })
  }

  const loggedTodayIds = new Set(loggedTodayRows.map((r) => r.assetId))
  const missingAssets = activeAssets.filter((a) => !loggedTodayIds.has(a.id))

  if (missingAssets.length > 0) {
    alerts.push({
      type: 'asset_log_missing',
      severity: 'medium',
      ...englishCopy('asset_log_missing', missingAssets.length),
      count: missingAssets.length,
      metadata: {
        items: missingAssets.slice(0, 8).map((a) => ({ id: a.id, name: a.name })),
      },
    })
  }

  if ((pendingVerification?.count ?? 0) > 0) {
    alerts.push({
      type: 'asset_verification_pending',
      severity: 'medium',
      ...englishCopy('asset_verification_pending', pendingVerification.count),
      count: pendingVerification.count,
    })
  }

  return alerts
}
