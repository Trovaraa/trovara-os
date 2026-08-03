#!/usr/bin/env node
/**
 * Deeper functional probes per role (mutations + UI/API mismatches).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function loadEnv() {
  const env = {}
  for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}
const env = loadEnv()
const API = 'http://127.0.0.1:3000'

const ACCOUNTS = {
  owner: { email: env.BREAK_GLASS_EMAIL || 'owner@trovara.farm', password: env.BREAK_GLASS_PASSWORD },
  supervisor: { email: 'supervisor1@trovara.farm', password: env.SEED_SUPERVISOR_PASSWORD },
  field_worker: { email: 'worker1@trovara.farm', password: env.SEED_WORKER_PASSWORD },
  sales: { email: 'sales@trovara.farm', password: env.SEED_SALES_PASSWORD },
}

function parseCookies(res) {
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const parts = setCookie.map((c) => c.split(';')[0].trim())
  const map = Object.fromEntries(parts.map((p) => {
    const i = p.indexOf('=')
    return [p.slice(0, i), p.slice(i + 1)]
  }))
  return { header: parts.join('; '), csrf: map.trovara_csrf }
}

async function login(role) {
  const acc = ACCOUNTS[role]
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(acc),
  })
  const body = await res.json()
  const cookies = parseCookies(res)
  return { status: res.status, body, ...cookies, role }
}

async function call(session, method, path, body) {
  const headers = { cookie: session.header }
  if (body) headers['content-type'] = 'application/json'
  if (session.csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = session.csrf
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  return { status: res.status, json }
}

const findings = []
function note(severity, role, title, detail) {
  findings.push({ severity, role, title, detail })
}

const sessions = {}
for (const role of Object.keys(ACCOUNTS)) {
  sessions[role] = await login(role)
  if (sessions[role].status !== 200) {
    note('critical', role, 'Login failed', sessions[role].body)
  }
}

// --- Sales: order staff mutations ---
{
  const s = sessions.sales
  const products = await call(s, 'GET', '/api/products')
  const productId = products.json?.products?.[0]?.id || products.json?.[0]?.id
  const create = await call(s, 'POST', '/api/sales', {
    customerName: 'Audit Buyer',
    items: productId ? [{ productId, quantity: 1 }] : [],
  })
  note(
    create.status < 300 || create.status === 400 ? 'info' : 'high',
    'sales',
    'Create sales order',
    { status: create.status, error: create.json?.error, productId },
  )

  const list = await call(s, 'GET', '/api/sales')
  const orderId = list.json?.orders?.[0]?.id || list.json?.[0]?.id
  if (orderId) {
    const patch = await call(s, 'PATCH', `/api/sales/${orderId}`, { status: 'confirmed' })
    note(patch.status < 300 || patch.status === 400 ? 'info' : 'high', 'sales', 'Patch order status', { status: patch.status, error: patch.json?.error })
    const del = await call(s, 'DELETE', `/api/sales/${orderId}`)
    note(
      del.status === 403 ? 'info' : 'medium',
      'sales',
      'Delete order should be forbidden for sales (ops-only)',
      { status: del.status, error: del.json?.error },
    )
  }

  const wa = await call(s, 'POST', '/api/whatsapp/send', { to: '2348000000000', templateId: 'taskComplete', language: 'en', variables: [] })
  note(
    wa.status === 403 ? 'medium' : 'high',
    'sales',
    'WhatsApp send from sales (nav shows WA; API is owner|supervisor)',
    { status: wa.status, error: wa.json?.error },
  )

  const invCount = await call(s, 'POST', '/api/inventory/count-sessions', {})
  note(
    invCount.status === 403 ? 'info' : 'medium',
    'sales',
    'Inventory count session create',
    { status: invCount.status, error: invCount.json?.error },
  )

  // Product create allowed; delete owner-only
  const prodCreate = await call(s, 'POST', '/api/products', { name: 'Audit SKU', sku: `AUD-${Date.now()}`, unit: 'pack', priceKobo: 100 })
  note(prodCreate.status < 300 || prodCreate.status === 400 ? 'info' : 'high', 'sales', 'Create product', { status: prodCreate.status, error: prodCreate.json?.error })
  const newId = prodCreate.json?.product?.id || prodCreate.json?.id
  if (newId) {
    const prodDel = await call(s, 'DELETE', `/api/products/${newId}`)
    note(prodDel.status === 403 ? 'info' : 'medium', 'sales', 'Delete product should be owner-only', { status: prodDel.status })
  }

  const certExport = await call(s, 'GET', '/api/traceability/export')
  note(certExport.status === 200 ? 'info' : 'low', 'sales', 'Traceability export (finance gate includes sales)', { status: certExport.status })
}

// --- Supervisor: ops yes, finance/marketing no, WA send yes ---
{
  const s = sessions.supervisor
  const fin = await call(s, 'GET', '/api/finance')
  note(fin.status === 403 ? 'info' : 'critical', 'supervisor', 'Finance blocked', { status: fin.status })
  const leads = await call(s, 'GET', '/api/marketing-leads')
  note(leads.status === 403 ? 'info' : 'high', 'supervisor', 'Marketing leads blocked', { status: leads.status })
  const shop = await call(s, 'GET', '/api/shop-customers')
  note(shop.status === 403 ? 'info' : 'high', 'supervisor', 'Shop customers blocked', { status: shop.status })
  const exportT = await call(s, 'GET', '/api/traceability/export')
  note(
    exportT.status === 403 ? 'medium' : 'low',
    'supervisor',
    'Traceability export blocked for supervisor (gate is finance=owner|sales, not ops)',
    { status: exportT.status },
  )
  const users = await call(s, 'GET', '/api/users')
  note(users.status === 200 ? 'info' : 'high', 'supervisor', 'List users (redacted)', { status: users.status, count: users.json?.users?.length || users.json?.length })
  const createUser = await call(s, 'POST', '/api/users', { email: 'x@y.z', name: 'X', role: 'field_worker', password: 'Password123!' })
  note(createUser.status === 403 ? 'info' : 'critical', 'supervisor', 'Create user forbidden', { status: createUser.status })

  const pending = await call(s, 'GET', '/api/tasks/pending-approvals')
  note(pending.status === 200 ? 'info' : 'high', 'supervisor', 'Pending approvals', { status: pending.status })
  const tasks = await call(s, 'GET', '/api/tasks')
  const taskId = tasks.json?.tasks?.[0]?.id || tasks.json?.[0]?.id
  if (taskId) {
    // try approve-ish patch
    const patch = await call(s, 'PATCH', `/api/tasks/${taskId}`, { status: 'approved' })
    note(['200','400','409','422'].includes(String(patch.status)) || patch.status < 300 ? 'info' : (patch.status === 403 ? 'high' : 'medium'), 'supervisor', 'Task approve/patch', { status: patch.status, error: patch.json?.error })
  }

  const wa = await call(s, 'POST', '/api/whatsapp/send', { to: '2348000000000', templateId: 'taskComplete', language: 'en', variables: [] })
  note(
    wa.status === 403 ? 'high' : 'info',
    'supervisor',
    'WhatsApp send allowed for supervisor',
    { status: wa.status, error: wa.json?.error },
  )

  const po = await call(s, 'POST', '/api/purchase-orders', { supplierId: '00000000-0000-0000-0000-000000000000', lines: [] })
  // may 400; should not be 403
  note(po.status !== 403 ? 'info' : 'high', 'supervisor', 'Create PO not forbidden', { status: po.status, error: po.json?.error })
}

// --- Field worker ---
{
  const s = sessions.field_worker
  const clock = await call(s, 'POST', '/api/attendance/clock-in', {})
  note(
    clock.status < 300 || clock.status === 400 || clock.status === 409 ? 'info' : 'high',
    'field_worker',
    'Clock-in',
    { status: clock.status, error: clock.json?.error },
  )
  const tasks = await call(s, 'GET', '/api/tasks')
  note(tasks.status === 200 ? 'info' : 'high', 'field_worker', 'Own tasks list', { status: tasks.status })
  const fr = await call(s, 'POST', '/api/field-reports', { title: 'Audit report', body: 'Probe', severity: 'info' })
  note(fr.status < 300 || fr.status === 400 ? 'info' : 'high', 'field_worker', 'Create field report', { status: fr.status, error: fr.json?.error })
  const salesContact = await call(s, 'GET', '/api/sales')
  const redacted = JSON.stringify(salesContact.json || {}).includes('***') || salesContact.status === 200
  note('info', 'field_worker', 'Sales list (PII redaction expected)', { status: salesContact.status, sample: JSON.stringify(salesContact.json).slice(0, 200) })
  const contacts = await call(s, 'GET', '/api/sales/contacts/00000000-0000-0000-0000-000000000001')
  note(contacts.status === 403 || contacts.status === 404 ? 'info' : 'medium', 'field_worker', 'Sales contact detail blocked/missing', { status: contacts.status })
  const assign = await call(s, 'POST', '/api/tasks', { title: 'Nope' })
  note(assign.status === 403 ? 'info' : 'critical', 'field_worker', 'Assign task forbidden', { status: assign.status })
  const finance = await call(s, 'GET', '/api/finance')
  note(finance.status === 403 ? 'info' : 'critical', 'field_worker', 'Finance forbidden', { status: finance.status })
  const aiBrief = await call(s, 'GET', '/api/ai/briefing')
  note(aiBrief.status === 403 ? 'info' : 'medium', 'field_worker', 'AI briefing forbidden', { status: aiBrief.status })
  const diagnose = await call(s, 'POST', '/api/ai/diagnose-crop', { description: 'yellow leaves' })
  note(diagnose.status !== 403 ? 'info' : 'medium', 'field_worker', 'AI crop diagnose allowed', { status: diagnose.status, error: diagnose.json?.error })
}

// --- Owner ---
{
  const s = sessions.owner
  const journal = await call(s, 'GET', '/api/journal')
  note(journal.status === 200 ? 'info' : 'high', 'owner', 'Journal access', { status: journal.status })
  const prefs = await call(s, 'GET', '/auth/preferences')
  note(prefs.status === 200 ? 'info' : 'high', 'owner', 'Preferences', { status: prefs.status })
  const totp = await call(s, 'GET', '/auth/totp/status')
  note(totp.status === 200 ? 'info' : 'high', 'owner', 'TOTP status', { status: totp.status, enabled: totp.json?.enabled })
  const insights = await call(s, 'GET', '/api/customer-insights')
  note(insights.status === 200 ? 'info' : 'high', 'owner', 'Customer insights', { status: insights.status })
  const postApproval = await call(s, 'GET', '/api/tasks/post-approval-changes')
  note(postApproval.status === 200 || postApproval.status === 403 ? 'info' : 'medium', 'owner', 'Post-approval changes', { status: postApproval.status, note: 'API allows canApproveTasks incl supervisor; UI is ownerOnly' })
}

// Cross-check UI/API asymmetry: supervisor can call post-approval API but UI route is ownerOnly
{
  const s = sessions.supervisor
  const postApproval = await call(s, 'GET', '/api/tasks/post-approval-changes')
  note(
    postApproval.status === 200 ? 'medium' : 'info',
    'supervisor',
    'Post-approval API reachable but /tasks/post-approval UI is ownerOnly',
    { status: postApproval.status },
  )
}

const out = { generatedAt: new Date().toISOString(), findings }
mkdirSync(resolve(root, 'tmp'), { recursive: true })
writeFileSync(resolve(root, 'tmp/role-audit-deep.json'), JSON.stringify(out, null, 2))
const bySev = Object.groupBy ? Object.groupBy(findings, (f) => f.severity) : findings.reduce((a, f) => ((a[f.severity] ||= []).push(f), a), {})
console.log(JSON.stringify({ counts: Object.fromEntries(Object.entries(bySev).map(([k, v]) => [k, v.length])), findings }, null, 2))
