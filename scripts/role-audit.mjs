#!/usr/bin/env node
/**
 * Deep role authorization audit against a running local API (+ optional Playwright UI).
 * Usage: node scripts/role-audit.mjs
 * Env: API_BASE (default http://127.0.0.1:3000), APP_BASE (default http://127.0.0.1:5173)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function loadEnv() {
  const raw = readFileSync(resolve(root, '.env'), 'utf8')
  const env = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

const env = loadEnv()
const API = process.env.API_BASE || 'http://127.0.0.1:3000'
const APP = process.env.APP_BASE || 'http://127.0.0.1:5173'

const ACCOUNTS = {
  owner: {
    email: env.BREAK_GLASS_EMAIL || 'owner@trovara.farm',
    password: env.BREAK_GLASS_PASSWORD || env.SEED_OWNER_PASSWORD,
  },
  supervisor: {
    email: 'supervisor1@trovara.farm',
    password: env.SEED_SUPERVISOR_PASSWORD,
  },
  field_worker: {
    email: 'worker1@trovara.farm',
    password: env.SEED_WORKER_PASSWORD,
  },
  sales: {
    email: 'sales@trovara.farm',
    password: env.SEED_SALES_PASSWORD,
  },
}

/** Expected HTTP status class: 'ok' (2xx), 'deny' (401/403), 'any' (2xx or 4xx except 5xx) */
const MATRIX = [
  // Core reads
  { method: 'GET', path: '/auth/me', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
  { method: 'GET', path: '/api/dashboard', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
  { method: 'GET', path: '/api/today', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },

  // Tasks / ops
  { method: 'GET', path: '/api/tasks', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'deny' } },
  { method: 'GET', path: '/api/tasks/pending-approvals', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'deny' } },
  { method: 'POST', path: '/api/tasks', body: { title: 'Audit probe', assigneeId: '00000000-0000-0000-0000-000000000000' }, expect: { owner: 'ok-or-4xx', supervisor: 'ok-or-4xx', field_worker: 'deny', sales: 'deny' }, note: 'assign gate; may 400 on bad assignee' },

  // Attendance
  { method: 'GET', path: '/api/attendance/today', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
  { method: 'POST', path: '/api/attendance/clock-in', body: {}, expect: { owner: 'deny', supervisor: 'deny', field_worker: 'ok-or-4xx', sales: 'deny' } },

  // Field reports
  { method: 'GET', path: '/api/field-reports', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'deny' } },

  // Inventory / counts
  { method: 'GET', path: '/api/inventory', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
  { method: 'GET', path: '/api/inventory/reconciliation-alerts', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'deny' } },
  { method: 'GET', path: '/api/inventory/shrink-alerts', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'deny' } },

  // Finance
  { method: 'GET', path: '/api/finance', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'ok' } },
  { method: 'GET', path: '/api/finance/summary', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'ok' } },
  { method: 'GET', path: '/api/billing/status', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'ok' } },
  { method: 'GET', path: '/api/reports/owner', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'ok' } },
  { method: 'GET', path: '/api/reports/digest', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'deny' } },

  // Sales / products / support
  { method: 'GET', path: '/api/sales', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
  { method: 'GET', path: '/api/products', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
  { method: 'GET', path: '/api/support', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'ok' } },

  // Marketing
  { method: 'GET', path: '/api/marketing-leads', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'ok' } },
  { method: 'GET', path: '/api/shop-customers', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'ok' } },
  { method: 'GET', path: '/api/customer-insights', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'deny' } },

  // Journal / newsletter (owner)
  { method: 'GET', path: '/api/journal', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'deny' } },
  { method: 'GET', path: '/api/newsletter', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'deny' } },

  // Users / privacy / security
  { method: 'GET', path: '/api/users', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'deny' } },
  { method: 'GET', path: '/api/privacy/retention-status', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'deny' } },
  { method: 'GET', path: '/auth/totp/status', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'deny' } },
  { method: 'GET', path: '/auth/preferences', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'deny' } },
  { method: 'GET', path: '/api/system/security-events', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'deny' } },

  // Advisory (not sales)
  { method: 'GET', path: '/api/advisory/home', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'deny' } },

  // AI
  { method: 'GET', path: '/api/ai/status', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
  { method: 'GET', path: '/api/ai/briefing', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'deny' } },

  // Events / system
  { method: 'GET', path: '/api/events', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'deny' } },
  { method: 'GET', path: '/system-status', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'deny' } },

  // Day close
  { method: 'GET', path: '/api/day-close', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'deny', sales: 'ok' } },

  // Traceability
  { method: 'GET', path: '/api/traceability', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
  { method: 'GET', path: '/api/traceability/export', expect: { owner: 'ok', supervisor: 'deny', field_worker: 'deny', sales: 'ok' } },

  // WhatsApp status
  { method: 'GET', path: '/api/whatsapp/status', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },

  // Farm patch owner-only probe (no-op body may 400)
  { method: 'PATCH', path: '/api/farm', body: {}, expect: { owner: 'ok-or-4xx', supervisor: 'deny', field_worker: 'deny', sales: 'deny' } },

  // Onboarding
  { method: 'GET', path: '/api/onboarding/status', expect: { owner: 'ok', supervisor: 'ok', field_worker: 'ok', sales: 'ok' } },
]

