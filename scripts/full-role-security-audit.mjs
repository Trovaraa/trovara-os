#!/usr/bin/env node
/**
 * Deep dual-site role + security audit (OS staff + marketing/shop).
 *
 * Prerequisites: API :3000, OS Vite :5173, marketing Vite :5175.
 *   nvm use 22 && node scripts/full-role-security-audit.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadEnv(path) {
  const env = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* */ }
  return env
}

const osEnv = loadEnv(resolve(root, '.env'))
const API = process.env.API_BASE || 'http://127.0.0.1:3000'
const OS_APP = process.env.OS_APP_BASE || 'http://127.0.0.1:5173'
const MKT = process.env.MKT_BASE || 'http://127.0.0.1:5175'

const STAFF = {
  owner: {
    email: osEnv.BREAK_GLASS_EMAIL || 'owner@trovara.farm',
    password: osEnv.BREAK_GLASS_PASSWORD,
  },
  supervisor: {
    email: 'supervisor1@trovara.farm',
    password: osEnv.SEED_SUPERVISOR_PASSWORD,
  },
  field_worker: {
    email: 'worker1@trovara.farm',
    password: osEnv.SEED_WORKER_PASSWORD,
  },
  sales: {
    email: 'sales@trovara.farm',
    password: osEnv.SEED_SALES_PASSWORD,
  },
}

const findings = []
function note(severity, surface, title, detail = {}) {
  findings.push({ severity, surface, title, detail, at: new Date().toISOString() })
}

function parseCookies(res) {
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const parts = setCookie.map((c) => c.split(';')[0].trim()).filter(Boolean)
  const map = Object.fromEntries(
    parts.map((p) => {
      const i = p.indexOf('=')
      return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]
    }),
  )
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
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session.csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = session.csrf
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 400) }
  }
  return { status: res.status, json }
}

function expectStatus(label, surface, got, allowed, extra = {}) {
  const ok = allowed.includes(got)
  note(ok ? 'pass' : 'high', surface, label, { got, allowed, ...extra })
  return ok
}

function expectDenied(label, surface, got, extra = {}) {
  const ok = got === 403 || got === 401
  note(ok ? 'pass' : 'high', surface, label, { got, want: '401|403', ...extra })
  return ok
}

async function ensureStaffActive() {
  const sql = `UPDATE users SET active = true, must_change_password = false
    WHERE email IN ('owner@trovara.farm','supervisor1@trovara.farm','worker1@trovara.farm','sales@trovara.farm');`
  spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'trovara', '-d', 'trovara_os', '-c', sql],
    { cwd: root, encoding: 'utf8' },
  )
}

