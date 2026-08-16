import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let cachedSha: string | undefined

type ReleaseMetadata = {
  sha?: unknown
}

function normalizedSha(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const sha = value.trim()
  return /^[a-f0-9]{7,40}$/i.test(sha) ? sha : null
}

function shaFromReleaseFile(rootDir: string): string | null {
  const configured = process.env.RELEASE_METADATA_PATH?.trim()
  const path = configured || resolve(rootDir, 'RELEASE.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReleaseMetadata
    return normalizedSha(parsed.sha)
  } catch {
    return null
  }
}

export function deploymentSha(rootDir?: string): string {
  if (cachedSha) return cachedSha
  const fromEnv = normalizedSha(
    process.env.DEPLOYMENT_SHA?.trim() ||
    process.env.RENDER_GIT_COMMIT?.trim() ||
    process.env.COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim(),
  )
  if (fromEnv) {
    cachedSha = fromEnv
    return cachedSha
  }

  // Production is deployed from a Git archive and deliberately excludes the
  // remote .git directory. RELEASE.json is therefore the authoritative source;
  // reading Git first can report a stale commit left by an old server clone.
  const releaseSha = shaFromReleaseFile(rootDir ?? process.cwd())
  if (releaseSha) {
    cachedSha = releaseSha
    return cachedSha
  }

  try {
    cachedSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      timeout: 2_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    cachedSha = 'unknown'
  }
  return cachedSha
}

/** Test helper: deployment identity is intentionally cached for each process. */
export function _resetDeploymentShaCacheForTests(): void {
  cachedSha = undefined
}
