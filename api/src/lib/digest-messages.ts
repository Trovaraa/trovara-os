/**
 * Locale tables for the nightly evening digest pushed to the farm owner over
 * Telegram/WhatsApp, which have no vue-i18n runtime.
 *
 * Sibling of exception-messages.ts: same four locales, but the digest is a
 * whole message rather than individual keys, so it renders in one call.
 */
import type { ExceptionSummary } from './exceptions.js'
import type { ReplyLocale } from './reply-locale.js'

type MsgTable = Record<ReplyLocale, string>

function pick(locale: ReplyLocale, table: MsgTable): string {
  return table[locale] ?? table.en
}

/** Every summary counter except `total`, which is rendered as its own line. */
export type DigestCounterKey = Exclude<keyof ExceptionSummary, 'total'>

/**
 * Reading order for the owner: what can still be acted on tonight first
 * (weather, dying animals), then the day's backlog, then paperwork.
 */
const COUNTER_ORDER: readonly DigestCounterKey[] = [
  'weatherAlerts',
  'mortalityToday',
  'overdueTasks',
  'pendingApprovals',
  'rejectedTasks',
  'lowStock',
  'ordersPending',
  'assetLogsMissing',
  'assetVerificationPending',
  'censusMissing',
  'censusRejected',
  'censusStale',
]

const COUNTER_LABELS: Record<DigestCounterKey, MsgTable> = {
  weatherAlerts: {
    en: 'Weather alerts',
    fr: 'Alertes météo',
    yo: 'Ìkìlọ̀ ojú ọjọ́',
    pcm: 'Weather warning',
  },
  mortalityToday: {
    en: 'Mortality today',
    fr: 'Mortalité aujourd’hui',
    yo: 'Ikú ẹran lónìí',
    pcm: 'Animal wey die today',
  },
  overdueTasks: {
    en: 'Overdue tasks',
    fr: 'Tâches en retard',
    yo: 'Iṣẹ́ tó ti kọjá àkókò',
    pcm: 'Work wey pass im time',
  },
  pendingApprovals: {
    en: 'Pending approvals',
    fr: 'Approbations en attente',
    yo: 'Ìfọwọ́sí tó ń dúró',
    pcm: 'Approval wey dey wait',
  },
  rejectedTasks: {
    en: 'Rejected tasks',
    fr: 'Tâches rejetées',
    yo: 'Iṣẹ́ tí a kọ̀',
    pcm: 'Work wey dem reject',
  },
  lowStock: {
    en: 'Low stock',
    fr: 'Stock faible',
    yo: 'Ọjà tó ń tán',
    pcm: 'Store wey dey finish',
  },
  ordersPending: {
    en: 'Orders pending',
    fr: 'Commandes en attente',
    yo: 'Òrder tó ń dúró',
    pcm: 'Order wey never close',
  },
  assetLogsMissing: {
    en: 'Equipment not logged today',
    fr: 'Équipements non enregistrés aujourd’hui',
    yo: 'Ohun èlò tí a kò kọ sílẹ̀ lónìí',
    pcm: 'Equipment wey dem no log today',
  },
  assetVerificationPending: {
    en: 'Asset logs to verify',
    fr: 'Registres d’équipement à vérifier',
    yo: 'Àkọsílẹ̀ ohun èlò tó nílò ìjẹ́rìí',
    pcm: 'Equipment log wey need check',
  },
  censusMissing: {
    en: 'Blocks without a census',
    fr: 'Parcelles sans recensement',
    yo: 'Ìpín oko tí kò ní ìkànìyàn',
    pcm: 'Block wey no get census',
  },
  censusRejected: {
    en: 'Rejected censuses',
    fr: 'Recensements rejetés',
    yo: 'Ìkànìyàn tí a kọ̀',
    pcm: 'Census wey dem reject',
  },
  censusStale: {
    en: 'Stale censuses',
    fr: 'Recensements périmés',
    yo: 'Ìkànìyàn tí ó ti gbó',
    pcm: 'Census wey don old',
  },
}

function digestHeader(locale: ReplyLocale, farmName: string): string {
  return pick(locale, {
    en: `🌙 Trovara evening digest — ${farmName}`,
    fr: `🌙 Résumé du soir Trovara — ${farmName}`,
    yo: `🌙 Àkótán alẹ́ Trovara — ${farmName}`,
    pcm: `🌙 Trovara evening round-up — ${farmName}`,
  })
}

function allClearLine(locale: ReplyLocale): string {
  return pick(locale, {
    en: '✅ All clear - nothing needs your attention tonight.',
    fr: '✅ Tout est en ordre - rien ne demande votre attention ce soir.',
    yo: '✅ Kò sí wàhálà - kò sí ohun tó nílò àfiyèsí rẹ lálẹ́ yìí.',
    pcm: '✅ Everything dey alright - nothing dey wait your hand tonight.',
  })
}

function openItemsLine(locale: ReplyLocale, total: number): string {
  return pick(locale, {
    en: `Open items: ${total}`,
    fr: `Points ouverts : ${total}`,
    yo: `Ọ̀rọ̀ tó ṣẹ́kù: ${total}`,
    pcm: `Things wey remain: ${total}`,
  })
}

/**
 * Render the whole evening digest. Zero counters are dropped so a quiet day is
 * a two-line notification; when every counter is zero the all-clear line stands
 * in so the owner still learns the digest ran.
 */
export function renderEveningDigest(
  locale: ReplyLocale,
  farmName: string,
  summary: ExceptionSummary,
): string {
  const lines = [digestHeader(locale, farmName)]

  const raised = COUNTER_ORDER.filter((key) => summary[key] > 0)
  if (raised.length === 0) {
    lines.push(allClearLine(locale))
    return lines.join('\n')
  }

  for (const key of raised) {
    lines.push(`- ${pick(locale, COUNTER_LABELS[key])}: ${summary[key]}`)
  }
  if (summary.total > 0) lines.push(openItemsLine(locale, summary.total))

  return lines.join('\n')
}