const UI_ROUTES = {
  owner: [
    '/dashboard', '/today', '/advisory', '/tasks', '/crops', '/livestock', '/inventory',
    '/assets', '/field-reports', '/sales', '/support', '/products', '/customer-insights',
    '/whatsapp', '/marketing-leads', '/shop-customers', '/traceability', '/events', '/ai',
    '/reports', '/journal', '/newsletter', '/finance', '/templates', '/zones', '/settings',
    '/users', '/tasks/post-approval', '/settings/security',
  ],
  supervisor: {
    allow: [
      '/dashboard', '/today', '/advisory', '/tasks', '/crops', '/livestock', '/inventory',
      '/assets', '/field-reports', '/sales', '/support', '/products', '/whatsapp',
      '/traceability', '/events', '/ai', '/templates', '/zones', '/settings',
    ],
    deny: [
      '/finance', '/users', '/reports', '/journal', '/newsletter', '/customer-insights',
      '/marketing-leads', '/shop-customers', '/tasks/post-approval', '/settings/security', '/worker',
    ],
  },
  field_worker: {
    allow: ['/today', '/advisory', '/worker', '/field-reports', '/assets', '/traceability', '/settings'],
    deny: [
      '/dashboard', '/tasks', '/finance', '/sales', '/users', '/inventory', '/crops',
      '/marketing-leads', '/ai', '/events', '/journal',
    ],
  },
  sales: {
    allow: [
      '/dashboard', '/today', '/sales', '/support', '/marketing-leads', '/shop-customers',
      '/products', '/whatsapp', '/traceability', '/finance', '/settings',
    ],
    deny: [
      '/tasks', '/inventory', '/crops', '/advisory', '/worker', '/ai', '/events',
      '/users', '/journal', '/field-reports', '/templates', '/zones',
    ],
  },
}

function matchExpect(kind, status) {
  if (kind === 'ok') return status >= 200 && status < 300
  if (kind === 'deny') return status === 401 || status === 403
  if (kind === 'ok-or-4xx') return (status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 401 && status !== 403)
  return false
}

function parseCookies(res) {
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const parts = setCookie.length
    ? setCookie.map((c) => c.split(';')[0].trim())
    : (() => {
        const raw = res.headers.get('set-cookie')
        if (!raw) return []
        return raw.split(/,(?=[^;]+?=)/).map((p) => p.split(';')[0].trim())
      })()
  const map = {}
  for (const p of parts) {
    const i = p.indexOf('=')
    if (i > 0) map[p.slice(0, i)] = p.slice(i + 1)
  }
  return {
    header: parts.filter(Boolean).join('; '),
    map,
    csrf: map.trovara_csrf || map['trovara_csrf'],
  }
}

async function login(role) {
  const acc = ACCOUNTS[role]
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: acc.email, password: acc.password }),
  })
  const body = await res.json().catch(() => ({}))
  const cookies = parseCookies(res)
  return { status: res.status, body, cookie: cookies.header, csrf: cookies.csrf, role }
}

