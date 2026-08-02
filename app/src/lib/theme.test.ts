import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME,
  applyTheme,
  getActiveTheme,
  isThemeMode,
  readStoredTheme,
  setTheme,
  THEME_STORAGE_KEY,
  toggleTheme,
} from './theme'

describe('theme', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark', 'light')
    localStorage.removeItem(THEME_STORAGE_KEY)
  })

  it('defaults to dark', () => {
    expect(DEFAULT_THEME).toBe('dark')
    expect(readStoredTheme()).toBe('dark')
  })

  it('validates theme modes', () => {
    expect(isThemeMode('dark')).toBe(true)
    expect(isThemeMode('light')).toBe(true)
    expect(isThemeMode('system')).toBe(false)
  })

  it('applies light and dark classes without changing default storage until setTheme', () => {
    applyTheme('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(getActiveTheme()).toBe('light')

    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(getActiveTheme()).toBe('dark')
  })

  it('persists via setTheme and toggles', () => {
    setTheme('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(toggleTheme()).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(readStoredTheme()).toBe('dark')
  })
})
