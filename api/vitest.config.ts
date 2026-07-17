import { defineConfig } from 'vitest/config'
import './src/lib/env.js'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
