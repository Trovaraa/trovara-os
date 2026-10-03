import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'))
const entries = Object.entries(lock.packages)
const versions = name => entries.filter(([path]) => path.endsWith('/node_modules/' + name) || path === 'node_modules/' + name).map(([, pkg]) => pkg.version)
const atLeast = (version, minimum) => {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'security floor requires a stable release')
  const a = version.split('.').map(Number), b = minimum.split('.').map(Number)
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))
}

test('Tailwind v4 removes the unpatched braces dependency chain', () => {
  for (const name of ['braces', 'micromatch', 'fast-glob']) assert.deepEqual(versions(name), [], name)
  assert.ok(versions('tailwindcss').length > 0)
  for (const version of versions('tailwindcss')) assert.ok(atLeast(version, '4.3.3'))
  assert.ok(versions('@tailwindcss/postcss').length > 0)
})

test('all nested brace-expansion resolutions include the DoS fixes', () => {
  assert.ok(versions('brace-expansion').length > 0)
  for (const version of versions('brace-expansion')) {
    const major = Number(version.split('.')[0])
    const minimum = major === 1 ? '1.1.21' : major === 2 ? '2.1.7' : major === 3 ? '3.0.1' : '5.0.12'
    assert.ok(atLeast(version, minimum), version)
  }
})

test('URI and IP parsers cannot regress to the vulnerable override versions', () => {
  for (const version of versions('fast-uri')) assert.ok(atLeast(version, '3.1.8'), version)
  for (const version of versions('ip-address')) assert.ok(atLeast(version, '10.7.2'), version)
})

