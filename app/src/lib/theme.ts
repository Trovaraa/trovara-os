export type ThemeMode = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'trovara_theme'

/** Current look of Trovara OS is dark — keep that as the default. */
export const DEFAULT_THEME: ThemeMode = 'dark'

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light'
}

export function readStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    if (isThemeMode(raw)) return raw
  } catch {
    // private mode / blocked storage
  }
  return DEFAULT_THEME
}

/** Apply theme on <html>. Dark keeps today's visuals unchanged. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  root.classList.toggle('light', mode === 'light')
  root.style.colorScheme = mode
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', mode === 'light' ? '#eef3f0' : '#1f6b42')
}

export function persistTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // ignore
  }
}

export function setTheme(mode: ThemeMode): void {
  applyTheme(mode)
  persistTheme(mode)
}

export function toggleTheme(): ThemeMode {
  const next: ThemeMode = document.documentElement.classList.contains('light') ? 'dark' : 'light'
  setTheme(next)
  return next
}

export function getActiveTheme(): ThemeMode {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark'
}