// ── Expanded OS API matrix ──────────────────────────────────────────────
async function auditOsApi() {
  const sessions = {}
  for (const role of Object.keys(STAFF)) {
    if (!STAFF[role].password) {
      note('high', 'os', `Missing password for ${role}`, {})
      continue
    }
    sessions[role] = await staffLogin(role)
    expectStatus(`Login ${role}`, 'os', sessions[role].status, [200], {
      roleReturned: sessions[role].body?.user?.role,
      error: sessions[role].body?.error,
      mustChange: sessions[role].body?.user?.mustChangePassword,
    })
  }

  const getMatrix = [
    ['GET', '/api/today', { owner: 200, supervisor: 200, field_worker: 200, sales: 200 }],
    ['GET', '/api/tasks', { owner: 200, supervisor: 200, field_worker: 200, sales: 403 }],
    ['GET', '/api/tasks/post-approval-changes', { owner: 200, supervisor: 200, field_worker: 403, sales: 403 }],
    ['GET', '/api/reports/digest', { owner: 200, supervisor: 200, field_worker: 403, sales: 403 }],
    ['GET', '/api/finance', { owner: 200, supervisor: 403, field_worker: 403, sales: 200 }],
    ['GET', '/api/inventory', { owner: 200, supervisor: 200, field_worker: 200, sales: 200 }],
    ['GET', '/api/products', { owner: 200, supervisor: 200, field_worker: 200, sales: 200 }],
    ['GET', '/api/sales', { owner: 200, supervisor: 200, field_worker: 200, sales: 200 }],
    ['GET', '/api/traceability', { owner: 200, supervisor: 200, field_worker: 200, sales: 200 }],
    ['GET', '/api/traceability/export', { owner: 200, supervisor: 200, field_worker: 403, sales: 200 }],
    ['GET', '/api/journal', { owner: 200, supervisor: 403, field_worker: 403, sales: 403 }],
    ['GET', '/api/users', { owner: 200, supervisor: 200, field_worker: 403, sales: 403 }],
    ['GET', '/api/marketing-leads', { owner: 200, supervisor: 403, field_worker: 403, sales: 200 }],
    ['GET', '/api/shop-customers', { owner: 200, supervisor: 403, field_worker: 403, sales: 200 }],
    ['GET', '/api/advisory/home', { owner: 200, supervisor: 200, field_worker: 200, sales: 403 }],
    ['GET', '/api/field-reports', { owner: 200, supervisor: 200, field_worker: 200, sales: 403 }],
    ['GET', '/api/zones', { owner: 200, supervisor: 200, field_worker: 200, sales: 403 }],
    ['GET', '/api/events', { owner: 200, supervisor: 200, field_worker: 403, sales: 403 }],
    ['GET', '/api/system/security-events', { owner: 200, supervisor: 403, field_worker: 403, sales: 403 }],
    ['GET', '/api/newsletter', { owner: 200, supervisor: 403, field_worker: 403, sales: 403 }],
    ['GET', '/api/customer-insights', { owner: 200, supervisor: 403, field_worker: 403, sales: 403 }],
    ['GET', '/api/exports/farm.json', { owner: 200, supervisor: 403, field_worker: 403, sales: 200 }],
    ['GET', '/api/support', { owner: 200, supervisor: 200, field_worker: 403, sales: 200 }],
    ['GET', '/api/ai/status', { owner: 200, supervisor: 200, field_worker: 403, sales: 403 }],
  ]

  for (const [method, path, expect] of getMatrix) {
    for (const role of Object.keys(STAFF)) {
      const s = sessions[role]
      if (!s || s.status !== 200) continue
      const r = await api(s, method, path)
      expectStatus(`${role} ${method} ${path}`, 'os-api', r.status, [expect[role]], {
        error: r.json?.error,
      })
    }
  }

  // Dangerous mutations: non-owners must be denied
  const ownerOnlyMutations = [
    ['POST', '/api/onboarding/reset-demo', {}],
    ['POST', '/auth/registration-tokens', { role: 'field_worker', maxUses: 1 }],
    ['DELETE', '/api/journal/00000000-0000-4000-8000-000000000001', undefined],
    ['GET', '/api/system/security-events', undefined], // already in matrix; keep for mutations list skip
  ]

  for (const role of ['supervisor', 'field_worker', 'sales']) {
    const s = sessions[role]
    if (!s || s.status !== 200) continue
    const reset = await api(s, 'POST', '/api/onboarding/reset-demo', {})
    expectDenied(`${role} cannot reset-demo`, 'security', reset.status, { body: reset.json })

    const tok = await api(s, 'POST', '/auth/registration-tokens', {
      role: 'field_worker',
      maxUses: 1,
    })
    expectDenied(`${role} cannot create registration tokens`, 'security', tok.status, {
      body: tok.json,
    })

    const priv = await api(s, 'POST', '/api/privacy/anonymize-user/00000000-0000-4000-8000-000000000099', {})
    expectDenied(`${role} cannot anonymize users`, 'security', priv.status, { body: priv.json })
  }

  // Role-before-Zod
  {
    const salesWa = await api(sessions.sales, 'POST', '/api/whatsapp/send', {})
    expectStatus('sales WhatsApp empty → 403 not 400', 'security', salesWa.status, [403], {
      body: salesWa.json,
    })
    const salesCount = await api(sessions.sales, 'POST', '/api/inventory/count-sessions', {})
    expectStatus('sales inventory count empty → 403', 'security', salesCount.status, [403], {
      body: salesCount.json,
    })
    const workerUsers = await api(sessions.field_worker, 'POST', '/api/users', {
      email: 'x@y.com',
      name: 'X',
      role: 'owner',
      password: 'Password123!',
    })
    expectDenied('worker cannot create users', 'security', workerUsers.status, {
      body: workerUsers.json,
    })
  }

  // Functional mutations
  {
    const s = sessions.field_worker
    if (s?.status === 200) {
      const clock = await api(s, 'POST', '/api/attendance/clock-in', {})
      note(
        [200, 400, 409].includes(clock.status) ? 'pass' : 'high',
        'os-api',
        'worker clock-in',
        { status: clock.status, error: clock.json?.error },
      )
      const count = await api(s, 'POST', '/api/inventory/count-sessions', {
        locationText: 'Audit cold room',
        lines: [],
      })
      note(
        [200, 201, 400].includes(count.status) ? 'pass' : 'high',
        'os-api',
        'worker can submit count session (or validation)',
        { status: count.status, error: count.json?.error },
      )
    }
  }

  {
    const s = sessions.sales
    if (s?.status === 200) {
      const products = await api(s, 'GET', '/api/products')
      const productId =
        products.json?.products?.[0]?.id || products.json?.[0]?.id || null
      const create = await api(s, 'POST', '/api/sales', {
        customerName: 'Deep Audit Buyer',
        items: productId ? [{ productId, quantity: 1 }] : [],
      })
      note(
        create.status < 300 || create.status === 400 ? 'pass' : 'high',
        'os-api',
        'sales create order',
        { status: create.status, error: create.json?.error, productId },
      )
      const list = await api(s, 'GET', '/api/sales')
      const orderId = list.json?.orders?.[0]?.id || list.json?.[0]?.id
      if (orderId) {
        const del = await api(s, 'DELETE', `/api/sales/${orderId}`)
        note(
          del.status === 403 ? 'pass' : 'medium',
          'security',
          'sales cannot delete orders (ops-only)',
          { status: del.status, error: del.json?.error },
        )
      }
      const finDel = await api(s, 'DELETE', '/api/finance/00000000-0000-4000-8000-000000000001')
      note(
        [403, 404].includes(finDel.status) ? 'pass' : finDel.status === 200 ? 'medium' : 'info',
        'security',
        'sales finance DELETE (allowed by RBAC if exists — confirm intentional)',
        { status: finDel.status, error: finDel.json?.error },
      )
    }
  }

  {
    const s = sessions.supervisor
    if (s?.status === 200) {
      const tasks = await api(s, 'GET', '/api/tasks')
      note(tasks.status === 200 ? 'pass' : 'high', 'os-api', 'supervisor lists tasks', {
        status: tasks.status,
        count: tasks.json?.tasks?.length ?? tasks.json?.length,
      })
      const fin = await api(s, 'GET', '/api/finance')
      expectDenied('supervisor cannot access finance', 'os-api', fin.status)
      const journal = await api(s, 'POST', '/api/journal', {
        title: 'Audit',
        body: 'x',
        status: 'draft',
      })
      expectDenied('supervisor cannot write journal', 'os-api', journal.status, {
        body: journal.json,
      })
    }
  }

  {
    const s = sessions.owner
    if (s?.status === 200) {
      const sec = await api(s, 'GET', '/api/system/security-events')
      expectStatus('owner security-events', 'os-api', sec.status, [200])
      const events = sec.json?.events || []
      const withLoc = events.filter(
        (e) => e.metadata?.country || e.metadata?.region,
      ).length
      const withIp = events.filter((e) => e.metadata?.ip).length
      note(
        withIp === 0 || withLoc > 0 ? 'pass' : 'medium',
        'os-api',
        'security events include IP location enrichment',
        { events: events.length, withIp, withLoc, sample: events[0]?.metadata },
      )
      const csrfMissing = await fetch(`${API}/api/tasks`, {
        method: 'POST',
        headers: {
          cookie: s.header,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'csrf-probe' }),
      })
      expectStatus('staff mutation without CSRF → 403', 'security', csrfMissing.status, [403])
    }
  }

  return sessions
}

