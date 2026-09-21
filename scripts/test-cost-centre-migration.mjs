// Run only against a disposable test database. All fixtures are temporary.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'

const url = process.env.FINANCE_TEST_DATABASE_URL
if (!url || !(new URL(url).pathname.startsWith('/finance_test_') || new URL(url).pathname === '/trovara_os_upgrade')) {
  throw new Error('FINANCE_TEST_DATABASE_URL must identify a disposable finance_test_* or trovara_os_upgrade database')
}
const migration = await readFile(new URL('../api/drizzle/20260921140000_0086_cost_centres/migration.sql', import.meta.url), 'utf8')
const sql = postgres(url, { max: 1 })
try {
  await sql.begin(async (tx) => {
    await tx`create temporary table expenses (
      id text primary key, cost_centre_code text, description text not null,
      constraint expenses_cost_centre_check check (
        cost_centre_code is null or cost_centre_code in ('CC01', 'CC10', 'CC20', 'CC30', 'CC40', 'CC50', 'CC60', 'CC70', 'CC80')
      )
    ) on commit drop`
    // Ensure the migration can only resolve the fixture, even if the DB has real tables.
    await tx`set local search_path to pg_temp`
    const oldCodes = [null, 'CC01', 'CC10', 'CC20', 'CC30', 'CC40', 'CC50', 'CC60', 'CC70', 'CC80']
    for (const [index, code] of oldCodes.entries()) {
      await tx`insert into expenses values (${String(index)}, ${code}, 'Preserve this historical expense')`
    }
    const before = await tx`select * from expenses order by id`
    await assert.rejects(tx.savepoint(async (sp) => {
      await sp`insert into expenses values ('before-new', 'CC02', 'Must fail before upgrade')`
    }), { code: '23514' })

    await tx.unsafe(migration)
    assert.deepEqual(await tx`select * from expenses order by id`, before)
    for (const code of ['CC02', 'CC03', 'CC04']) {
      await tx`insert into expenses values (${code}, ${code}, 'New cost centre')`
      await tx`update expenses set cost_centre_code = ${code} where id = ${code}`
    }
    for (const code of ['CC99', 'CC-02']) {
      await assert.rejects(tx.savepoint(async (sp) => {
        await sp`insert into expenses values (${code}, ${code}, 'Invalid code')`
      }), { code: '23514' })
    }
    assert.equal((await tx`select count(*)::int as count from expenses`)[0].count, 13)
  })
  console.log('Cost-centre migration passed: historical rows preserved, new codes accepted, invalid codes rejected.')
} finally {
  await sql.end()
}
