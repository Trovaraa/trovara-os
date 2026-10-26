import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertFileIsClean } from './malware-scan.js'
afterEach(() => vi.unstubAllEnvs())
async function runScan(reply: string, early = false) {
  const root = await mkdtemp(join(tmpdir(), 'brand-scan-test-'))
  const path = join(root, 'sample.bin')
  await writeFile(path, Buffer.alloc(early ? 8 * 1048576 : 180000, 65))
  let received = 0
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (early) {
      socket.on('error', () => undefined)
      socket.resume()
      socket.end(reply)
      return
    }
    socket.on('data', chunk => { received += chunk.length })
    socket.on('end', () => socket.end(reply))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  vi.stubEnv('CLAMAV_HOST', '127.0.0.1')
  vi.stubEnv('CLAMAV_PORT', String(address.port))
  try { await assertFileIsClean(path); return received }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
}
describe('streaming Brand malware scanning', () => {
  it('streams the complete file using the ClamAV framing protocol', async () => {
    expect(await runScan('stream: OK\0')).toBe(180000 + 10 + 3 * 4 + 4)
  })
  it('fails closed for detected malware and scanner size errors', async () => {
    await expect(runScan('stream: Test-Signature FOUND\0')).rejects.toThrow('Upload rejected')
    await expect(runScan('INSTREAM size limit exceeded. ERROR\0')).rejects.toThrow('unexpected result')
  })
  it('rejects early scanner disconnects instead of hanging or accepting a partial scan', async () => {
    await expect(runScan('INSTREAM size limit exceeded. ERROR\0', true)).rejects.toThrow()
    await expect(runScan('stream: OK\0', true)).rejects.toThrow()
  })
})
