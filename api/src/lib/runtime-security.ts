// Node2Shell (CVE-2026-111497) is in Node, not an npm dependency.
// Keep the API and workers on the tested, patched Node 24 LTS line.
export function isSupportedSecureRuntime(version: string): boolean {
  if (!/^24\.\d+\.\d+$/.test(version)) return false
  const [, minor, patch] = version.split('.').map(Number)
  return minor > 22 || (minor === 22 && patch >= 1)
}

if (!isSupportedSecureRuntime(process.versions.node)) {
  throw new Error('Trovara OS requires patched Node.js >=24.22.1 <25 (CVE-2026-111497). Upgrade the API and worker runtimes before starting this release.')
}
