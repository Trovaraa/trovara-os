import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

const connection = process.env.FINANCE_TEST_DATABASE_URL
if (!connection) throw new Error('Set FINANCE_TEST_DATABASE_URL to an empty disposable local finance_test database')
const url = new URL(connection)
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/finance_test')) throw new Error('Unsafe database target')
const client = postgres(connection, { max: 1 })
const folder = fileURLToPath(new URL('../drizzle', import.meta.url))
const fixture = await mkdtemp(join(tmpdir(), 'trovara-finance-upgrade-'))
try {
  const tables = await client`select 1 from information_schema.tables where table_schema = 'public'`
  assert.equal(tables.length, 0, 'Upgrade fixture requires an empty database')
  for (const name of (await readdir(folder)).sort()) {
    if (name >= '20260921120000_0085_expense_payments') continue
    await cp(join(folder, name), join(fixture, name), { recursive: true })
  }
  await migrate(drizzle({ client }), { migrationsFolder: fixture })
  const farm = randomUUID(), user = randomUUID(), invoice = randomUUID()
  await client`insert into farms (id, name, slug, location) values (${farm}, 'Upgrade fixture', ${farm}, 'Synthetic')`
  await client`insert into users (id, farm_id, name, email, password_hash, role) values (${user}, ${farm}, 'Fixture', ${`${user}@example.invalid`}, 'not-a-password', 'owner')`
  await client`insert into expenses (id, farm_id, category, description, amount, recorded_by_id, expense_date, approval_status)
    values (${invoice}, ${farm}, 'equipment', 'Historical invoice', 100, ${user}, '2026-01-02', 'approved')`
  const [before] = await client`select * from expenses where id = ${invoice}`
  await migrate(drizzle({ client }), { migrationsFolder: folder })
  const [after] = await client`select * from expenses where id = ${invoice}`
  for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], `Historical field changed: ${key}`)
  assert.equal(after.amount_paid, 0); assert.equal(after.payment_status, 'unpaid')
  assert.equal(after.approved_at, null); assert.equal(after.payment_due_date, null)
  await assert.rejects(client`insert into expense_payments (farm_id, expense_id, amount, currency, paid_on, reference, request_id, recorded_by_id)
    values (${farm}, ${invoice}, 10, 'NGN', CURRENT_DATE, 'Synthetic', ${randomUUID()}, ${user})`)
  await client`update expenses set payment_due_date = '2026-01-09' where id = ${invoice}`
  await client`insert into expense_payments (farm_id, expense_id, amount, currency, paid_on, reference, request_id, recorded_by_id)
    values (${farm}, ${invoice}, 10, 'NGN', '2026-01-08', 'Synthetic historical payment', ${randomUUID()}, ${user})`
  const [paid] = await client`select amount_paid, payment_status from expenses where id = ${invoice}`
  assert.deepEqual(paid, { amount_paid: 10, payment_status: 'partially_paid' })
  console.log('Finance upgrade passed: historical fields preserved; approval/due dates not invented; due-date review enforced; historical payment recorded.')
} finally {
  await client.end()
  await rm(fixture, { recursive: true, force: true })
}