async function apiCall(cookie, csrf, method, path, body) {
  const headers = { cookie }
  if (body) headers['content-type'] = 'application/json'
  if (csrf && method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrf
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
  return { status: res.status, json }
}

async function runApiMatrix() {
  const sessions = {}
  const loginResults = {}
  for (const role of Object.keys(ACCOUNTS)) {
    const s = await login(role)
    loginResults[role] = {
      http: s.status,
      ok: s.status === 200,
      mustChangePassword: s.body?.user?.mustChangePassword ?? s.body?.mustChangePassword,
      roleReturned: s.body?.user?.role,
      error: s.body?.error,
      hasCookie: Boolean(s.cookie),
    }
    sessions[role] = s
  }

  const results = []
  for (const row of MATRIX) {
    for (const role of Object.keys(ACCOUNTS)) {
      const session = sessions[role]
      if (!session.cookie) {
        results.push({
          role, method: row.method, path: row.path,
          expected: row.expect[role], actual: 'no-session', pass: false, status: null,
        })
        continue
      }
      const { status, json } = await apiCall(session.cookie, session.csrf, row.method, row.path, row.body)
      const expected = row.expect[role]
      const pass = matchExpect(expected, status)
      results.push({
        role, method: row.method, path: row.path, expected, status, pass,
        error: json?.error, note: row.note,
      })
    }
  }
  return { loginResults, results }
}

async function runUiMatrix() {
  const browser = await chromium.launch({ headless: true })
  const ui = { routes: [], nav: [], actions: [] }

  for (const role of Object.keys(ACCOUNTS)) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const acc = ACCOUNTS[role]

    await page.goto(`${APP}/login`, { waitUntil: 'networkidle' })
    await page.fill('input[type="email"]', acc.email)
    await page.fill('input[type="password"]', acc.password)
    await page.locator('input[type="checkbox"]').first().check()
    await page.locator('button[type="submit"]').click({ force: false })
    await page.waitForTimeout(2000)

    // Handle TOTP or password-change if present
    const urlAfter = page.url()
    if (urlAfter.includes('change-password')) {
      ui.actions.push({ role, action: 'login', pass: false, detail: 'stuck on change-password' })
      await context.close()
      continue
    }
    if (await page.locator('text=/Authenticator|TOTP|verification code/i').count()) {
      ui.actions.push({ role, action: 'login', pass: false, detail: 'TOTP challenge blocking login' })
      await context.close()
      continue
    }

    // Collect visible nav hrefs
    const navHrefs = await page.locator('nav a[href], aside a[href], a[href^="/"]').evaluateAll((els) =>
      [...new Set(els.map((e) => e.getAttribute('href')).filter((h) => h && h.startsWith('/') && !h.startsWith('//')))]
    )
    ui.nav.push({ role, hrefs: navHrefs })

    const plan = UI_ROUTES[role]
    const allow = Array.isArray(plan) ? plan : plan.allow
    const deny = Array.isArray(plan) ? [] : plan.deny

    for (const path of allow) {
      await page.goto(`${APP}${path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      const landed = new URL(page.url()).pathname
      const pass = landed === path || landed.startsWith(path + '/')
      ui.routes.push({ role, path, intent: 'allow', landed, pass })
    }
    for (const path of deny) {
      await page.goto(`${APP}${path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      const landed = new URL(page.url()).pathname
      const pass = landed !== path
      ui.routes.push({ role, path, intent: 'deny', landed, pass })
    }

    // Role-specific functional probes
    if (role === 'owner') {
      await page.goto(`${APP}/users`, { waitUntil: 'networkidle' })
      const hasUsers = await page.locator('body').innerText()
      ui.actions.push({
        role, action: 'users-page-loads',
        pass: !/sign in|login/i.test(hasUsers) && page.url().includes('/users'),
        detail: page.url(),
      })
      await page.goto(`${APP}/finance`, { waitUntil: 'networkidle' })
      ui.actions.push({
        role, action: 'finance-page-loads',
        pass: page.url().includes('/finance'),
        detail: page.url(),
      })
      await page.goto(`${APP}/sales`, { waitUntil: 'networkidle' })
      const salesText = await page.locator('body').innerText()
      ui.actions.push({
        role, action: 'sales-page-has-content',
        pass: salesText.length > 200,
        detail: `chars=${salesText.length}`,
      })
    }

    if (role === 'supervisor') {
      await page.goto(`${APP}/tasks`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'tasks-accessible', pass: page.url().includes('/tasks'), detail: page.url() })
      await page.goto(`${APP}/finance`, { waitUntil: 'networkidle' })
      ui.actions.push({
        role, action: 'finance-blocked',
        pass: !page.url().includes('/finance'),
        detail: page.url(),
      })
      // WhatsApp page visible but send may fail — open page
      await page.goto(`${APP}/whatsapp`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'whatsapp-page', pass: page.url().includes('/whatsapp'), detail: page.url() })
    }

    if (role === 'field_worker') {
      await page.goto(`${APP}/worker`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'my-tasks-page', pass: page.url().includes('/worker'), detail: page.url() })
      await page.goto(`${APP}/today`, { waitUntil: 'networkidle' })
      const todayText = await page.locator('body').innerText()
      const clockVisible = /clock.?in|clock.?out|attendance/i.test(todayText)
      ui.actions.push({ role, action: 'clock-controls-visible', pass: clockVisible, detail: clockVisible ? 'found' : 'not found in today page text' })
      await page.goto(`${APP}/sales`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'sales-blocked', pass: !page.url().includes('/sales'), detail: page.url() })
    }

    if (role === 'sales') {
      await page.goto(`${APP}/finance`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'finance-accessible', pass: page.url().includes('/finance'), detail: page.url() })
      await page.goto(`${APP}/marketing-leads`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'leads-accessible', pass: page.url().includes('/marketing-leads'), detail: page.url() })
      await page.goto(`${APP}/shop-customers`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'shop-customers-accessible', pass: page.url().includes('/shop-customers'), detail: page.url() })
      await page.goto(`${APP}/tasks`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'tasks-blocked', pass: !page.url().includes('/tasks'), detail: page.url() })
      await page.goto(`${APP}/advisory`, { waitUntil: 'networkidle' })
      ui.actions.push({ role, action: 'advisory-blocked', pass: !page.url().includes('/advisory'), detail: page.url() })

      // UI shows WhatsApp but API send is ops-only — check page loads
      await page.goto(`${APP}/whatsapp`, { waitUntil: 'networkidle' })
      const waText = await page.locator('body').innerText()
      ui.actions.push({
        role, action: 'whatsapp-ui-available',
        pass: page.url().includes('/whatsapp'),
        detail: `url=${page.url()} len=${waText.length}`,
      })
    }

    await context.close()
  }

  await browser.close()
  return ui
}

