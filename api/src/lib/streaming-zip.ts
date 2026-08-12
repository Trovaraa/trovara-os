import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { crc32 } from 'node:zlib'

export type StreamingZipEntry = {
  name: string
  path: string
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(value, 0)
  return buf
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return buf
}

function sanitizeZipName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() || 'asset'
  return base.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180) || 'asset'
}

async function crc32File(path: string): Promise<number> {
  const fh = await open(path, 'r')
  try {
    let crc = 0
    const buf = Buffer.alloc(64 * 1024)
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      crc = crc32(buf.subarray(0, bytesRead), crc)
    }
    return crc >>> 0
  } finally {
    await fh.close()
  }
}

/**
 * Store-method ZIP as a Node Readable that never buffers entire files.
 * Scans each entry once for CRC/size, then streams local headers + file bytes,
 * then the central directory.
 */
export function createStoredZipStream(entries: StreamingZipEntry[]): Readable {
  const queue = [...entries]
  let phase: 'meta' | 'files' | 'central' | 'done' = 'meta'
  const prepared: Array<{
    name: Buffer
    path: string
    size: number
    crc: number
    offset: number
  }> = []
  let fileIndex = 0
  let currentFile: Readable | null = null
  let offset = 0
  const centralParts: Buffer[] = []

  const stream = new Readable({
    read() {
      void tick()
    },
  })

  async function tick(): Promise<void> {
    try {
      if (phase === 'meta') {
        const used = new Set<string>()
        for (const entry of queue) {
          let nameStr = sanitizeZipName(entry.name)
          if (used.has(nameStr)) {
            const ext = nameStr.includes('.') ? nameStr.slice(nameStr.lastIndexOf('.')) : ''
            const stem = ext ? nameStr.slice(0, -ext.length) : nameStr
            let i = 2
            while (used.has(`${stem}-${i}${ext}`)) i += 1
            nameStr = `${stem}-${i}${ext}`
          }
          used.add(nameStr)
          const info = await stat(entry.path)
          const crc = await crc32File(entry.path)
          prepared.push({
            name: Buffer.from(nameStr, 'utf8'),
            path: entry.path,
            size: info.size,
            crc,
            offset: 0,
          })
        }
        phase = 'files'
        void tick()
        return
      }

      if (phase === 'files') {
        if (currentFile) return
        if (fileIndex >= prepared.length) {
          phase = 'central'
          void tick()
          return
        }
        const entry = prepared[fileIndex]!
        entry.offset = offset
        const localHeader = Buffer.concat([
          u32(0x04034b50),
          u16(20),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(entry.crc),
          u32(entry.size),
          u32(entry.size),
          u16(entry.name.length),
          u16(0),
          entry.name,
        ])
        offset += localHeader.length + entry.size
        if (!stream.push(localHeader)) {
          // wait for drain via next read()
        }

        centralParts.push(
          Buffer.concat([
            u32(0x02014b50),
            u16(20),
            u16(20),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(entry.crc),
            u32(entry.size),
            u32(entry.size),
            u16(entry.name.length),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(entry.offset),
            entry.name,
          ]),
        )

        currentFile = createReadStream(entry.path)
        currentFile.on('data', (chunk: Buffer) => {
          if (!stream.push(chunk)) currentFile?.pause()
        })
        currentFile.on('end', () => {
          currentFile = null
          fileIndex += 1
          void tick()
        })
        currentFile.on('error', (err) => stream.destroy(err))
        stream.once('drain', () => currentFile?.resume())
        return
      }

      if (phase === 'central') {
        const centralDir = Buffer.concat(centralParts)
        const end = Buffer.concat([
          u32(0x06054b50),
          u16(0),
          u16(0),
          u16(prepared.length),
          u16(prepared.length),
          u32(centralDir.length),
          u32(offset),
          u16(0),
        ])
        stream.push(centralDir)
        stream.push(end)
        stream.push(null)
        phase = 'done'
      }
    } catch (error) {
      stream.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return stream
}

/** Keep buffer ZIP for small tests / image-only packs under a size budget. */
export { buildStoredZip } from './stored-zip.js'
