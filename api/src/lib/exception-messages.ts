/**
 * Locale tables for exception messages, titles, and action labels.
 *
 * The same key vocabulary is rendered two ways: vue-i18n in the OS UI
 * (app/src/i18n/locales/exceptions/*) and `renderException` here for
 * Telegram/WhatsApp, which have no vue-i18n runtime.
 */
import type { ReplyLocale } from './reply-locale.js'

export type ExceptionMessageKey =
  | 'exceptions.msg.overdueSince'
  | 'exceptions.msg.overdueSinceUnknown'
  | 'exceptions.msg.lowStock'
  | 'exceptions.msg.awaitingApproval'
  | 'exceptions.msg.mortality'
  | 'exceptions.msg.mortalityWithNotes'
  | 'exceptions.msg.orderPending'
  | 'exceptions.msg.rejectedResubmit'
  | 'exceptions.msg.noDailyLog'
  | 'exceptions.msg.maintenanceDue'
  | 'exceptions.msg.reportedNeedsVerification'
  | 'exceptions.msg.noCensus'
  | 'exceptions.msg.censusRejected'
  | 'exceptions.msg.censusRejectedWithReason'
  | 'exceptions.msg.censusStale'
  | 'exceptions.title.batchMortality'
  | 'exceptions.title.order'
  | 'exceptions.title.censusSurvey'
  | 'exceptions.title.assetLog'
  | 'exceptions.action.approve'
  | 'exceptions.action.restock'
  | 'exceptions.action.confirmOrder'
  | 'exceptions.action.resubmit'
  | 'exceptions.action.reviewOverdue'
  | 'exceptions.action.reviewMortality'
  | 'exceptions.action.logEquipment'
  | 'exceptions.action.serviceEquipment'
  | 'exceptions.action.verifyAssetLog'
  | 'exceptions.action.recordCensus'
  | 'exceptions.action.resubmitCensus'
  | 'exceptions.action.refreshStaleCensus'
  | 'exceptions.action.weather'
  | 'exceptions.unassigned'
  | 'exceptions.staff'
  | 'exceptions.block'

export type ExceptionParams = Record<string, string | number>

/**
 * Params holding an ISO date string. Both renderers format these for the
 * target locale instead of interpolating the raw timestamp.
 */
export const DATE_PARAM_KEYS: ReadonlySet<string> = new Set([
  'since',
  'lastVerified',
  'nextService',
])

/** English is required; other locales fall back to English until translated. */
type LocaleTable = { en: string; fr?: string; yo?: string; pcm?: string }

