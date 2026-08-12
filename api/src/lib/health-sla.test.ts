import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  healthSlaEnvEnabled,
  renderHealthSlaTelegram,
  summarizeHealthProbes,
  type HealthProbeResult,
} from './health-sla.js'

function probe(
  partial: Partial<HealthProbeResult> & Pick<HealthProbeResult, 'group' | 'name' | 'ok'>,
): HealthProbeResult {
  return {
    url: 'https://example.test',
    status: partial.ok ? 200 : 503,
    latencyMs: 12,
    detail: partial.ok ? null : 'HTTP 503',
    ...partial,
  }
}

describe('healthSlaEnvEnabled', () => {
  afterEach(() => {
    delete process.env.HEALTH_SLA_TELEGRAM_ENABLED
    delete process.env.HEALTH_SNAPSHOT_TELEGRAM_ENABLED
  })

  it('defaults to enabled', () => {
    expect(healthSlaEnvEnabled()).toBe(true)
  })

  it('respects explicit off values', () => {
    process.env.HEALTH_SLA_TELEGRAM_ENABLED = 'false'
    expect(healthSlaEnvEnabled()).toBe(false)
  })
})

describe('summarizeHealthProbes', () => {
  it('marks all-green as healthy', () => {
    const summary = summarizeHealthProbes([
      probe({ group: 'os', name: 'OS liveness', ok: true }),
      probe({ group: 'os', name: 'OS readiness', ok: true }),
      probe({ group: 'marketing', name: 'Marketing home', ok: true }),
    ])
    expect(summary).toEqual({
      okCount: 3,
      totalCount: 3,
      successRate: 100,
      status: 'healthy',
    })
  })

  it('marks partial failures as degraded', () => {
    const summary = summarizeHealthProbes([
      probe({ group: 'os', name: 'OS liveness', ok: true }),
      probe({ group: 'os', name: 'OS readiness', ok: true }),
      probe({ group: 'marketing', name: 'Marketing home', ok: false }),
    ])
    expect(summary.status).toBe('degraded')
    expect(summary.successRate).toBe(66.7)
  })

  it('marks both critical OS probes down as down', () => {
    const summary = summarizeHealthProbes([
      probe({ group: 'os', name: 'OS liveness', ok: false }),
      probe({ group: 'os', name: 'OS readiness', ok: false }),
      probe({ group: 'marketing', name: 'Marketing home', ok: true }),
    ])
    expect(summary.status).toBe('down')
  })
})

describe('renderHealthSlaTelegram', () => {
  it('renders a compact point-in-time health snapshot', () => {
    const text = renderHealthSlaTelegram({
      checkedAt: '2026-08-10T12:00:00.000Z',
      osBaseUrl: 'https://os.trovara.farm',
      marketingBaseUrl: 'https://www.trovara.farm',
      probes: [
        probe({
          group: 'os',
          name: 'OS liveness',
          ok: true,
          url: 'https://os.trovara.farm/health',
        }),
        probe({
          group: 'marketing',
          name: 'Marketing home',
          ok: false,
          url: 'https://www.trovara.farm/',
          status: 502,
          detail: 'HTTP 502',
        }),
      ],
      okCount: 1,
      totalCount: 2,
      successRate: 50,
      status: 'degraded',
    })

    expect(text).toContain('⚠️ Trovara daily health — 2026-08-10')
    expect(text).toContain('Health snapshot: 1/2 probes OK (50%) · DEGRADED')
    expect(text).toContain('✅ OS liveness')
    expect(text).toContain('❌ Marketing home')
  })
})

describe('collectHealthSlaReport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    delete process.env.HEALTH_SLA_OS_BASE_URL
    delete process.env.HEALTH_SLA_MARKETING_BASE_URL
  })

  it('probes configured OS and marketing bases', async () => {
    process.env.HEALTH_SLA_OS_BASE_URL = 'https://os.test'
    process.env.HEALTH_SLA_MARKETING_BASE_URL = 'https://www.test'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      }
      if (url.endsWith('/ready')) {
        return new Response(JSON.stringify({ status: 'ready' }), { status: 200 })
      }
      return new Response('ok', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { collectHealthSlaReport } = await import('./health-sla.js')
    const report = await collectHealthSlaReport()
    expect(report.osBaseUrl).toBe('https://os.test')
    expect(report.marketingBaseUrl).toBe('https://www.test')
    expect(report.totalCount).toBe(8)
    expect(report.status).toBe('healthy')
    expect(fetchMock).toHaveBeenCalled()
  })
})
