import { defineConfig } from 'vitest/config'

const connection = process.env.TALENT_TEST_DATABASE_URL
if (!connection) throw new Error('TALENT_TEST_DATABASE_URL must identify a disposable local talent_test database')
const url = new URL(connection)
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/talent_test')) {
  throw new Error('Refusing to run Talent integration tests outside a local talent_test database')
}
process.env.DATABASE_URL = connection
export default defineConfig({ test: { include: ['src/**/*.integration.ts'], testTimeout: 20_000, hookTimeout: 20_000,
  env: { DATABASE_URL: connection, NODE_ENV: 'test' }, fileParallelism: false } })
