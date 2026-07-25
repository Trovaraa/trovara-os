import type { ReplyLocale } from './reply-locale.js'

export type AdvisoryCloseDomain = 'livestock' | 'crop' | 'general'

const CLOSE_LINES: Record<AdvisoryCloseDomain, Record<ReplyLocale, string>> = {
  livestock: {
    en: 'If the symptoms persist, see a vet.',
    pcm: 'If di symptoms still dey, go see vet.',
    yo: 'Tí àmì àìsàn náà bá tẹ̀síwájú, lọ rí dókítà ẹranko.',
    fr: 'Si les symptômes persistent, consultez un vétérinaire.',
  },
  crop: {
    en: 'If the symptoms persist, see a vet or extension officer.',
    pcm: 'If di symptoms still dey, go see vet or extension officer.',
    yo: 'Tí àmì àìsàn náà bá tẹ̀síwájú, lọ rí dókítà ẹranko tàbí òṣìṣẹ́ ìtọ́jú oko.',
    fr: 'Si les symptômes persistent, consultez un vétérinaire ou un agent de vulgarisation.',
  },
  general: {
    en: 'If the symptoms persist, see a vet.',
    pcm: 'If di symptoms still dey, go see vet.',
    yo: 'Tí àmì àìsàn náà bá tẹ̀síwájú, lọ rí dókítà ẹranko.',
    fr: 'Si les symptômes persistent, consultez un vétérinaire.',
  },
}

export function advisoryCloseLine(
  locale: ReplyLocale = 'en',
  domain: AdvisoryCloseDomain = 'general',
): string {
  return CLOSE_LINES[domain][locale] ?? CLOSE_LINES[domain].en
}

/** Append the close line if the reply does not already contain a vet escalation. */
export function ensureAdvisoryClose(
  text: string,
  locale: ReplyLocale = 'en',
  domain: AdvisoryCloseDomain = 'general',
): string {
  const trimmed = text.trim()
  if (!trimmed) return advisoryCloseLine(locale, domain)
  if (/\b(see a vet|consultez un vétérinaire|go see vet|dókítà ẹranko)\b/i.test(trimmed)) {
    return trimmed
  }
  return `${trimmed}\n\n${advisoryCloseLine(locale, domain)}`
}
