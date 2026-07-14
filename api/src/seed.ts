import './lib/env.js'
import { seedDemoData } from './lib/seed-data.js'

async function seed() {
  console.log('Seeding Trovara Farm dummy data...')

  try {
    await seedDemoData()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }

  console.log('Seed complete.')
  console.log('')
  console.log('Demo accounts (passwords from .env):')
  console.log('  owner@trovara.farm')
  console.log('  supervisor1@trovara.farm / supervisor2@trovara.farm')
  console.log('  worker1@trovara.farm / worker2@trovara.farm')
  process.exit(0)
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})
