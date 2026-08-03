#!/usr/bin/env node
/**
 * Deep dual audit: Trovara OS staff roles + marketing/shop customer flows.
 * Usage (with API on :3000, OS app on :5173, marketing on :5175, optional netlify :8888):
 *   node scripts/dual-site-audit.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const osRoot = root
const mktRoot = resolve(root, '..', 'trovera')

function loadEnv(path) {
  const env = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* missing */ }
  return env
}

const osEnv = loadEnv(resolve(osRoot, '.env'))
const API = process.env.API_BASE || 'http://127.0.0.1:3000'
const OS_APP = process.env.OS_APP_BASE || 'http://127.0.0.1:5173'
const MKT = process.env.MKT_BASE || 'http://127.0.0.1:5175'
const NETLIFY = process.env.NETLIFY_BASE || 'http://127.0.0.1:8888'

const STAFF = {
  owner: { email: osEnv.BREAK_GLASS_EMAIL || 'owner@trovara.farm', password: osEnv.BREAK_GLASS_PASSWORD },
  supervisor: { email: 'supervisor1@trovara.farm', password: osEnv.SEED_SUPERVISOR_PASSWORD },
  field_worker: { email: 'worker1@trovara.farm', password: osEnv.SEED_WORKER_PASSWORD },
  sales: { email: 'sales@trovara.farm', password: osEnv.SEED_SALES_PASSWORD },
}

const findings = []
function note(severity, surface, title, detail) {
  findings.push({ severity, surface, title, detail, at: new Date().toISOString() })
}

function parseCookies(res) {
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const parts = setCookie.map((c) => c.split(';')[0].trim()).filter(Boolean)
  const map = Object.fromEntries(parts.map((p) => {
    const i = p.indexOf('=')
    return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]
  }))
  return { header: parts.join('; '), map, csrf: map.trovara_csrf }
}

async function staffLogin(role) {
  const acc = STAFF[role]
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(acc),
  })
  const body = await res.json().catch(() => ({}))
  const cookies = parseCookies(res)
  return { status: res.status, body, ...cookies, role }
}

