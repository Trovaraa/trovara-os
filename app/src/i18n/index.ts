import { createI18n } from 'vue-i18n'
import en from './locales/en'
import exceptionsEn from './locales/exceptions/en'
import { withLocaleFallback } from './locale-parity'

const STORAGE_KEY = 'trovara-locale'

export type AppLocale = 'en' | 'yo' | 'pcm' | 'fr'

export function savedLocale(): AppLocale {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'yo' || stored === 'pcm' || stored === 'fr') return stored
  return 'en'
}

export function persistLocale(locale: AppLocale) {
  localStorage.setItem(STORAGE_KEY, locale)
}

const englishMessages = { ...en, exceptions: exceptionsEn }
type MessageSchema = typeof englishMessages
const initialLocale = savedLocale()
const loadedLocales = new Set<AppLocale>(['en'])
const loadingLocales = new Map<AppLocale, Promise<void>>()

const localeLoaders: Partial<Record<AppLocale, () => Promise<MessageSchema>>> = {
  yo: async () => {
    const [{ default: messages }, { default: exceptions }] = await Promise.all([
      import('./locales/yo'),
      import('./locales/exceptions/yo'),
    ])
    return withLocaleFallback(englishMessages, { ...messages, exceptions })
  },
  pcm: async () => {
    const [{ default: messages }, { default: exceptions }] = await Promise.all([
      import('./locales/pcm'),
      import('./locales/exceptions/pcm'),
    ])
    return withLocaleFallback(englishMessages, { ...messages, exceptions })
  },
  fr: async () => {
    const [{ default: messages }, { default: exceptions }] = await Promise.all([
      import('./locales/fr'),
      import('./locales/exceptions/fr'),
    ])
    return withLocaleFallback(englishMessages, { ...messages, exceptions })
  },
}

const i18n = createI18n<[MessageSchema], AppLocale, false>({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en',
  // The other locale keys are installed by ensureLocaleLoaded before use.
  messages: { en: englishMessages } as Record<AppLocale, MessageSchema>,
})

/** Load one translation dictionary on demand and share concurrent requests. */
export async function ensureLocaleLoaded(locale: AppLocale): Promise<void> {
  if (loadedLocales.has(locale)) return
  const inFlight = loadingLocales.get(locale)
  if (inFlight) return inFlight

  const loader = localeLoaders[locale]
  if (!loader) return
  const pending = loader()
    .then((messages) => {
      i18n.global.setLocaleMessage(locale, messages)
      loadedLocales.add(locale)
    })
    .finally(() => loadingLocales.delete(locale))
  loadingLocales.set(locale, pending)
  return pending
}

/** Ensure a remembered non-English locale is ready before the first render. */
export async function prepareInitialLocale(): Promise<void> {
  await ensureLocaleLoaded(initialLocale)
}

export default i18n
