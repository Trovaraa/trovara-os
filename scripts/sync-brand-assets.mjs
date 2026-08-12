#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(root, 'brand-assets.manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const checkOnly = process.argv.includes('--check')
const osOnly = process.argv.includes('--os-only')
const sourceDir = path.resolve(root, manifest.source)
const destinations = osOnly ? manifest.destinations.slice(0, 1) : manifest.destinations

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function dimensions(file) {
  if (path.extname(file).toLowerCase() === '.png') {
    const png = fs.readFileSync(file)
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (png.length < 24 || !png.subarray(0, 8).equals(signature)) {
      throw new Error(`Invalid PNG: ${file}`)
    }
    return [png.readUInt32BE(16), png.readUInt32BE(20)]
  }
  const svg = fs.readFileSync(file, 'utf8')
  const openingTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const viewBox = openingTag.match(/\bviewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i)
  const width = openingTag.match(/\bwidth=["']([\d.]+)(?:px)?["']/i)
  const height = openingTag.match(/\bheight=["']([\d.]+)(?:px)?["']/i)
  if (width && height) return [Number(width[1]), Number(height[1])]
  if (viewBox) return [Number(viewBox[1]), Number(viewBox[2])]
  throw new Error(`Cannot determine SVG dimensions: ${file}`)
}

let failures = 0
for (const asset of manifest.assets) {
  if (!/^[A-Za-z0-9._-]+$/.test(asset.file)) throw new Error(`Unsafe asset name: ${asset.file}`)
  const source = path.join(sourceDir, asset.file)
  if (!fs.existsSync(source)) throw new Error(`Canonical asset missing: ${source}`)
  const actualHash = sha256(source)
  const [actualWidth, actualHeight] = dimensions(source)
  if (actualHash !== asset.sha256 ||
      actualWidth !== asset.width ||
      actualHeight !== asset.height) {
    throw new Error(`Manifest metadata mismatch for ${asset.file}`)
  }

  for (const destinationName of destinations) {
    const destinationDir = path.resolve(root, destinationName)
    const destination = path.join(destinationDir, asset.file)
    const matches = fs.existsSync(destination) && sha256(destination) === actualHash
    if (checkOnly) {
      if (!matches) {
        console.error(`OUT OF SYNC: ${path.relative(root, destination)}`)
        failures += 1
      }
      continue
    }
    fs.mkdirSync(destinationDir, { recursive: true })
    fs.copyFileSync(source, destination)
    console.log(`synced ${path.relative(root, destination)}`)
  }
}

if (failures) process.exit(1)
console.log(checkOnly ? 'Brand assets match the canonical manifest' : 'Brand asset sync complete')
