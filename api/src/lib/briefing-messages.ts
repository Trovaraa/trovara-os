/**
 * Locale tables for the daily briefing at `GET /api/ai/briefing`.
 *
 * The briefing's priorities are derived from farm counts, not written by a
 * model: `buildStructuredBriefing` decides "there are 3 tasks awaiting
 * approval" and then needs a sentence to say it in. Those sentences are
 * developer-authored chrome, so they come from a table for the same reasons
 * digest-messages.ts and weather-alert-messages.ts do — instant, free, and
 * correct with the LLM switched off or over budget, which is exactly when an
 * owner still needs to know what is waiting on them.
 *
 * Nothing here is user content. Item names, farm names, counts, quantities and
 * units are interpolated as parameters and never translated: a farm that stocks
 * "Engrais NPK" reads that name back verbatim in every language. Prose a model
 * wrote (incident summaries, diagnoses) keeps using the canonical-English plus
 * translate-on-read path in content-locale.ts; the two never mix.
 */
import type { ReplyLocale } from './reply-locale.js'

export type BriefingMessageKey =
  | 'briefing.farmFallback'
  | 'briefing.approvals.label'
  | 'briefing.approvals.detail'
  | 'briefing.restock.label'
  | 'briefing.restock.detail'
  | 'briefing.pendingTasks.label'
  | 'briefing.pendingTasks.detail'
  | 'briefing.fieldWork.label'
  | 'briefing.fieldWork.detail'

export type BriefingParams = Record<string, string | number>

type LocaleTable = Record<ReplyLocale, string>

export const BRIEFING_MESSAGES: Record<BriefingMessageKey, LocaleTable> = {
  // Stands in for a farm row that has no name yet; a farm that has one reads
  // its own name back untranslated.
  'briefing.farmFallback': {
    en: 'Farm',
    fr: 'Ferme',
    yo: 'Oko',
    pcm: 'Farm',
  },

  'briefing.approvals.label': {
    en: 'Approve worker submissions',
    fr: 'Approuver les soumissions des ouvriers',
    yo: 'Fọwọ́sí iṣẹ́ tí àwọn òṣìṣẹ́ fi ránṣẹ́',
    pcm: 'Approve wetin workers send',
  },
  'briefing.approvals.detail': {
    en: '{count} task(s) waiting for your review',
    fr: '{count} tâche(s) en attente de votre examen',
    yo: 'Iṣẹ́ {count} ń dúró de àyẹ̀wò rẹ',
    pcm: '{count} work dey wait make you check am',
  },

  'briefing.restock.label': {
    en: 'Restock {item}',
    fr: 'Réapprovisionner {item}',
    yo: 'Tún {item} kún',
    pcm: 'Restock {item}',
  },
  'briefing.restock.detail': {
    en: '{quantity} {unit} left - reorder at {reorderLevel}',
    fr: '{quantity} {unit} restants - réappro. à {reorderLevel}',
    yo: '{quantity} {unit} ló kù - tún paṣẹ ní {reorderLevel}',
    pcm: '{quantity} {unit} remain - reorder at {reorderLevel}',
  },

  'briefing.pendingTasks.label': {
    en: 'Assign or follow up pending tasks',
    fr: 'Attribuer ou relancer les tâches en attente',
    yo: 'Yan tàbí tọ̀ àwọn iṣẹ́ tó ń dúró lẹ́yìn',
    pcm: 'Give person di work wey never start or follow am up',
  },
  'briefing.pendingTasks.detail': {
    en: '{count} task(s) not started',
    fr: '{count} tâche(s) non commencée(s)',
    yo: 'Iṣẹ́ {count} kò tíì bẹ̀rẹ̀',
    pcm: '{count} work never start',
  },

  'briefing.fieldWork.label': {
    en: 'Check in on field work',
    fr: 'Faire le point sur le travail au champ',
    yo: 'Ṣàyẹ̀wò iṣẹ́ oko tó ń lọ lọ́wọ́',
    pcm: 'Check di work wey dey go for farm',
  },
  'briefing.fieldWork.detail': {
    en: '{count} task(s) in progress today',
    fr: '{count} tâche(s) en cours aujourd’hui',
    yo: 'Iṣẹ́ {count} ló ń lọ lọ́wọ́ lónìí',
    pcm: '{count} work dey go on today',
  },
}

/**
 * Intl tags per reply locale, mirroring exception-messages.ts. Pidgin has no
 * date conventions of its own and is written in Nigerian English digits and
 * month names, so it formats as en-NG.
 */
const INTL_LOCALE: Record<ReplyLocale, string> = {
  en: 'en-NG',
  fr: 'fr-FR',
  yo: 'yo-NG',
  pcm: 'en-NG',
}

/** Render a briefing key for a locale, interpolating `{param}` placeholders. */
export function renderBriefing(
  key: BriefingMessageKey,
  locale: ReplyLocale,
  params: BriefingParams = {},
): string {
  const table = BRIEFING_MESSAGES[key]
  const template = table[locale] ?? table.en

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** The briefing's date line, named in the viewer's language. */
export function briefingDateLabel(locale: ReplyLocale, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat(INTL_LOCALE[locale] ?? INTL_LOCALE.en, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}
