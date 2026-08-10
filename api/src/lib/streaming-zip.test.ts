import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { createStoredZipStream } from './streaming-zip.js'
import { buildStoredZip } from './stored-zip.js'

describe('streaming zip', () => {
  it('builds a valid store-method zip without buffering all files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brand-zip-'))
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    await writeFile(a, 'hello')
    await writeFile(b, 'world!')
    const out = join(dir, 'out.zip')
    const stream = createStoredZipStream([
      { name: 'a.txt', path: a },
      { name: 'b.txt', path: b },
    ])
    const sink = createWriteStream(out)
    stream.pipe(sink)
    await finished(sink)
    const bytes = await readFile(out)
    expect(bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true)

    const buffered = buildStoredZip([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'b.txt', data: Buffer.from('world!') },
    ])
    // Same CRC/store layout for tiny payloads
    expect(bytes.equals(buffered)).toBe(true)
  })
})
