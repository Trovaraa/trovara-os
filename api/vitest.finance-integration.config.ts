import { defineConfig } from 'vitest/config'
const connection = process.env.FINANCE_TEST_DATABASE_URL
if (!connection) throw new Error('FINANCE_TEST_DATABASE_URL must identify a disposable local finance_test database')
const url = new URL(connection)
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/finance_test')) {
  throw new Error('Refusing to run finance tests outside a local finance_test database')
}
process.env.DATABASE_URL = connection
export default defineConfig({ test: { include: ['src/routes/finance-payments.integration.ts'], testTimeout: 20_000, hookTimeout: 20_000,
  env: { DATABASE_URL: connection, NODE_ENV: 'test' }, fileParallelism: false } })
