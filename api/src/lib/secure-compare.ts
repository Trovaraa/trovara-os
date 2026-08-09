import { timingSafeEqual } from 'node:crypto'

export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Length-independent compare for env secrets / break-glass passwords.
 * Pads both sides to a fixed buffer with an explicit length prefix so unequal
 * lengths cannot short-circuit, without using a fast password hash.
 */
const SECRET_COMPARE_MAX_BYTES = 1024

export function secureCompareSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length > SECRET_COMPARE_MAX_BYTES || b.length > SECRET_COMPARE_MAX_BYTES) {
    return false
  }

  const left = Buffer.alloc(4 + SECRET_COMPARE_MAX_BYTES)
  const right = Buffer.alloc(4 + SECRET_COMPARE_MAX_BYTES)
  left.writeUInt32BE(a.length, 0)
  right.writeUInt32BE(b.length, 0)
  a.copy(left, 4)
  b.copy(right, 4)
  return timingSafeEqual(left, right)
}
