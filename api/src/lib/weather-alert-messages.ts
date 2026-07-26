/**
 * Locale tables for the four forecast alert templates (rain, heat, wind, cold).
 *
 * Sibling of digest-messages.ts: these are developer-authored templates with
 * numeric parameters, not user free text, so they render from a deterministic
 * table instead of the LLM — instant, free, and correct with the AI off.
 *
 * Numbers and units (mm, %, °C, km/h) are written identically in every locale;
 * only the surrounding words change. Weekday and relative-day naming comes from
 * Intl in the target locale; the fixed phrases around it are table entries.
 */
import type { ReplyLocale } from './reply-locale.js'
import type { WeatherAlert, WeatherAlertType } from './weather-alerts.js'

type MsgTable = Record<ReplyLocale, string>

function pick(locale: ReplyLocale, table: MsgTable): string {
  return table[locale] ?? table.en
}

/**
 * Intl tags per reply locale.
 *
 * `en` is 'en-US' rather than the 'en-NG' used by `exception-messages` and
 * `useExceptionText`, because these render a clock and those render a date.
 * The English clock here has to come out byte-identical to the one
 * `formatLocalClockLabel` writes into the forecast cache, and 'en-NG' spells it
 * '3:45 pm' where 'en-US' spells it '3:45 PM'. No viewer sees both conventions
 * on the same kind of value, so the two tables can differ.
 */
const INTL_LOCALES: Record<ReplyLocale, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  yo: 'yo-NG',
  pcm: 'en-NG',
}

/** Farm-local wall clock of a forecast peak, already resolved to the farm timezone. */
export type ClockTime = { hour: number; minute: number }

/**
 * Everything behind an alert's prose: the numbers, the date, and the farm
 * timezone. Carried on the alert so any viewer language can be rendered from
 * data rather than by re-parsing English.
 */
export type WeatherAlertLocaleParams = { timeZone: string } & (
  | {
      type: 'rain'
      date: string
      precipMm: number
      precipProb: number | null
      /** Parsed peak-precip clock, when the forecast has hourly detail. */
      peakClock: ClockTime | null
      /** Raw cached clock label, used verbatim if it could not be parsed. */
      peakLabel: string | null
    }
  | { type: 'heat'; date: string; tempMaxC: number }
  | { type: 'wind'; date: string | null; windKmh: number }
  | { type: 'cold'; date: string; tempMinC: number }
)

const TITLES: Record<WeatherAlertType, MsgTable> = {
  rain: {
    en: 'Heavy rain risk',
    fr: 'Risque de fortes pluies',
    yo: 'Ewu òjò líle',
    pcm: 'Heavy rain wan fall',
  },
  heat: {
    en: 'Heat stress risk',
    fr: 'Risque de stress thermique',
    yo: 'Ewu ooru líle',
    pcm: 'Heat wahala risk',
  },
  wind: {
    en: 'Strong wind',
    fr: 'Vent fort',
    yo: 'Ẹ̀fúùfù líle',
    pcm: 'Strong breeze dey come',
  },
  cold: {
    en: 'Low temperature',
    fr: 'Température basse',
    yo: 'Òtútù líle',
    pcm: 'Cold weather',
  },
}

export function weatherAlertTitle(locale: ReplyLocale, type: WeatherAlertType): string {
  return pick(locale, TITLES[type])
}

