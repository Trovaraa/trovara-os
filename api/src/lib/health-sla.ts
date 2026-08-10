import { publicAppBaseUrl, publicMarketingUrlOrDefault } from './public-app-url.js'

export type HealthProbeGroup = 'os' | 'marketing'

export type HealthProbeResult = {
  group: HealthProbeGroup
  name: string
  url: string
  ok: boolean
  status: number | null
  latencyMs: number
  detail: string | null
}

export type HealthSlaReport = {
  checkedAt: string
  osBaseUrl: string
  marketingBaseUrl: string
  probes: HealthProbeResult[]
  okCount: number
  totalCount: number
  successRate: number
  status: 'healthy' | 'degraded' | 'down'
}

type ProbeSpec = {
  group: HealthProbeGroup
  name: string
  path: string
  /** When set, response must be this HTTP status (default: 200–399). */
  expectStatus?: number
  validate?: (response: Response, bodyText: string) => string | null
}

function timeoutMs(): number {
  const raw = Number.parseInt(process.env.HEALTH_SLA_TIMEOUT_MS?.trim() || '8000', 10)
  return Number.isFinite(raw) && raw >= 1000 ? raw : 8000
}

export function healthSlaEnvEnabled(): boolean {
  const raw = process.env.HEALTH_SLA_TELEGRAM_ENABLED?.trim().toLowerCase()
  if (!raw) return true
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no'
}

export function healthSlaOsBaseUrl(): string {
  return (process.env.HEALTH_SLA_OS_BASE_URL?.trim() || publicAppBaseUrl()).replace(/\/+$/, '')
}

export function healthSlaMarketingBaseUrl(): string {
  return (
    process.env.HEALTH_SLA_MARKETING_BASE_URL?.trim() || publicMarketingUrlOrDefault()
  ).replace(/\/+$/, '')
}

function probeSpecs(): ProbeSpec[] {
  return [
    {
      group: 'os',
      name: 'OS liveness',
      path: '/health',
      expectStatus: 200,
      validate: (_response, bodyText) => {
        try {
          const body = JSON.parse(bodyText) as { status?: string }
          return body.status === 'ok' ? null : 'unexpected health payload'
        } catch {
          return 'health response was not JSON'
        }
      },
    },
    {
      group: 'os',
      name: 'OS readiness',
      path: '/ready',
      expectStatus: 200,
    },
    {
      group: 'os',
      name: 'Public moments API',
      path: '/public/moments',
    },
    {
      group: 'os',
      name: 'Public careers API',
      path: '/public/careers',
    },
    {
      group: 'marketing',
      name: 'Marketing home',
      path: '/',
    },
    {
      group: 'marketing',
      name: 'Moments page',
      path: '/moments',
    },
    {
      group: 'marketing',
      name: 'Careers page',
      path: '/careers',
    },
    {
      group: 'marketing',
      name: 'Privacy page',
      path: '/privacy',
    },
  ]
}

async function runProbe(baseUrl: string, spec: ProbeSpec): Promise<HealthProbeResult> {
  const url = `${baseUrl}${spec.path.startsWith('/') ? spec.path : `/${spec.path}`}`
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/html;q=0.9,*/*;q=0.8' },
    })
    const latencyMs = Date.now() - started
    const bodyText = await response.text().catch(() => '')
    const statusOk =
      spec.expectStatus !== undefined
        ? response.status === spec.expectStatus
        : response.status >= 200 && response.status < 400
    const validationError = statusOk && spec.validate ? spec.validate(response, bodyText) : null
    const ok = statusOk && !validationError
    return {
      group: spec.group,
      name: spec.name,
      url,
      ok,
      status: response.status,
      latencyMs,
      detail: ok ? null : validationError || `HTTP ${response.status}`,
    }
  } catch (error) {
    const latencyMs = Date.now() - started
    const detail =
      error instanceof Error && error.name === 'AbortError'
        ? `timeout after ${timeoutMs()}ms`
        : error instanceof Error
          ? error.message
          : 'request failed'
    return {
      group: spec.group,
      name: spec.name,
      url,
      ok: false,
      status: null,
      latencyMs,
      detail,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function summarizeHealthProbes(probes: HealthProbeResult[]): Pick<
  HealthSlaReport,
  'okCount' | 'totalCount' | 'successRate' | 'status'
> {
  const totalCount = probes.length
  const okCount = probes.filter((probe) => probe.ok).length
  const successRate = totalCount === 0 ? 0 : Math.round((okCount / totalCount) * 1000) / 10
  const osCritical = probes.filter((probe) => probe.group === 'os' && (probe.name.includes('liveness') || probe.name.includes('readiness')))
  const osCriticalDown = osCritical.length > 0 && osCritical.every((probe) => !probe.ok)
  const status = osCriticalDown ? 'down' : okCount === totalCount ? 'healthy' : 'degraded'
  return { okCount, totalCount, successRate, status }
}

export async function collectHealthSlaReport(): Promise<HealthSlaReport> {
  const osBaseUrl = healthSlaOsBaseUrl()
  const marketingBaseUrl = healthSlaMarketingBaseUrl()
  const probes: HealthProbeResult[] = []
  for (const spec of probeSpecs()) {
    const base = spec.group === 'os' ? osBaseUrl : marketingBaseUrl
    probes.push(await runProbe(base, spec))
  }
  const summary = summarizeHealthProbes(probes)
  return {
    checkedAt: new Date().toISOString(),
    osBaseUrl,
    marketingBaseUrl,
    probes,
    ...summary,
  }
}

function statusEmoji(status: HealthSlaReport['status']): string {
  if (status === 'healthy') return '✅'
  if (status === 'degraded') return '⚠️'
  return '🚨'
}

function probeLine(probe: HealthProbeResult): string {
  const mark = probe.ok ? '✅' : '❌'
  const status = probe.status === null ? '—' : String(probe.status)
  const detail = probe.ok ? `${probe.latencyMs}ms` : `${probe.detail ?? 'failed'} (${probe.latencyMs}ms)`
  return `${mark} ${probe.name} · ${status} · ${detail}`
}

/** Compact Telegram body for the daily health/SLA report. */
export function renderHealthSlaTelegram(report: HealthSlaReport): string {
  const day = report.checkedAt.slice(0, 10)
  const osLines = report.probes.filter((probe) => probe.group === 'os').map(probeLine)
  const marketingLines = report.probes.filter((probe) => probe.group === 'marketing').map(probeLine)
  return [
    `${statusEmoji(report.status)} Trovara daily health — ${day}`,
    `SLA: ${report.okCount}/${report.totalCount} probes OK (${report.successRate}%) · ${report.status.toUpperCase()}`,
    '',
    `OS (${report.osBaseUrl})`,
    ...osLines,
    '',
    `Marketing (${report.marketingBaseUrl})`,
    ...marketingLines,
  ].join('\n')
}
