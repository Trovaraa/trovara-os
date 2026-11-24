// Node2Shell and the November 2026 HTTP/TLS fixes are in Node itself.
// Keep the API and workers on the tested, patched Node 24 LTS line.
export function isSupportedSecureRuntime(version: string): boolean {
  if (!/^24\.\d+\.\d+$/.test(version)) return false
  const [, minor, patch] = version.split('.').map(Number)
  return minor > 22 || (minor === 22 && patch >= 3)
}

if (!isSupportedSecureRuntime(process.versions.node)) {
  throw new Error('Trovara OS requires patched Node.js >=24.22.3 <25 (November 2026 security release). Upgrade the API and worker runtimes before starting this release.')
}
