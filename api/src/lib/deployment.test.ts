import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetDeploymentShaCacheForTests, deploymentSha } from './deployment.js'

const ENV_KEYS = [
  'DEPLOYMENT_SHA',
  'RENDER_GIT_COMMIT',
  'COMMIT_SHA',
  'GITHUB_SHA',
  'RELEASE_METADATA_PATH',
] as const

let directory = ''

describe('deploymentSha', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'trovara-release-'))
    for (const key of ENV_KEYS) delete process.env[key]
    _resetDeploymentShaCacheForTests()
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    for (const key of ENV_KEYS) delete process.env[key]
    _resetDeploymentShaCacheForTests()
  })

  it('uses an explicit deployment SHA first', () => {
    process.env.DEPLOYMENT_SHA = 'abcdef1234567890'
    writeFileSync(join(directory, 'RELEASE.json'), JSON.stringify({ sha: '1111111' }))

    expect(deploymentSha(directory)).toBe('abcdef1234567890')
  })

  it('uses immutable release metadata when the deployed archive has no Git history', () => {
    const sha = '933ecd9465622a199a0a4da86a7d1857d841aa5e'
    writeFileSync(join(directory, 'RELEASE.json'), JSON.stringify({ sha }))

    expect(deploymentSha(directory)).toBe(sha)
  })

  it('ignores malformed or untrusted release metadata', () => {
    writeFileSync(join(directory, 'RELEASE.json'), JSON.stringify({ sha: '../not-a-sha' }))

    expect(deploymentSha(directory)).toBe('unknown')
  })

  it('supports a protected release metadata path outside the working directory', () => {
    const metadata = join(directory, 'current-release.json')
    writeFileSync(metadata, JSON.stringify({ sha: '1234567abcdef' }))
    process.env.RELEASE_METADATA_PATH = metadata

    expect(deploymentSha('/unused')).toBe('1234567abcdef')
  })
})