async function api(session, method, path, body) {
  const headers = { cookie: session.header || '' }
  if (body) headers['content-type'] = 'application/json'
  if (session.csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = session.csrf
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  return { status: res.status, json }
}

function expectStatus(label, surface, got, allowed, extra = {}) {
  const ok = allowed.includes(got)
  note(ok ? 'pass' : 'high', surface, label, { got, allowed, ...extra })
  return ok
}

// ── OS API matrix (post-fix expectations) ─────────────────────────────
async function auditOsApi() {
  // clear rate limit best-effort skipped; assume fresh
  const sessions = {}
  for (const role of Object.keys(STAFF)) {
    sessions[role] = await staffLogin(role)
    expectStatus(`Login ${role}`, 'os', sessions[role].status, [200], {
      roleReturned: sessions[role].body?.user?.role,
      error: sessions[role].body?.error,
    })
  }

  const checks = [
    // Fixed gaps
    ['GET', '/api/reports/digest', { owner: 200, supervisor: 200, field_worker: 403, sales: 403 }],
    ['GET', '/api/tasks/post-approval-changes', { owner: 200, supervisor: 200, field_worker: 403, sales: 403 }],
    ['GET', '/api/traceability/export', { owner: 200, supervisor: 200, field_worker: 403, sales: 200 }],
    ['GET', '/api/finance', { owner: 200, supervisor: 403, field_worker: 403, sales: 200 }],
    ['GET', '/api/marketing-leads', { owner: 200, supervisor: 403, field_worker: 403, sales: 200 }],
    ['GET', '/api/shop-customers', { owner: 200, supervisor: 403, field_worker: 403, sales: 200 }],
    ['GET', '/api/tasks', { owner: 200, supervisor: 200, field_worker: 200, sales: 403 }],
    ['GET', '/api/advisory/home', { owner: 200, supervisor: 200, field_worker: 200, sales: 403 }],
    ['GET', '/api/inventory', { owner: 200, supervisor: 200, field_worker: 200, sales: 200 }],
    ['GET', '/api/journal', { owner: 200, supervisor: 403, field_worker: 403, sales: 403 }],
  ]

  for (const [method, path, expect] of checks) {
    for (const role of Object.keys(STAFF)) {
      const s = sessions[role]
      if (s.status !== 200) continue
      const r = await api(s, method, path)
      expectStatus(`${role} ${method} ${path}`, 'os', r.status, [expect[role]], { error: r.json?.error })
    }
  }

  // Role before zod
  const salesWa = await api(sessions.sales, 'POST', '/api/whatsapp/send', {})
  expectStatus('sales WhatsApp empty body → 403 not 400', 'os', salesWa.status, [403], { body: salesWa.json })
  const salesCount = await api(sessions.sales, 'POST', '/api/inventory/count-sessions', {})
  expectStatus('sales inventory count empty → 403', 'os', salesCount.status, [403], { body: salesCount.json })
  const workerClock = await api(sessions.field_worker, 'POST', '/api/attendance/clock-in', {})
  expectStatus('worker clock-in', 'os', workerClock.status, [200, 400, 409], { error: workerClock.json?.error })

  return sessions
}

// ── OS UI routes (Playwright) ───────────────────────────────────────────
async function auditOsUi() {
  const browser = await chromium.launch({ headless: true })
  const plans = {
    owner: {
      allow: ['/dashboard', '/reports', '/tasks/post-approval', '/finance', '/users', '/inventory'],
      deny: [],
    },
    supervisor: {
      allow: ['/dashboard', '/reports', '/tasks/post-approval', '/tasks', '/inventory'],
      deny: ['/finance', '/users', '/journal', '/marketing-leads'],
    },
    field_worker: {
      allow: ['/today', '/worker', '/inventory', '/advisory', '/field-reports'],
      deny: ['/dashboard', '/tasks', '/finance', '/sales', '/reports'],
    },
    sales: {
      allow: ['/sales', '/finance', '/marketing-leads', '/shop-customers', '/products'],
      deny: ['/tasks', '/inventory', '/advisory', '/reports', '/worker'],
    },
  }

  for (const role of Object.keys(plans)) {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const acc = STAFF[role]
    await page.goto(`${OS_APP}/login`, { waitUntil: 'networkidle' })
    await page.fill('input[type="email"]', acc.email)
    await page.fill('input[type="password"]', acc.password)
    const privacy = page.locator('input[type="checkbox"]').first()
    if (await privacy.count()) await privacy.check()
    await page.locator('button[type="submit"]').click()
    await page.waitForTimeout(2000)
    if (page.url().includes('change-password')) {
      note('high', 'os-ui', `${role} stuck on change-password`, { url: page.url() })
      await ctx.close()
      continue
    }
    if (page.url().includes('/login')) {
      note('high', 'os-ui', `${role} login failed`, { url: page.url(), body: await page.locator('body').innerText().then((t) => t.slice(0, 200)) })
      await ctx.close()
      continue
    }
    note('pass', 'os-ui', `${role} login ok`, { url: page.url() })

    for (const path of plans[role].allow) {
      await page.goto(`${OS_APP}${path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(350)
      const landed = new URL(page.url()).pathname
      const ok = landed === path || landed.startsWith(path + '/')
      note(ok ? 'pass' : 'high', 'os-ui', `${role} allow ${path}`, { landed })
    }
    for (const path of plans[role].deny) {
      await page.goto(`${OS_APP}${path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(350)
      const landed = new URL(page.url()).pathname
      const ok = landed !== path
      note(ok ? 'pass' : 'high', 'os-ui', `${role} deny ${path}`, { landed })
    }
    await ctx.close()
  }
  await browser.close()
}

// ── Marketing / shop API ────────────────────────────────────────────────
async function auditShopApi() {
  const jar = { header: '', csrf: '' }

  // session
  {
    const res = await fetch(`${API}/shop/session`, { headers: { cookie: jar.header } })
    const cookies = parseCookies(res)
    jar.header = cookies.header
    jar.csrf = cookies.csrf
    const body = await res.json()
    expectStatus('shop session', 'shop', res.status, [200], { hasCsrf: !!jar.csrf, account: body.account })
  }

  // catalog
  {
    const res = await fetch(`${API}/shop/catalog`)
    const body = await res.json()
    expectStatus('shop catalog', 'shop', res.status, [200, 503], {
      productCount: body.products?.length,
      error: body.error,
    })
    if (res.status === 200 && (!body.products || body.products.length === 0)) {
      note('medium', 'shop', 'Catalog empty — checkout cannot be fully tested', {})
    }
  }

  const stamp = Date.now()
  const email = `audit-shop-${stamp}@example.com`
  const password = 'ShopAuditPass2026!'
  const name = 'Audit Shopper'

  // register
  {
    const res = await fetch(`${API}/shop/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    })
    const body = await res.json().catch(() => ({}))
    expectStatus('shop register', 'shop', res.status, [201, 200], { error: body.error, message: body.message })
  }

  // login before verify → needsVerification
  {
    const res = await fetch(`${API}/shop/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const body = await res.json().catch(() => ({}))
    const ok = res.status === 403 && (body.needsVerification === true || /verify/i.test(body.error || ''))
    note(ok ? 'pass' : 'high', 'shop', 'unverified login blocked', { status: res.status, body })
  }

  // guest cannot order
  {
    const res = await fetch(`${API}/shop/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: jar.header,
        'X-CSRF-Token': jar.csrf || 'x',
      },
      body: JSON.stringify({ items: [], address: 'x' }),
    })
    expectStatus('guest order denied', 'shop', res.status, [401, 403], {})
  }

  // public leads
  {
    const res = await fetch(`${API}/public/leads/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Audit Lead',
        email: `lead-${stamp}@example.com`,
        subject: 'general',
        message: 'Deep audit contact probe',
        consentAccepted: true,
        consentVersion: '1.0',
      }),
    })
    const body = await res.json().catch(() => ({}))
    expectStatus('public contact lead', 'marketing-api', res.status, [200, 201], { error: body.error })
  }

  {
    const res = await fetch(`${API}/public/leads/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `wait-${stamp}@example.com`,
        productSlug: 'eggs',
        consentAccepted: true,
        consentVersion: '1.0',
      }),
    })
    const body = await res.json().catch(() => ({}))
    expectStatus('public waitlist', 'marketing-api', res.status, [200, 201], { error: body.error })
  }

  // journal public
  {
    const res = await fetch(`${API}/public/journal`)
    expectStatus('public journal', 'marketing-api', res.status, [200], {})
  }

  // newsletter subscribe
  {
    const res = await fetch(`${API}/public/newsletter/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `news-${stamp}@example.com`,
        consentAccepted: true,
        consentVersion: '1.0',
      }),
    })
    const body = await res.json().catch(() => ({}))
    expectStatus('newsletter subscribe', 'marketing-api', res.status, [200, 201], { error: body.error, body })
  }

  // Try to pull verify token from DB via API log isn't available — use SQL through docker is heavy.
  // Return registration email for UI path that may need manual verify; also try common table.
  return { email, password, name, stamp }
}

