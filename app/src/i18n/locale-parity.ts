type Messages = Record<string, unknown>

/** Fill untranslated leaves from English while preserving every localized value. */
export function withLocaleFallback<T extends Messages>(english: T, localized: Messages): T {
  return Object.fromEntries(
    Object.entries(english).map(([key, englishValue]) => {
      const localizedValue = localized[key]
      if (
        englishValue &&
        localizedValue &&
        typeof englishValue === 'object' &&
        typeof localizedValue === 'object' &&
        !Array.isArray(englishValue) &&
        !Array.isArray(localizedValue)
      ) {
        return [
          key,
          withLocaleFallback(englishValue as Messages, localizedValue as Messages),
        ]
      }
      return [key, localizedValue ?? englishValue]
    }),
  ) as T
}
