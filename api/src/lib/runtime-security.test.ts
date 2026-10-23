import { describe, expect, it } from 'vitest'
import { isSupportedSecureRuntime } from './runtime-security.js'

describe('Node security floor', () => {
  it.each(['22.23.4', '22.23.5', '22.24.0'])('accepts patched supported runtime %s', version => {
    expect(isSupportedSecureRuntime(version)).toBe(true)
  })
  it.each(['20.20.0', '22.0.0', '22.22.99', '22.23.0', '22.23.1', '22.23.2', '22.23.3', '22.23.4-rc.1', '24.22.0', 'invalid'])('rejects vulnerable or untested runtime %s', version => {
    expect(isSupportedSecureRuntime(version)).toBe(false)
  })
})
