import { createI18n } from 'vue-i18n'
import en from './locales/en'
import yo from './locales/yo'
import pcm from './locales/pcm'
import fr from './locales/fr'
import exceptionsEn from './locales/exceptions/en'
import exceptionsYo from './locales/exceptions/yo'
import exceptionsPcm from './locales/exceptions/pcm'
import exceptionsFr from './locales/exceptions/fr'

const STORAGE_KEY = 'trovara-locale'

export type AppLocale = 'en' | 'yo' | 'pcm' | 'fr'

function savedLocale(): AppLocale {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'yo' || stored === 'pcm' || stored === 'fr') return stored
  return 'en'
}

export function persistLocale(locale: AppLocale) {
  localStorage.setItem(STORAGE_KEY, locale)
}

const messages = {
  en: { ...en, exceptions: exceptionsEn },
  yo: { ...yo, exceptions: exceptionsYo },
  pcm: { ...pcm, exceptions: exceptionsPcm },
  fr: { ...fr, exceptions: exceptionsFr },
}

const i18n = createI18n({
  legacy: false,
  locale: savedLocale(),
  fallbackLocale: 'en',
  messages,
})

export default i18n