async function verifyShopCustomerViaDb(email) {
  // Use API owner to list shop customers — may include unverified
  const owner = await staffLogin('owner')
  if (owner.status !== 200) return null
  const list = await api(owner, 'GET', '/api/shop-customers')
  const rows = list.json?.customers || list.json || []
  const found = Array.isArray(rows) ? rows.find((c) => c.email === email) : null
  note(found ? 'pass' : 'medium', 'os', 'Registered shop customer visible to owner/sales', {
    found: !!found,
    listStatus: list.status,
    count: Array.isArray(rows) ? rows.length : 0,
  })
  return found
}

async function forceVerifyShopCustomer(email) {
  // Direct SQL via docker if available
  const { spawnSync } = await import('node:child_process')
  const sql = `UPDATE customer_accounts SET email_verified_at = NOW() WHERE email = '${email.replace(/'/g, "''")}';`
  const r = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'trovara', '-d', 'trovara_os', '-c', sql],
    { cwd: osRoot, encoding: 'utf8' },
  )
  note(r.status === 0 ? 'pass' : 'medium', 'shop', 'Force-verify shop customer via SQL for deep checkout test', {
    status: r.status,
    stderr: (r.stderr || '').slice(0, 200),
    stdout: (r.stdout || '').slice(0, 200),
  })
  return r.status === 0
}

