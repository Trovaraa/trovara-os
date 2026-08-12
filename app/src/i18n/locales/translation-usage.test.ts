import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import en from './en'

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|vue)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function hasMessage(key: string) {
  return key.split('.').every((part, index, parts) => {
    const value = parts.slice(0, index + 1).reduce<unknown>((current, segment) =>
      current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined,
    en)
    return value !== undefined
  })
}

describe('translation usage', () => {
  it('resolves every static t() key used by the app', () => {
    const keys = sourceFiles(sourceRoot).flatMap((path) => {
      const content = readFileSync(path, 'utf8')
      return [...content.matchAll(/\bt\s*\(\s*['"]([\w.-]+)['"]/g)].map((match) => match[1])
    })

    expect([...new Set(keys)].filter((key) => !hasMessage(key))).toEqual([])
  })
})