function summarize(api, ui) {
  const apiFails = api.results.filter((r) => !r.pass)
  const uiRouteFails = ui.routes.filter((r) => !r.pass)
  const uiActionFails = ui.actions.filter((a) => !a.pass)
  return {
    generatedAt: new Date().toISOString(),
    apiBase: API,
    appBase: APP,
    login: api.loginResults,
    api: {
      total: api.results.length,
      pass: api.results.filter((r) => r.pass).length,
      fail: apiFails.length,
      failures: apiFails,
      all: api.results,
    },
    ui: {
      nav: ui.nav,
      routesTotal: ui.routes.length,
      routesPass: ui.routes.filter((r) => r.pass).length,
      routesFail: uiRouteFails.length,
      routeFailures: uiRouteFails,
      actions: ui.actions,
      actionFailures: uiActionFails,
      allRoutes: ui.routes,
    },
  }
}

const api = await runApiMatrix()
console.log('API login:', JSON.stringify(api.loginResults, null, 2))
console.log(`API matrix: ${api.results.filter((r) => r.pass).length}/${api.results.length} pass`)

let ui
try {
  ui = await runUiMatrix()
} catch (err) {
  ui = { routes: [], nav: [], actions: [{ role: 'all', action: 'playwright', pass: false, detail: String(err) }] }
  console.error('UI audit error:', err)
}

const report = summarize(api, ui)
const outDir = resolve(root, 'tmp')
mkdirSync(outDir, { recursive: true })
const outPath = resolve(outDir, 'role-audit-report.json')
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log('Wrote', outPath)
console.log('API failures:', report.api.fail)
console.log('UI route failures:', report.ui.routesFail)
console.log('UI action failures:', report.ui.actionFailures.length)
