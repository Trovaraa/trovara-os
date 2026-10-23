import { describe, expect, it } from 'vitest'
import { isSupportedSecureRuntime } from './runtime-security.js'

describe('Node security floor', () => {
  it.each(['24.22.1', '24.22.2', '24.23.0'])('accepts patched supported runtime %s', version => {
    expect(isSupportedSecureRuntime(version)).toBe(true)
  })
  it.each(['20.20.0', '22.23.4', '24.0.0', '24.21.99', '24.22.0', '24.22.1-rc.1', '25.0.0', '26.12.1', 'invalid'])('rejects vulnerable or untested runtime %s', version => {
    expect(isSupportedSecureRuntime(version)).toBe(false)
  })
})