// ── OS UI ───────────────────────────────────────────────────────────────
async function auditOsUi() {
  const browser = await chromium.launch({ headless: true })
  const plans = {
    owner: {
      allow: [
        '/dashboard',
        '/reports',
        '/tasks/post-approval',
        '/finance',
        '/users',
        '/inventory',
        '/journal',
        '/settings/security',
      ],
      deny: [],
    },
    supervisor: {
      allow: ['/dashboard', '/reports', '/tasks/post-approval', '/tasks', '/inventory', '/today'],
      deny: ['/finance', '/users', '/journal', '/marketing-leads', '/settings/security'],
    },
    field_worker: {
      allow: ['/today', '/worker', '/inventory', '/advisory', '/field-reports'],
      deny: ['/dashboard', '/tasks', '/finance', '/sales', '/reports', '/users', '/journal'],
    },
    sales: {
      allow: [
        '/sales',
        '/finance',
        '/marketing-leads',
        '/shop-customers',
        '/products',
        '/today',
      ],
      deny: ['/tasks', '/inventory', '/advisory', '/reports', '/worker', '/users', '/journal'],
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
    await page.waitForTimeout(2500)
    if (page.url().includes('change-password')) {
      note('high', 'os-ui', `${role} stuck on change-password`, { url: page.url() })
      await ctx.close()
      continue
    }
    if (page.url().includes('/login')) {
      note('high', 'os-ui', `${role} UI login failed`, {
        url: page.url(),
        body: (await page.locator('body').innerText()).slice(0, 220),
      })
      await ctx.close()
      continue
    }
    note('pass', 'os-ui', `${role} UI login ok`, { url: page.url() })

    for (const path of plans[role].allow) {
      await page.goto(`${OS_APP}${path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      const landed = new URL(page.url()).pathname
      const ok = landed === path || landed.startsWith(`${path}/`)
      const body = await page.locator('body').innerText().catch(() => '')
      const errorish = /failed to load|forbidden|not authorized/i.test(body)
      note(ok && !errorish ? 'pass' : 'high', 'os-ui', `${role} allow ${path}`, {
        landed,
        errorish,
        snippet: body.slice(0, 160),
      })
    }
    for (const path of plans[role].deny) {
      await page.goto(`${OS_APP}${path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      const landed = new URL(page.url()).pathname
      note(landed !== path ? 'pass' : 'high', 'os-ui', `${role} deny ${path}`, { landed })
    }

    // Nav smoke: inventory actions visible for worker
    if (role === 'field_worker') {
      await page.goto(`${OS_APP}/inventory`, { waitUntil: 'networkidle' })
      const text = await page.locator('body').innerText()
      note(
        /count|stock|inventory/i.test(text) ? 'pass' : 'medium',
        'os-ui',
        'worker inventory page has useful content',
        { snippet: text.slice(0, 200) },
      )
    }
    if (role === 'supervisor') {
      await page.goto(`${OS_APP}/reports`, { waitUntil: 'networkidle' })
      const text = await page.locator('body').innerText()
      note(
        /report|digest|exception|shrink/i.test(text) && !/forbidden/i.test(text)
          ? 'pass'
          : 'high',
        'os-ui',
        'supervisor reports page renders ops data',
        { snippet: text.slice(0, 220) },
      )
    }
    await ctx.close()
  }
  await browser.close()
}

// ── Shop + public marketing API ─────────────────────────────────────────
async function auditShopAndPublic() {
  const stamp = Date.now()
  const jar = { header: '', csrf: '' }

  {
    const res = await fetch(`${API}/shop/session`)
    const cookies = parseCookies(res)
    jar.header = cookies.header
    jar.csrf = cookies.csrf
    expectStatus('shop session', 'shop', res.status, [200], { hasCsrf: !!jar.csrf })
  }

  let catalogProducts = []
  {
    const res = await fetch(`${API}/shop/catalog`)
    const body = await res.json().catch(() => ({}))
    catalogProducts = body.products || []
    expectStatus('shop catalog', 'shop', res.status, [200], {
      productCount: catalogProducts.length,
    })
    const audActive = catalogProducts.filter((p) => String(p.sku || '').startsWith('AUD-'))
    note(
      audActive.length === 0 ? 'pass' : 'medium',
      'shop',
      'No leftover AUD-* audit SKUs in active catalog',
      { count: audActive.length, skus: audActive.map((p) => p.sku) },
    )
  }

  // Guest order → 401 (not 400)
  {
    const empty = await fetch(`${API}/shop/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expectStatus('guest empty order → 401', 'security', empty.status, [401], {
      body: await empty.json().catch(() => ({})),
    })
    const validish = await fetch(`${API}/shop/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ productId: '00000000-0000-4000-8000-000000000001', quantity: 1 }],
        address: 'Somewhere long enough',
      }),
    })
    expectStatus('guest valid-shape order → 401', 'security', validish.status, [401])
  }

  const email = `deep-audit-${stamp}@example.com`
  const password = 'DeepAuditPass2026!'
  {
    const res = await fetch(`${API}/shop/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Deep Audit Shopper' }),
    })
    const body = await res.json().catch(() => ({}))
    expectStatus('shop register (non-prod keeps account)', 'shop', res.status, [201, 200], {
      error: body.error,
      message: body.message,
    })
  }

  {
    const res = await fetch(`${API}/shop/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const body = await res.json().catch(() => ({}))
    const ok =
      res.status === 403 &&
      (body.needsVerification === true || /verify/i.test(body.error || ''))
    note(ok ? 'pass' : 'high', 'security', 'unverified shop login blocked', {
      status: res.status,
      body,
    })
  }

  // Anti-enumeration-ish: register again same email → 201
  {
    const res = await fetch(`${API}/shop/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Deep Audit Shopper' }),
    })
    expectStatus('duplicate register still 201 (anti-enum)', 'security', res.status, [201, 200])
  }

  // Public leads (correct consent field)
  {
    const res = await fetch(`${API}/public/leads/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Deep Audit Lead',
        email: `lead-${stamp}@example.com`,
        subject: 'general',
        message: 'Deep audit contact message long enough',
        consent: true,
      }),
    })
    const body = await res.json().catch(() => ({}))
    expectStatus('public contact lead', 'marketing-api', res.status, [202, 200, 201], {
      error: body.error,
      body,
    })
  }
  {
    const res = await fetch(`${API}/public/leads/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Wait Audit',
        email: `wait-${stamp}@example.com`,
        product: 'eggs',
        contact: 'email',
        consent: true,
      }),
    })
    const body = await res.json().catch(() => ({}))
    expectStatus('public waitlist', 'marketing-api', res.status, [202, 200, 201], {
      error: body.error,
      body,
    })
  }
  {
    const res = await fetch(`${API}/public/newsletter/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'News Audit',
        email: `news-${stamp}@example.com`,
        consent: true,
      }),
    })
    const body = await res.json().catch(() => ({}))
    expectStatus('newsletter subscribe', 'marketing-api', res.status, [202, 200, 201], {
      error: body.error,
      body,
    })
  }
  {
    const res = await fetch(`${API}/public/journal`)
    expectStatus('public journal', 'marketing-api', res.status, [200])
  }

  // Force verify + checkout
  const sql = `UPDATE customer_accounts SET email_verified_at = NOW() WHERE email = '${email.replace(/'/g, "''")}';`
  const sqlRes = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'trovara', '-d', 'trovara_os', '-c', sql],
    { cwd: root, encoding: 'utf8' },
  )
  note(sqlRes.status === 0 ? 'pass' : 'medium', 'shop', 'Force-verify customer for checkout probe', {
    status: sqlRes.status,
    stderr: (sqlRes.stderr || '').slice(0, 160),
  })

  const login = await fetch(`${API}/shop/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const loginBody = await login.json().catch(() => ({}))
  const cookies = parseCookies(login)
  expectStatus('verified shop login', 'shop', login.status, [200], { error: loginBody.error })
  if (login.status !== 200) return { email }

  const session = {
    header: cookies.header,
    csrf: cookies.csrf || loginBody.csrfToken,
  }

  {
    const me = await fetch(`${API}/shop/me`, { headers: { cookie: session.header } })
    expectStatus('shop /me', 'shop', me.status, [200])
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
    expectStatus('shop link-code', 'shop', link.status, [200, 201], {
      body: await link.json().catch(() => ({})),
    })
  }

  const product = catalogProducts.find((p) => p.priceKobo > 0) || catalogProducts[0]
  if (product) {
    const orderRes = await fetch(`${API}/shop/orders`, {
      method: 'POST',
      headers: {
        cookie: session.header,
        'content-type': 'application/json',
        'X-CSRF-Token': session.csrf,
      },
      body: JSON.stringify({
        items: [{ productId: product.id, quantity: 1 }],
        address: 'Deep Audit Farm Road, Abeokuta',
        phone: '2348100000888',
      }),
    })
    const orderBody = await orderRes.json().catch(() => ({}))
    expectStatus('shop place order', 'shop', orderRes.status, [200, 201], {
      error: orderBody.error,
      id: orderBody.order?.id || orderBody.id,
    })
  } else {
    note('medium', 'shop', 'No catalog product for order probe', {})
  }

  // CSRF on logout
  {
    const bad = await fetch(`${API}/shop/logout`, {
      method: 'POST',
      headers: { cookie: session.header, 'content-type': 'application/json' },
      body: '{}',
    })
    expectStatus('shop logout without CSRF → 403', 'security', bad.status, [403])
  }

  // Cross: sales sees customer + leads
  const sales = await staffLogin('sales')
  if (sales.status === 200) {
    const customers = await api(sales, 'GET', '/api/shop-customers')
    const rows = customers.json?.customers || []
    const found = Array.isArray(rows) && rows.some((c) => c.email === email)
    note(found ? 'pass' : 'medium', 'cross', 'Sales sees new shop customer', {
      found,
      status: customers.status,
      count: rows.length,
    })
    const leads = await api(sales, 'GET', '/api/marketing-leads')
    expectStatus('sales marketing-leads', 'cross', leads.status, [200], {
      count: leads.json?.leads?.length ?? leads.json?.length,
    })
  }

  // Worker must not see shop customers
  const worker = await staffLogin('field_worker')
  if (worker.status === 200) {
    const denied = await api(worker, 'GET', '/api/shop-customers')
    expectDenied('worker denied shop-customers', 'security', denied.status)
  }

  return { email }
}

// ── Marketing UI + Vite functions ───────────────────────────────────────
async function auditMarketingUi() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const routes = [
    '/',
    '/about',
    '/products',
    '/shop',
    '/farm',
    '/services',
    '/faq',
    '/blog',
    '/contact',
    '/wholesale',
    '/privacy',
    '/terms',
    '/newsletter',
  ]

  try {
    const res = await page.goto(MKT, { waitUntil: 'domcontentloaded', timeout: 10000 })
    note(res?.ok() ? 'pass' : 'high', 'marketing-ui', 'Marketing homepage', {
      status: res?.status(),
    })
  } catch (e) {
    note('high', 'marketing-ui', 'Marketing site unreachable', { base: MKT, error: String(e) })
    await browser.close()
    return
  }

  for (const path of routes) {
    try {
      const res = await page.goto(`${MKT}${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      })
      const status = res?.status() ?? 0
      const text = await page.locator('body').innerText().catch(() => '')
      note(
        status >= 200 && status < 400 && text.trim().length > 30 ? 'pass' : 'medium',
        'marketing-ui',
        `Route ${path}`,
        { status, chars: text.length, title: await page.title() },
      )
    } catch (e) {
      note('medium', 'marketing-ui', `Route ${path} failed`, { error: String(e) })
    }
  }

  await page.goto(`${MKT}/shop`, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => null)
  await page.waitForTimeout(1500)
  const shopText = await page.locator('body').innerText().catch(() => '')
  const hasProducts = /egg|crate|₦|NGN|Add|cart|product|shop/i.test(shopText)
  note(hasProducts ? 'pass' : 'high', 'marketing-ui', 'Shop catalog visible via proxy', {
    snippet: shopText.slice(0, 280),
  })

  // Vite function middleware (contact)
  const stamp = Date.now()
  try {
    const fn = await fetch(`${MKT}/.netlify/functions/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Vite Fn Audit',
        email: `vite-fn-${stamp}@example.com`,
        subject: 'general',
        message: 'Deep audit via Vite netlify function middleware',
        consent: true,
      }),
    })
    const body = await fn.json().catch(() => ({}))
    expectStatus('Vite /.netlify/functions/contact', 'marketing-ui', fn.status, [200], {
      body,
    })
  } catch (e) {
    note('high', 'marketing-ui', 'Vite contact function failed', { error: String(e) })
  }

  try {
    const fn = await fetch(`${MKT}/.netlify/functions/newsletter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'subscribe',
        name: 'Vite News',
        email: `vite-news-${stamp}@example.com`,
        consent: true,
        phoneConsent: false,
      }),
    })
    const body = await fn.json().catch(() => ({}))
    expectStatus('Vite /.netlify/functions/newsletter', 'marketing-ui', fn.status, [200, 202], {
      body,
    })
  } catch (e) {
    note('high', 'marketing-ui', 'Vite newsletter function failed', { error: String(e) })
  }

  // Shop register UI flow
  await page.goto(`${MKT}/shop`, { waitUntil: 'networkidle' }).catch(() => null)
  const registerLink = page.getByRole('link', { name: /register|create account|sign up/i }).first()
  if (await registerLink.count()) {
    await registerLink.click().catch(() => null)
    await page.waitForTimeout(800)
    note('pass', 'marketing-ui', 'Shop register entry point present', { url: page.url() })
  } else {
    note('info', 'marketing-ui', 'No obvious register link on /shop (may be modal/tab)', {
      url: page.url(),
    })
  }

  await browser.close()
}