async function auditShopSignedIn(creds) {
  await forceVerifyShopCustomer(creds.email)

  const res = await fetch(`${API}/shop/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  })
  const body = await res.json().catch(() => ({}))
  const cookies = parseCookies(res)
  expectStatus('verified shop login', 'shop', res.status, [200], { error: body.error })
  if (res.status !== 200) return

  const session = { header: cookies.header, csrf: cookies.csrf || body.csrfToken }

  {
    const me = await fetch(`${API}/shop/me`, { headers: { cookie: session.header } })
    const meBody = await me.json().catch(() => ({}))
    expectStatus('shop /me', 'shop', me.status, [200], { name: meBody.account?.name || meBody.name })
  }

  {
    const orders = await fetch(`${API}/shop/orders`, { headers: { cookie: session.header } })
    expectStatus('shop list orders', 'shop', orders.status, [200], {})
  }

  {
    const link = await fetch(`${API}/shop/link-code`, {
      method: 'POST',
      headers: {
        cookie: session.header,
        'content-type': 'application/json',
        'X-CSRF-Token': session.csrf,
      },
      body: '{}',
    })
    const linkBody = await link.json().catch(() => ({}))
    expectStatus('shop link-code', 'shop', link.status, [200, 201], { error: linkBody.error, code: linkBody.code })
  }

  // place order with first catalog product
  const catalog = await (await fetch(`${API}/shop/catalog`)).json()
  const product = catalog.products?.find((p) => p.priceKobo > 0) || catalog.products?.[0]
  if (!product) {
    note('medium', 'shop', 'No product to place order', {})
  } else {
    const orderRes = await fetch(`${API}/shop/orders`, {
      method: 'POST',
      headers: {
        cookie: session.header,
        'content-type': 'application/json',
        'X-CSRF-Token': session.csrf,
      },
      body: JSON.stringify({
        items: [{ productId: product.id, quantity: 1 }],
        address: 'Audit Farm Road, Abeokuta',
        phone: '2348100000999',
      }),
    })
    const orderBody = await orderRes.json().catch(() => ({}))
    expectStatus('shop place order', 'shop', orderRes.status, [200, 201], {
      error: orderBody.error,
      orderId: orderBody.order?.id || orderBody.id,
    })
  }

  // logout requires CSRF
  {
    const bad = await fetch(`${API}/shop/logout`, {
      method: 'POST',
      headers: { cookie: session.header, 'content-type': 'application/json' },
      body: '{}',
    })
    expectStatus('logout without CSRF', 'shop', bad.status, [403], {})
  }
  {
    const ok = await fetch(`${API}/shop/logout`, {
      method: 'POST',
      headers: {
        cookie: session.header,
        'content-type': 'application/json',
        'X-CSRF-Token': session.csrf,
      },
      body: '{}',
    })
    expectStatus('logout with CSRF', 'shop', ok.status, [200], {})
  }
}

// ── Marketing browser ───────────────────────────────────────────────────
async function auditMarketingUi() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const routes = [
    '/', '/about', '/products', '/shop', '/farm', '/services', '/faq', '/blog',
    '/contact', '/wholesale', '/privacy', '/terms', '/lot/trovara-farm/DOES-NOT-EXIST',
  ]

  let reachable = false
  try {
    const res = await page.goto(MKT, { waitUntil: 'domcontentloaded', timeout: 8000 })
    reachable = !!res && res.ok()
  } catch (e) {
    note('high', 'marketing-ui', 'Marketing site not reachable', { base: MKT, error: String(e) })
    await browser.close()
    return
  }

  note(reachable ? 'pass' : 'high', 'marketing-ui', 'Marketing homepage', { base: MKT })

  for (const path of routes) {
    try {
      const res = await page.goto(`${MKT}${path}`, { waitUntil: 'domcontentloaded', timeout: 12000 })
      const status = res?.status() ?? 0
      const text = await page.locator('body').innerText().catch(() => '')
      const blank = text.trim().length < 20
      note(
        status >= 200 && status < 400 && !blank ? 'pass' : 'medium',
        'marketing-ui',
        `Route ${path}`,
        { status, chars: text.length, title: await page.title() },
      )
    } catch (e) {
      note('medium', 'marketing-ui', `Route ${path} failed`, { error: String(e) })
    }
  }

  // Shop catalog via proxy
  await page.goto(`${MKT}/shop`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => null)
  await page.waitForTimeout(1500)
  const shopText = await page.locator('body').innerText().catch(() => '')
  const hasProducts = /egg|crate|₦|NGN|Add|cart|product/i.test(shopText)
  const shopBroken = /not available|failed to load|error/i.test(shopText) && !hasProducts
  note(shopBroken ? 'high' : hasProducts ? 'pass' : 'medium', 'marketing-ui', 'Shop page catalog UX', {
    hasProducts,
    snippet: shopText.slice(0, 250),
  })

  // Guest checkout should require auth
  const loginPrompt = /sign in|log in|create account|verify|register/i.test(shopText)
  note('info', 'marketing-ui', 'Shop auth copy present for guests', { loginPrompt })

  // Contact via Vite (expect fail without netlify) vs check function
  await page.goto(`${MKT}/contact`, { waitUntil: 'domcontentloaded' }).catch(() => null)
  note('info', 'marketing-ui', 'Contact page loads (form submit needs netlify functions)', {
    url: page.url(),
  })

  // Netlify functions probe
  try {
    const fn = await fetch(`${NETLIFY}/.netlify/functions/contact`, { method: 'OPTIONS' })
    note(fn.status < 500 ? 'pass' : 'medium', 'marketing-ui', 'Netlify contact function reachable', {
      status: fn.status,
      base: NETLIFY,
    })
  } catch {
    note('medium', 'marketing-ui', 'Netlify functions not running — contact/waitlist/newsletter forms will fail on plain Vite', {
      hint: 'Use npm run dev:netlify in trovera',
    })
  }

  await browser.close()
}

async function crossCheckStaffSeesLeadAndCustomer(creds) {
  const sales = await staffLogin('sales')
  if (sales.status !== 200) return
  const leads = await api(sales, 'GET', '/api/marketing-leads')
  expectStatus('sales sees marketing leads', 'cross', leads.status, [200], {
    count: leads.json?.leads?.length ?? leads.json?.length,
  })
  const customers = await api(sales, 'GET', '/api/shop-customers')
  expectStatus('sales sees shop customers', 'cross', customers.status, [200], {
    count: customers.json?.customers?.length ?? customers.json?.length,
  })
  const rows = customers.json?.customers || []
  const found = Array.isArray(rows) && rows.some((c) => c.email === creds.email)
  note(found ? 'pass' : 'medium', 'cross', 'New shop registrant appears in shop-customers for sales', {
    email: creds.email,
    found,
  })
}

// ── main ────────────────────────────────────────────────────────────────
mkdirSync(resolve(osRoot, 'tmp'), { recursive: true })

console.log('== OS API ==')
await auditOsApi()
console.log('== OS UI ==')
try {
  await auditOsUi()
} catch (e) {
  note('high', 'os-ui', 'Playwright OS UI failed', { error: String(e) })
}
console.log('== Shop API ==')
const creds = await auditShopApi()
await verifyShopCustomerViaDb(creds.email)
await auditShopSignedIn(creds)
await crossCheckStaffSeesLeadAndCustomer(creds)
console.log('== Marketing UI ==')
await auditMarketingUi()

const summary = {
  generatedAt: new Date().toISOString(),
  bases: { API, OS_APP, MKT, NETLIFY },
  counts: {
    pass: findings.filter((f) => f.severity === 'pass').length,
    info: findings.filter((f) => f.severity === 'info').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    high: findings.filter((f) => f.severity === 'high').length,
  },
  gaps: findings.filter((f) => f.severity === 'high' || f.severity === 'medium'),
  findings,
}
const out = resolve(osRoot, 'tmp/dual-site-audit.json')
writeFileSync(out, JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ counts: summary.counts, gaps: summary.gaps }, null, 2))
console.log('Wrote', out)
