import { execFileSync } from 'node:child_process'

let cachedSha: string | undefined

export function deploymentSha(rootDir?: string): string {
  if (cachedSha) return cachedSha
  const fromEnv =
    process.env.DEPLOYMENT_SHA?.trim() ||
    process.env.RENDER_GIT_COMMIT?.trim() ||
    process.env.COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim()
  if (fromEnv) {
    cachedSha = fromEnv.slice(0, 40)
    return cachedSha
  }
  try {
    cachedSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      timeout: 2_000,
      encoding: 'utf8',
    }).trim()
  } catch {
    cachedSha = 'unknown'
  }
  return cachedSha
}
