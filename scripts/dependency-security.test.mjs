import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
// Scoped build-tool replacement rationale: docs/dependency-maintenance-2026-10-28.md.
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'))
const entries = Object.entries(lock.packages)
const versions = name => entries.filter(([path]) => path.endsWith('/node_modules/' + name) || path === 'node_modules/' + name).map(([, pkg]) => pkg.version)
const atLeast = (version, minimum) => {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'security floor requires a stable release')
  const a = version.split('.').map(Number), b = minimum.split('.').map(Number)
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))
}

test('Rollup uses the reviewed lodash.merge alias instead of vulnerable deepmerge', async () => {
  const { createRequire } = await import('node:module')
  const require = createRequire(new URL('package.json', root))
  const resolverEntry = require.resolve('@rollup/plugin-node-resolve')
  const resolverRequire = createRequire(resolverEntry)
  const mergePackage = resolverRequire('deepmerge/package.json')
  assert.equal(mergePackage.name, 'lodash.merge')
  assert.equal(mergePackage.version, '4.6.2')
  const aliases = entries.filter(([path]) => path.endsWith('/deepmerge'))
  assert.equal(aliases.length, 1)
  assert.equal(aliases[0][1].name, 'lodash.merge')
  assert.match(aliases[0][1].resolved, /\/lodash\.merge\/-\/lodash\.merge-4\.6\.2\.tgz$/)
  // This is deliberately NOT a global drop-in replacement: the reviewed resolver
  // only deep-clones JSON-compatible defaults. Fail if upstream changes that use.
  const resolverSource = readFileSync(resolverEntry, 'utf8')
  assert.equal((resolverSource.match(/deepMerge\(/g) || []).length, 1)
  assert.match(resolverSource, /deepMerge\(\{\}, defaults\)/)
  const { DEFAULTS, nodeResolve } = require('@rollup/plugin-node-resolve')
  assert.deepEqual(DEFAULTS.extensions, ['.mjs', '.js', '.json', '.node'])
  assert.deepEqual(DEFAULTS.moduleDirectories, ['node_modules'])
  assert.ok(Object.isFrozen(DEFAULTS))
  assert.ok(Object.isFrozen(DEFAULTS.extensions))
  assert.equal(nodeResolve().name, 'node-resolve')
  const merge = resolverRequire('deepmerge')
  const original = { nested: { enabled: true }, extensions: ['.mjs', '.js'] }
  const copy = merge({}, original)
  assert.deepEqual(copy, original)
  assert.notEqual(copy.nested, original.nested)
  assert.notEqual(copy.extensions, original.extensions)
  copy.extensions.push('.test')
  assert.deepEqual(original.extensions, ['.mjs', '.js'])
})

test('the resolver merge replacement does not poison returned or global prototypes', async () => {
  const { createRequire } = await import('node:module')
  const require = createRequire(new URL('package.json', root))
  const merge = createRequire(require.resolve('@rollup/plugin-node-resolve'))('deepmerge')
  const payload = JSON.parse('{"__proto__":{"trovaraMergePoison":true},"constructor":{"prototype":{"trovaraMergePoison":true}}}')
  for (const target of [{}, Object.create(null), JSON.parse('{"__proto__":{"trovaraMergePoison":true}}')]) {
    const before = Object.getPrototypeOf(target)
    const result = merge(target, payload)
    assert.equal(Object.getPrototypeOf(result), before)
    assert.equal(result.trovaraMergePoison, undefined)
    assert.equal({}.trovaraMergePoison, undefined)
  }
})

test('Node2Shell runtime floor is pinned for builds and CI', () => {
  assert.equal(readFileSync(new URL('.nvmrc', root), 'utf8').trim(), '24.22.1')
  assert.equal(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).engines.node, '>=24.22.1 <25')
  assert.equal(lock.packages[''].engines.node, '>=24.22.1 <25')
  assert.equal(process.versions.node.split('.')[0], '24')
  assert.ok(atLeast(process.versions.node, '24.22.1'), 'Use patched Node from .nvmrc')
  assert.match(readFileSync(new URL('Dockerfile.knowledge-worker', root), 'utf8'), /^FROM node:24\.22\.1-bookworm-slim/m)
})

test('Vite and Vitest mocker include October security fixes in every installed copy', () => {
  assert.ok(versions('vite').length > 0)
  for (const version of versions('vite')) assert.ok(atLeast(version, '6.4.5'), version)
  for (const name of ['vitest', '@vitest/mocker']) {
    for (const version of versions(name)) assert.ok(atLeast(version, '4.1.12'), name + ' ' + version)
  }
})

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
  for (const version of versions('fast-uri')) assert.ok(atLeast(version, '3.1.9'), version)
  for (const version of versions('happy-dom')) assert.ok(atLeast(version, '21.0.4'), version)
  for (const version of versions('serialize-javascript')) assert.ok(atLeast(version, '7.1.3'), version)
  for (const version of versions('ip-address')) assert.ok(atLeast(version, '10.7.2'), version)
})

test('Zod validation uses the patched v4 release in every installed copy', () => {
  assert.ok(versions('zod').length > 0)
  for (const version of versions('zod')) assert.ok(atLeast(version, '4.6.6'), version)
})

test('October parser patches are retained and sprintf-js is absent', () => {
  for (const [name, minimum] of [['shell-quote', '1.11.0'], ['source-map-js', '1.2.2'], ['postcss-selector-parser', '7.1.6']]) {
    assert.ok(versions(name).length > 0)
    for (const version of versions(name)) assert.ok(atLeast(version, minimum), `${name}@${version}`)
  }
  assert.deepEqual(versions('sprintf-js'), [])
  for (const version of versions('argparse')) assert.ok(atLeast(version, '2.0.1'))
})

test('Mammoth library and legacy CLI remain compatible with argparse 2', async () => {
  const { default: JSZip } = await import('jszip')
  const { default: mammoth } = await import('mammoth')
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic farm document</w:t></w:r></w:p></w:body></w:document>')
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  assert.match((await mammoth.convertToHtml({ buffer })).value, /<p>Synthetic farm document<\/p>/)
  const dir = await mkdtemp(join(tmpdir(), 'trovara-mammoth-test-'))
  try {
    const input = join(dir, 'synthetic.docx')
    await writeFile(input, buffer)
    const cli = require.resolve('mammoth/bin/mammoth')
    assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /output-format/)
    assert.match(execFileSync(process.execPath, [cli, input, '--output-format', 'html'], { encoding: 'utf8' }), /Synthetic farm document/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