export const EXCEPTION_MESSAGES: Record<ExceptionMessageKey, LocaleTable> = {
  'exceptions.msg.overdueSince': {
    en: 'Overdue since {since}',
    fr: 'En retard depuis le {since}',
    yo: 'Ó ti kọjá àkókò láti {since}',
    pcm: 'Don pass time since {since}',
  },
  'exceptions.msg.overdueSinceUnknown': {
    en: 'Still open, no due date recorded',
    fr: 'Toujours en cours, aucune échéance enregistrée',
    yo: 'Kò tíì parí, kò sí ọjọ́ ìparí tí a kọ sílẹ̀',
    pcm: 'E no finish yet, no due date dey',
  },
  'exceptions.msg.lowStock': {
    en: '{quantity} {unit} remaining (reorder at {reorderLevel} {unit})',
    fr: '{quantity} {unit} restants (réappro. à {reorderLevel} {unit})',
    yo: '{quantity} {unit} ló kù (tún paṣẹ ní {reorderLevel} {unit})',
    pcm: '{quantity} {unit} remain (reorder at {reorderLevel} {unit})',
  },
  'exceptions.msg.awaitingApproval': {
    en: 'Awaiting approval for over 12h ({assignee})',
    fr: 'En attente d’approbation depuis plus de 12 h ({assignee})',
    yo: 'Ń dúró fún ìfọwọ́sí ju wákàtí 12 lọ ({assignee})',
    pcm: 'Dey wait approval pass 12h ({assignee})',
  },
  'exceptions.msg.mortality': {
    en: '{count} died',
    fr: '{count} mort(s)',
    yo: '{count} ló kú',
    pcm: '{count} don die',
  },
  'exceptions.msg.mortalityWithNotes': {
    en: '{count} died: {notes}',
    fr: '{count} mort(s) : {notes}',
    yo: '{count} ló kú: {notes}',
    pcm: '{count} don die: {notes}',
  },
  'exceptions.msg.orderPending': {
    en: 'Pending over 48h - {currency} {amount}',
    fr: 'En attente depuis plus de 48 h - {currency} {amount}',
    yo: 'Ó ń dúró ju wákàtí 48 lọ - {currency} {amount}',
    pcm: 'Don dey wait pass 48h - {currency} {amount}',
  },
  'exceptions.msg.rejectedResubmit': {
    en: 'Rejected - needs resubmission ({assignee})',
    fr: 'Rejeté - à renvoyer ({assignee})',
    yo: 'Wọ́n kọ̀ ọ́ - tún fi ránṣẹ́ ({assignee})',
    pcm: 'Dem reject am - send am again ({assignee})',
  },
  'exceptions.msg.noDailyLog': {
    en: 'No daily log recorded yet today',
    fr: 'Aucun journal quotidien enregistré aujourd’hui',
    yo: 'Kò sí àkọsílẹ̀ ojoojúmọ́ lónìí',
    pcm: 'Never log daily record today',
  },
  'exceptions.msg.maintenanceDue': {
    en: 'Maintenance due (scheduled {nextService})',
    fr: 'Entretien dû (prévu le {nextService})',
    yo: 'Ìtọ́jú tó yẹ (tí a ṣètò fún {nextService})',
    pcm: 'Maintenance don due (scheduled {nextService})',
  },
  'exceptions.msg.reportedNeedsVerification': {
    en: 'Reported by {reporter} - needs verification',
    fr: 'Signalé par {reporter} - à vérifier',
    yo: '{reporter} ló ròyìn rẹ̀ - ó nílò ìjẹ́rìí',
    pcm: '{reporter} report am - e need verify',
  },
  'exceptions.msg.noCensus': {
    en: 'No verified crop census for this block',
    fr: 'Aucun recensement des cultures vérifié pour ce bloc',
    yo: 'Kò sí ìṣirò irúgbìn tí a jẹ́rìí fún block yìí',
    pcm: 'No verified crop census for dis block',
  },
  'exceptions.msg.censusRejected': {
    en: 'Census rejected - needs resubmission',
    fr: 'Recensement rejeté - à renvoyer',
    yo: 'Wọ́n kọ ìṣirò irúgbìn - tún fi ránṣẹ́',
    pcm: 'Dem reject census - send am again',
  },
  'exceptions.msg.censusRejectedWithReason': {
    en: 'Census rejected: {reason}',
    fr: 'Recensement rejeté : {reason}',
    yo: 'Wọ́n kọ ìṣirò irúgbìn: {reason}',
    pcm: 'Dem reject census: {reason}',
  },
  'exceptions.msg.censusStale': {
    en: 'Verified census older than {days} days (last {lastVerified})',
    fr: 'Recensement vérifié il y a plus de {days} jours (dernier {lastVerified})',
    yo: 'Ìṣirò tí a jẹ́rìí ti ju ọjọ́ {days} lọ (ìkẹyìn {lastVerified})',
    pcm: 'Verified census don pass {days} days (last na {lastVerified})',
  },

  'exceptions.title.batchMortality': {
    en: '{batch} mortality',
    fr: 'Mortalité {batch}',
    yo: 'Ikú {batch}',
    pcm: '{batch} death',
  },
  'exceptions.title.order': {
    en: 'Order: {customer}',
    fr: 'Commande : {customer}',
    yo: 'Àṣẹ: {customer}',
    pcm: 'Order: {customer}',
  },
  // {crop} carries `crop_type`, a free-text column users type into ("Crop type
  // (e.g. plantain, tomato)"), so it stays interpolated as-is. Do not add an
  // 'exceptions.crop.*' key table: no fixed set of keys can cover arbitrary
  // input, and translating user-entered content belongs on the runtime path.
  'exceptions.title.censusSurvey': {
    en: '{plot} · {crop}',
    fr: '{plot} · {crop}',
    yo: '{plot} · {crop}',
    pcm: '{plot} · {crop}',
  },
  'exceptions.title.assetLog': {
    en: 'Equipment log',
    fr: 'Journal d’équipement',
    yo: 'Àkọsílẹ̀ ohun èlò',
    pcm: 'Equipment log',
  },

  'exceptions.action.approve': {
    en: 'Approve: {title}',
    fr: 'Approuver : {title}',
    yo: 'Fọwọ́sí: {title}',
    pcm: 'Approve am: {title}',
  },
  'exceptions.action.restock': {
    en: 'Restock: {title}',
    fr: 'Réapprovisionner : {title}',
    yo: 'Tún ọjà kún: {title}',
    pcm: 'Restock: {title}',
  },
  'exceptions.action.confirmOrder': {
    en: 'Confirm order: {title}',
    fr: 'Confirmer la commande : {title}',
    yo: 'Fìdí àṣẹ múlẹ̀: {title}',
    pcm: 'Confirm order: {title}',
  },
  'exceptions.action.resubmit': {
    en: 'Resubmit: {title}',
    fr: 'Renvoyer : {title}',
    yo: 'Tún fi ránṣẹ́: {title}',
    pcm: 'Send am again: {title}',
  },
  'exceptions.action.reviewOverdue': {
    en: 'Review overdue task: {title}',
    fr: 'Examiner la tâche en retard : {title}',
    yo: 'Ṣàyẹ̀wò iṣẹ́ tó ti kọjá àkókò: {title}',
    pcm: 'Check work wey don pass time: {title}',
  },
  'exceptions.action.reviewMortality': {
    en: 'Review mortality: {title}',
    fr: 'Examiner la mortalité : {title}',
    yo: 'Ṣàyẹ̀wò ikú: {title}',
    pcm: 'Check death: {title}',
  },
  'exceptions.action.logEquipment': {
    en: 'Log equipment: {title}',
    fr: 'Enregistrer l’équipement : {title}',
    yo: 'Kọ ohun èlò sílẹ̀: {title}',
    pcm: 'Log equipment: {title}',
  },
  'exceptions.action.serviceEquipment': {
    en: 'Service equipment: {title}',
    fr: 'Entretenir l’équipement : {title}',
    yo: 'Ṣe ìtọ́jú ohun èlò: {title}',
    pcm: 'Service equipment: {title}',
  },
  'exceptions.action.verifyAssetLog': {
    en: 'Verify equipment log: {title}',
    fr: 'Vérifier le journal d’équipement : {title}',
    yo: 'Jẹ́rìí àkọsílẹ̀ ohun èlò: {title}',
    pcm: 'Verify equipment log: {title}',
  },
  'exceptions.action.recordCensus': {
    en: 'Record census: {title}',
    fr: 'Enregistrer le recensement : {title}',
    yo: 'Kọ ìṣirò irúgbìn sílẹ̀: {title}',
    pcm: 'Record census: {title}',
  },
  'exceptions.action.resubmitCensus': {
    en: 'Resubmit census: {title}',
    fr: 'Renvoyer le recensement : {title}',
    yo: 'Tún ìṣirò irúgbìn fi ránṣẹ́: {title}',
    pcm: 'Send census again: {title}',
  },
  'exceptions.action.refreshStaleCensus': {
    en: 'Refresh stale census: {title}',
    fr: 'Actualiser le recensement obsolète : {title}',
    yo: 'Sọ ìṣirò tó ti pẹ́ di tuntun: {title}',
    pcm: 'Update census wey don old: {title}',
  },
  'exceptions.action.weather': {
    en: 'Weather: {title}',
    fr: 'Météo : {title}',
    yo: 'Ojú ọjọ́: {title}',
    pcm: 'Weather: {title}',
  },

  'exceptions.unassigned': {
    en: 'unassigned',
    fr: 'non attribué',
    yo: 'kò yàn sí ẹnìkan',
    pcm: 'nobody get am',
  },
  'exceptions.staff': {
    en: 'staff',
    fr: 'personnel',
    yo: 'òṣìṣẹ́',
    pcm: 'staff',
  },
  'exceptions.block': {
    en: 'Block',
    fr: 'Bloc',
    yo: 'Block',
    pcm: 'Block',
  },
}

const INTL_LOCALE: Record<ReplyLocale, string> = {
  en: 'en-NG',
  fr: 'fr-FR',
  yo: 'yo-NG',
  pcm: 'en-NG',
}

/** Format an ISO date for display; returns the input unchanged if unparseable. */
export function formatExceptionDate(iso: string, locale: ReplyLocale): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(INTL_LOCALE[locale] ?? 'en-NG', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/** Render an exception key for a locale, formatting date params on the way. */
export function renderException(
  key: ExceptionMessageKey,
  locale: ReplyLocale,
  params: ExceptionParams = {},
): string {
  const table = EXCEPTION_MESSAGES[key]
  const template = table[locale] ?? table.en

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    if (value === undefined) return match
    if (DATE_PARAM_KEYS.has(name) && typeof value === 'string') {
      return formatExceptionDate(value, locale)
    }
    // A param may itself be a key (the 'unassigned' / 'staff' / 'Block'
    // fallbacks), which must translate rather than interpolate as English.
    if (isExceptionMessageKey(value)) return renderException(value, locale)
    return String(value)
  })
}

export function isExceptionMessageKey(value: unknown): value is ExceptionMessageKey {
  return typeof value === 'string' && Object.hasOwn(EXCEPTION_MESSAGES, value)
}