// ── Extra security probes ───────────────────────────────────────────────
async function auditSecurityExtras() {
  // Public health
  {
    const res = await fetch(`${API}/health`)
    expectStatus('public /health', 'security', res.status, [200])
  }
  // Cron without secret
  {
    const res = await fetch(`${API}/api/alerts/run-proactive`, { method: 'POST' })
    note(
      [401, 403, 503].includes(res.status) ? 'pass' : 'high',
      'security',
      'cron run-proactive without secret denied',
      { status: res.status },
    )
  }
  // Newsletter webhook without signature
  {
    const res = await fetch(`${API}/public/newsletter/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    note(
      [400, 401, 403, 503].includes(res.status) ? 'pass' : 'medium',
      'security',
      'newsletter webhook without signature rejected',
      { status: res.status, body: await res.json().catch(() => ({})) },
    )
  }
  // Staff login with wrong password
  {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: STAFF.owner.email,
        password: 'DefinitelyWrongPassword999!',
      }),
    })
    expectStatus('bad password → 401', 'security', res.status, [401])
  }
}

// ── main ────────────────────────────────────────────────────────────────
mkdirSync(resolve(root, 'tmp'), { recursive: true })
console.log('Ensuring seed staff active…')
await ensureStaffActive()
console.log('== Security extras ==')
await auditSecurityExtras()
console.log('== OS API ==')
await auditOsApi()
console.log('== OS UI ==')
try {
  await auditOsUi()
} catch (e) {
  note('high', 'os-ui', 'Playwright OS UI failed', { error: String(e) })
}
console.log('== Shop + public ==')
await auditShopAndPublic()
console.log('== Marketing UI ==')
await auditMarketingUi()

const summary = {
  generatedAt: new Date().toISOString(),
  bases: { API, OS_APP, MKT },
  counts: {
    pass: findings.filter((f) => f.severity === 'pass').length,
    info: findings.filter((f) => f.severity === 'info').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    high: findings.filter((f) => f.severity === 'high').length,
  },
  gaps: findings.filter((f) => f.severity === 'high' || f.severity === 'medium'),
  findings,
}
const out = resolve(root, 'tmp/full-role-security-audit.json')
writeFileSync(out, JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ counts: summary.counts, gaps: summary.gaps }, null, 2))
console.log('Wrote', out)
