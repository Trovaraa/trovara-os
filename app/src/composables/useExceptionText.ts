import { useI18n } from 'vue-i18n'

/** Interpolation params carried alongside an exception/action i18n key. */
export type ExceptionParams = Record<string, string | number>

/** Localizable parts of an `ExceptionItem` from `/api/today`. */
export type ExceptionText = {
  title: string
  titleKey?: string
  titleParams?: ExceptionParams
  message: string
  messageKey?: string
  messageParams?: ExceptionParams
}

/** Localizable parts of an `ActionItem` from `/api/today` or the action-list report. */
export type ActionText = {
  label: string
  labelKey?: string
  labelParams?: ExceptionParams
  titleKey?: string
  titleParams?: ExceptionParams
}

/**
 * Params holding an ISO date string. Mirrors DATE_PARAM_KEYS in
 * api/src/lib/exception-messages.ts; both renderers format these for the
 * active locale instead of interpolating the raw timestamp.
 */
export const DATE_PARAM_KEYS: ReadonlySet<string> = new Set(['since', 'lastVerified'])

const KEY_PREFIX = 'exceptions.'

const INTL_LOCALE: Record<string, string> = {
  en: 'en-NG',
  fr: 'fr-FR',
  yo: 'yo-NG',
  pcm: 'en-NG',
}

/**
 * Resolves the English strings or i18n keys the API sends for exceptions and
 * action items. Keys are optional: weather-derived exceptions are localized
 * server-side and carry none, so the plain field is always the fallback.
 */
export function useExceptionText() {
  const { t, te, locale } = useI18n()

  /** True when a key resolves in the active locale or the English fallback. */
  function exists(key: string) {
    return te(key) || te(key, 'en')
  }

  /** Same shape as TodayView's formatTime, but pinned to the active locale. */
  function formatDateParam(iso: string) {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    try {
      return new Intl.DateTimeFormat(INTL_LOCALE[locale.value] ?? locale.value, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    } catch {
      return date.toISOString().slice(0, 10)
    }
  }

  function resolveParams(params: ExceptionParams) {
    const resolved: ExceptionParams = {}
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'string' && DATE_PARAM_KEYS.has(name)) {
        resolved[name] = formatDateParam(value)
      } else if (typeof value === 'string' && value.startsWith(KEY_PREFIX) && exists(value)) {
        // A param value may itself be a key (the unassigned / staff / Block
        // fallbacks), which must translate rather than print literally.
        resolved[name] = t(value)
      } else {
        resolved[name] = value
      }
    }
    return resolved
  }

  function resolve(key: string | undefined, params: ExceptionParams | undefined, fallback: string) {
    const translated = key && exists(key) ? t(key, resolveParams(params ?? {})) : ''
    return translated || fallback || ''
  }

  function exceptionTitle(ex: ExceptionText) {
    return resolve(ex.titleKey, ex.titleParams, ex.title)
  }

  function exceptionMessage(ex: ExceptionText) {
    return resolve(ex.messageKey, ex.messageParams, ex.message)
  }

  /** Action labels wrap a title (`Approve: {title}`), so resolve the inner title first. */
  function actionLabel(action: ActionText) {
    const nestedTitle = action.titleKey
      ? resolve(action.titleKey, action.titleParams, String(action.labelParams?.title ?? ''))
      : action.labelParams?.title
    const params =
      nestedTitle === undefined
        ? action.labelParams
        : { ...action.labelParams, title: nestedTitle }
    return resolve(action.labelKey, params, action.label)
  }

  return { exceptionTitle, exceptionMessage, actionLabel, formatDateParam }
}
