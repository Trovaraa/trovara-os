import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
test('scanner download is SHA-256 verified before extraction/execution', () => {
  const workflow = readFileSync(join(root, '.github/workflows/security.yml'), 'utf8')
  assert.match(workflow, /SHA256=[a-f0-9]{64}/)
  assert.ok(workflow.indexOf('sha256sum --check --strict') < workflow.indexOf('tar -xzf gitleaks.tar.gz'))
  assert.doesNotMatch(workflow, /\|\s*tar\s/)
  assert.match(workflow, /osv-scanner-action@[a-f0-9]{40} # v2\.6\.0/)
})

test('secret scanning detects newly introduced secrets in docs and tests', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'trovara-secret-scan-test-'))
  try {
    const files = ['docs/example.md', 'api/src/lib/secret-box.test.ts', 'app/src/lib/useInstallPrompt.ts']
    for (const file of files) {
      const target = join(fixture, file)
      mkdirSync(dirname(target), { recursive: true })
      // Disposable random canaries, not credentials for any real service.
      writeFileSync(target, 'api_key = "' + randomBytes(32).toString('hex') + '"\n')
    }
    const report = join(fixture, 'findings.json')
    let code = 0
    try {
      execFileSync(process.env.GITLEAKS_BIN || 'gitleaks', ['dir', fixture, '--config', join(root, '.gitleaks.toml'),
        '--redact', '--no-banner', '--log-level', 'error', '--report-format', 'json', '--report-path', report],
      { stdio: 'pipe' })
    } catch (error) { code = error.status }
    assert.equal(code, 1, 'scanner must fail when a secret canary is present')
    const findings = JSON.parse(readFileSync(report, 'utf8'))
    for (const file of files) assert.ok(findings.some(finding => finding.File.endsWith(file)), 'must scan ' + file)
  } finally {
    // Only this test-created directory; no repository/user files are removed.
    rmSync(fixture, { recursive: true, force: true })
  }
})