function middayUtc(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00Z`)
}

function dayKey(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

function relativeDayLabel(locale: ReplyLocale, day: 'today' | 'tomorrow', weekday: string): string {
  if (day === 'today') {
    return pick(locale, {
      en: `Today (${weekday})`,
      fr: `Aujourd’hui (${weekday})`,
      yo: `Lónìí (${weekday})`,
      pcm: `Today (${weekday})`,
    })
  }
  return pick(locale, {
    en: `Tomorrow (${weekday})`,
    fr: `Demain (${weekday})`,
    yo: `Ọ̀la (${weekday})`,
    pcm: `Tomorrow (${weekday})`,
  })
}

/**
 * Relative day label in the farm timezone, named in the viewer's language.
 * The timezone is unchanged by locale — only the words are translated.
 */
export function forecastDayLabel(
  locale: ReplyLocale,
  dateStr: string,
  timeZone: string,
  now = new Date(),
): string {
  const tz = timeZone || 'Africa/Lagos'
  const weekday = new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(middayUtc(dateStr))

  if (dateStr === dayKey(now, tz)) return relativeDayLabel(locale, 'today', weekday)
  if (dateStr === dayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz)) {
    return relativeDayLabel(locale, 'tomorrow', weekday)
  }
  return weekday
}

/** "around 3:00 PM" / "vers 15:00" — each locale uses its own clock convention. */
export function clockLabel(locale: ReplyLocale, clock: ClockTime): string {
  const at = new Date(Date.UTC(2000, 0, 1, clock.hour, clock.minute))
  const time = new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at)
  return pick(locale, {
    en: `around ${time}`,
    fr: `vers ${time}`,
    yo: `ní nǹkan bí ${time}`,
    pcm: `around ${time}`,
  })
}

const CLOCK_LABEL_RE = /^\s*around\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\s*$/i

/**
 * Read back the language-neutral clock label the forecast cache stores
 * (`WeatherDay.peakPrecipLocal`, e.g. "around 3:00 PM") so it can be re-rendered
 * in the viewer's language. Already farm-local wall time, so no timezone maths.
 */
export function parseClockLabel(label?: string | null): ClockTime | null {
  const match = CLOCK_LABEL_RE.exec(label ?? '')
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  const meridiem = match[3]?.toUpperCase()
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null
  if (meridiem === 'PM' && hour < 12) hour += 12
  if (meridiem === 'AM' && hour === 12) hour = 0
  if (hour > 23) return null
  return { hour, minute }
}

function rainWindowSuffix(locale: ReplyLocale): string {
  return pick(locale, {
    en: ', mainly afternoon / evening',
    fr: ', principalement l’après-midi / le soir',
    yo: ', ní pàtàkì ọ̀sán / alẹ́',
    pcm: ', mostly afternoon / evening',
  })
}

function peakAfternoonHeat(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'peak afternoon heat',
    fr: 'pic de chaleur de l’après-midi',
    yo: 'ooru ọ̀sán tó gbóná jù',
    pcm: 'di hottest afternoon time',
  })
}

function earlyMorning(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'early morning',
    fr: 'tôt le matin',
    yo: 'kùtùkùtù òwúrọ̀',
    pcm: 'early morning',
  })
}

function currentPeriod(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'in the current period',
    fr: 'pendant la période actuelle',
    yo: 'ní àkókò yìí',
    pcm: 'for dis current period',
  })
}

function rainChance(locale: ReplyLocale, precipProb: number): string {
  return pick(locale, {
    en: `${precipProb}% chance`,
    fr: `${precipProb}% de probabilité`,
    yo: `${precipProb}% àǹfààní`,
    pcm: `${precipProb}% chance`,
  })
}

/** When window for a rain alert: day plus the peak clock, or a daytime window. */
function rainWhenLabel(
  locale: ReplyLocale,
  params: Extract<WeatherAlertLocaleParams, { type: 'rain' }>,
  now: Date,
): string {
  const day = forecastDayLabel(locale, params.date, params.timeZone, now)
  if (params.peakClock) return `${day} ${clockLabel(locale, params.peakClock)}`
  if (params.peakLabel) return `${day} ${params.peakLabel}`
  return `${day}${rainWindowSuffix(locale)}`
}

/**
 * Render one alert's prose into `locale`. `type`, `severity`, and `date` are
 * copied through untouched — they are matched on by the advisory playbooks and
 * the Today exception mapping, so they must stay a stable enum.
 */
export function renderWeatherAlert(
  locale: ReplyLocale,
  alert: WeatherAlert,
  now = new Date(),
): WeatherAlert {
  const params = alert.params
  if (!params) return alert

  switch (params.type) {
    case 'rain': {
      const when = rainWhenLabel(locale, params, now)
      const amount = `${params.precipMm.toFixed(1)} mm`
      const chance = params.precipProb != null ? ` · ${rainChance(locale, params.precipProb)}` : ''
      const detail = `${when} (${amount}${chance})`
      return {
        ...alert,
        title: weatherAlertTitle(locale, 'rain'),
        message: pick(locale, {
          en: `Expected ${detail}.`,
          fr: `Prévue ${detail}.`,
          yo: `À ń retí rẹ̀ ${detail}.`,
          pcm: `E go fall ${detail}.`,
        }),
        whenLabel: when,
        timingDetail: detail,
      }
    }
    case 'heat': {
      const when = forecastDayLabel(locale, params.date, params.timeZone, now)
      const high = `${params.tempMaxC.toFixed(0)}°C`
      return {
        ...alert,
        title: weatherAlertTitle(locale, 'heat'),
        message: pick(locale, {
          en: `${when}: high around ${high} — shade, water, and livestock cooling.`,
          fr: `${when} : maximum autour de ${high} — ombre, eau et rafraîchissement du bétail.`,
          yo: `${when}: ìgbóná gíga tó tó ${high} — ibòji, omi, àti ìtutù ẹran ọ̀sìn.`,
          pcm: `${when}: heat go reach ${high} — give shade, water, and cool di animals.`,
        }),
        whenLabel: `${when}, ${peakAfternoonHeat(locale)}`,
      }
    }
    case 'wind': {
      const when = params.date
        ? forecastDayLabel(locale, params.date, params.timeZone, now)
        : currentPeriod(locale)
      const peak = `${params.windKmh.toFixed(0)} km/h`
      return {
        ...alert,
        title: weatherAlertTitle(locale, 'wind'),
        message: pick(locale, {
          en: `Up to ${peak} ${when} — secure covers, irrigation lines, and light structures.`,
          fr: `Jusqu’à ${peak} ${when} — fixez les bâches, les lignes d’irrigation et les structures légères.`,
          yo: `Ó lè dé ${peak} ${when} — dè àwọn ìbòrí, ọ̀nà omi, àti àwọn ilé fẹ́lẹ́fẹ́.`,
          pcm: `E go reach ${peak} ${when} — tie down covers, irrigation lines, and light structures.`,
        }),
        whenLabel: when,
      }
    }
    case 'cold': {
      const when = forecastDayLabel(locale, params.date, params.timeZone, now)
      const low = `${params.tempMinC.toFixed(0)}°C`
      const morning = earlyMorning(locale)
      return {
        ...alert,
        title: weatherAlertTitle(locale, 'cold'),
        message: pick(locale, {
          en: `${when}: low around ${low} (${morning}) — protect tender crops and young stock.`,
          fr: `${when} : minimum autour de ${low} (${morning}) — protégez les cultures fragiles et les jeunes animaux.`,
          yo: `${when}: ìsàlẹ̀ tó tó ${low} (${morning}) — dáàbò bo àwọn ọ̀gbìn tuntun àti ẹran kékeré.`,
          pcm: `${when}: cold go reach ${low} (${morning}) — protect small crops and young animals.`,
        }),
        whenLabel: `${when}, ${morning}`,
      }
    }
  }
}

/** Render a whole alert list into one viewer's language. */
export function localizeWeatherAlerts(
  locale: ReplyLocale,
  alerts: WeatherAlert[],
  now = new Date(),
): WeatherAlert[] {
  return alerts.map((alert) => renderWeatherAlert(locale, alert, now))
}
