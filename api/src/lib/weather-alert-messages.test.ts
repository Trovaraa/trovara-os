import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplyLocale } from './reply-locale.js'
import {
  clockLabel,
  forecastDayLabel,
  localizeWeatherAlerts,
  parseClockLabel,
  renderWeatherAlert,
} from './weather-alert-messages.js'
import { buildWeatherAlerts, type WeatherAlert, type WeatherDay } from './weather-alerts.js'

const LOCALES: ReplyLocale[] = ['en', 'fr', 'yo', 'pcm']
const NON_EN: ReplyLocale[] = ['fr', 'yo', 'pcm']

/** Lagos is UTC+1, so this is the morning of 2026-07-25 on the farm. */
const NOW = new Date('2026-07-25T09:00:00Z')
const TZ = 'Africa/Lagos'

function day(overrides: Partial<WeatherDay>): WeatherDay {
  return {
    date: '2026-07-26',
    tempMinC: 22,
    tempMaxC: 30,
    precipMm: 0,
    precipProb: 10,
    windKmh: 12,
    condition: 'Clear',
    ...overrides,
  }
}

/** One alert of every type, from the same forecast the API would serve. */
function allAlerts(): WeatherAlert[] {
  return buildWeatherAlerts(
    [
      day({
        precipMm: 12,
        precipProb: 80,
        tempMaxC: 37,
        windKmh: 50,
        tempMinC: 12,
        peakPrecipLocal: 'around 3:00 PM',
      }),
    ],
    42,
    TZ,
    NOW,
  )
}

describe('weather alert localization', () => {
  beforeEach(() => {
    // Thresholds are env-driven; pin them so expectations are hermetic.
    vi.stubEnv('WEATHER_HEAT_C', '35')
    vi.stubEnv('WEATHER_COLD_C', '15')
    vi.stubEnv('WEATHER_WIND_KMH', '40')
    vi.stubEnv('WEATHER_RAIN_MM', '5')
    vi.stubEnv('WEATHER_RAIN_PROB', '60')
  })

  it('renders all four alert types in all four locales', () => {
    for (const locale of LOCALES) {
      const alerts = localizeWeatherAlerts(locale, allAlerts(), NOW)
      expect(alerts.map((a) => a.type)).toEqual(['rain', 'heat', 'wind', 'cold'])
      for (const alert of alerts) {
        expect(alert.title.length).toBeGreaterThan(0)
        expect(alert.message.length).toBeGreaterThan(0)
        expect(alert.whenLabel?.length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps numeric values and units unchanged in every locale', () => {
    for (const locale of LOCALES) {
      const byType = new Map(localizeWeatherAlerts(locale, allAlerts(), NOW).map((a) => [a.type, a]))

      expect(byType.get('rain')!.message).toContain('12.0 mm')
      expect(byType.get('rain')!.message).toContain('80%')
      expect(byType.get('heat')!.message).toContain('37°C')
      expect(byType.get('wind')!.message).toContain('50 km/h')
      expect(byType.get('cold')!.message).toContain('12°C')
    }
  })

  it('leaves type, severity, and date untouched by localization', () => {
    const english = allAlerts()
    for (const locale of NON_EN) {
      const localized = localizeWeatherAlerts(locale, english, NOW)
      expect(localized.map((a) => ({ type: a.type, severity: a.severity, date: a.date }))).toEqual(
        english.map((a) => ({ type: a.type, severity: a.severity, date: a.date })),
      )
    }
  })

  it('gives an English viewer byte-identical text to buildWeatherAlerts', () => {
    const english = allAlerts()
    expect(localizeWeatherAlerts('en', english, NOW)).toEqual(english)
  })

  it('never falls back to English text for another locale', () => {
    const english = new Map(allAlerts().map((a) => [a.type, a]))
    for (const locale of NON_EN) {
      for (const alert of localizeWeatherAlerts(locale, allAlerts(), NOW)) {
        const en = english.get(alert.type)!
        expect(alert.title, `${locale} ${alert.type} title`).not.toBe(en.title)
        expect(alert.message, `${locale} ${alert.type} message`).not.toBe(en.message)
        expect(alert.whenLabel, `${locale} ${alert.type} whenLabel`).not.toBe(en.whenLabel)
      }
    }
  })

  it('translates the fixed time phrases, not just the titles', () => {
    const byLocale = (locale: ReplyLocale) =>
      new Map(localizeWeatherAlerts(locale, allAlerts(), NOW).map((a) => [a.type, a]))

    const fr = byLocale('fr')
    expect(fr.get('heat')!.whenLabel).toContain('pic de chaleur')
    expect(fr.get('cold')!.message).toContain('tôt le matin')
    expect(fr.get('cold')!.whenLabel).toContain('tôt le matin')
    expect(fr.get('rain')!.whenLabel).toContain('vers')

    const yo = byLocale('yo')
    expect(yo.get('cold')!.message).toContain('kùtùkùtù òwúrọ̀')
    expect(yo.get('heat')!.whenLabel).toContain('ooru ọ̀sán')

    const pcm = byLocale('pcm')
    expect(pcm.get('heat')!.whenLabel).toContain('hottest afternoon')
  })

  it('localizes the rain window when the forecast has no hourly peak', () => {
    const daily = [day({ precipMm: 12, precipProb: 80 })]
    const rainEn = buildWeatherAlerts(daily, 5, TZ, NOW)[0]
    expect(rainEn.whenLabel).toContain(', mainly afternoon / evening')

    const rainFr = renderWeatherAlert('fr', rainEn, NOW)
    expect(rainFr.whenLabel).toContain('principalement l’après-midi')
    expect(rainFr.whenLabel).not.toContain('afternoon')
  })

  it('localizes the current-period label when wind has no forecast day', () => {
    const windEn = buildWeatherAlerts([day({})], 60, TZ, NOW).find((a) => a.type === 'wind')!
    expect(windEn.whenLabel).toBe('in the current period')
    expect(windEn.date).toBeUndefined()

    expect(renderWeatherAlert('fr', windEn, NOW).whenLabel).toBe('pendant la période actuelle')
    expect(renderWeatherAlert('yo', windEn, NOW).whenLabel).toBe('ní àkókò yìí')
    expect(renderWeatherAlert('pcm', windEn, NOW).whenLabel).toBe('for dis current period')
  })

  it('returns the alert unchanged when it carries no params', () => {
    const legacy: WeatherAlert = {
      type: 'rain',
      severity: 'high',
      title: 'Heavy rain risk',
      message: 'Expected tomorrow.',
    }
    expect(renderWeatherAlert('fr', legacy, NOW)).toBe(legacy)
  })
})

describe('forecastDayLabel', () => {
  it('names relative days in the target language', () => {
    expect(forecastDayLabel('en', '2026-07-26', TZ, NOW)).toBe('Tomorrow (Sun, Jul 26)')
    expect(forecastDayLabel('fr', '2026-07-26', TZ, NOW)).toBe('Demain (dim. 26 juil.)')
    expect(forecastDayLabel('yo', '2026-07-26', TZ, NOW)).toContain('Ọ̀la (')
    expect(forecastDayLabel('pcm', '2026-07-26', TZ, NOW)).toBe('Tomorrow (Sun, 26 Jul)')

    expect(forecastDayLabel('en', '2026-07-25', TZ, NOW)).toBe('Today (Sat, Jul 25)')
    expect(forecastDayLabel('fr', '2026-07-25', TZ, NOW)).toBe('Aujourd’hui (sam. 25 juil.)')
    expect(forecastDayLabel('yo', '2026-07-25', TZ, NOW)).toContain('Lónìí (')
  })

  it('names weekdays via Intl, so each locale differs from English', () => {
    const en = forecastDayLabel('en', '2026-07-27', TZ, NOW)
    expect(en).toBe('Mon, Jul 27')
    for (const locale of NON_EN) {
      expect(forecastDayLabel(locale, '2026-07-27', TZ, NOW), locale).not.toBe(en)
    }
    expect(forecastDayLabel('fr', '2026-07-27', TZ, NOW)).toBe('lun. 27 juil.')
    // Yoruba month/weekday names come from ICU, not a hand-written table.
    expect(forecastDayLabel('yo', '2026-07-27', TZ, NOW)).toMatch(/Ajé|Oṣù/)
  })

  it('keeps the Africa/Lagos day boundary regardless of language', () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1).
    const lateUtc = new Date('2026-07-26T23:30:00Z')
    for (const locale of LOCALES) {
      const label = forecastDayLabel(locale, '2026-07-27', TZ, lateUtc)
      const today = forecastDayLabel(locale, '2026-07-27', TZ, new Date('2026-07-27T09:00:00Z'))
      expect(label, locale).toBe(today)
    }
  })
})

describe('clock labels', () => {
  it('parses the language-neutral cached label', () => {
    expect(parseClockLabel('around 3:00 PM')).toEqual({ hour: 15, minute: 0 })
    expect(parseClockLabel('around 12:30 AM')).toEqual({ hour: 0, minute: 30 })
    expect(parseClockLabel('around 12:15 PM')).toEqual({ hour: 12, minute: 15 })
    expect(parseClockLabel('around 6:05 AM')).toEqual({ hour: 6, minute: 5 })
    expect(parseClockLabel(null)).toBeNull()
    expect(parseClockLabel('mainly afternoon')).toBeNull()
  })

  it('renders each locale in its own clock convention', () => {
    const clock = { hour: 15, minute: 0 }
    expect(clockLabel('en', clock)).toBe('around 3:00 PM')
    expect(clockLabel('fr', clock)).toBe('vers 15:00')
    expect(clockLabel('yo', clock)).toContain('ní nǹkan bí')
    expect(clockLabel('pcm', clock)).toContain('around')
  })
})
