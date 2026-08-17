#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

function argsOf(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value == null) throw new Error(`Invalid argument: ${key ?? ''}`)
    args.set(key.slice(2), value)
  }
  return args
}

function safeSha(value) {
  return /^[a-f0-9]{7,40}$/i.test(value || '') ? value : null
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function required(args, key) {
  const value = args.get(key)
  if (!value) throw new Error(`Missing --${key}`)
  return value
}

export function recordRelease(argv = process.argv.slice(2)) {
  const args = argsOf(argv)
  const historyDir = required(args, 'history-dir')
  const release = readJson(required(args, 'release-file'))
  const sha = safeSha(release?.sha)
  if (!sha) throw new Error('Release metadata has no valid SHA')

  const operation = args.get('operation') === 'rollback' ? 'rollback' : 'deploy'
  const previousSha = safeSha(args.get('previous-sha'))
  const backup = readJson(args.get('backup-report') || '')
  const migrationCount = Number.parseInt(args.get('migration-count') || '', 10)
  const migrationTip = args.get('migration-tip') || null
  const migrationAction = args.get('migration-action') === 'skipped' ? 'skipped' : 'applied'
  const operator = (args.get('operator') || 'unknown').replace(/[\r\n]/g, ' ').slice(0, 160)
  const record = {
    schemaVersion: 1,
    status: 'success',
    operation,
    sha,
    tag: typeof release.tag === 'string' ? release.tag : null,
    releasedAt: typeof release.releasedAt === 'string' ? release.releasedAt : null,
    completedAt: new Date().toISOString(),
    previousSha,
    rollbackFrom: safeSha(args.get('rollback-from')),
    operator,
    migrationTip,
    migrationCount: Number.isFinite(migrationCount) ? migrationCount : null,
    migrationAction,
    backup: backup
      ? {
          status: typeof backup.status === 'string' ? backup.status : null,
          completedAt: typeof backup.completedAt === 'string' ? backup.completedAt : null,
          database: typeof backup.databaseBackup === 'string' ? basename(backup.databaseBackup) : null,
          evidence: typeof backup.evidenceBackup === 'string' ? basename(backup.evidenceBackup) : null,
          manifest: typeof backup.manifest === 'string' ? basename(backup.manifest) : null,
          remoteDelivery:
            typeof backup.remoteDelivery?.status === 'string' ? backup.remoteDelivery.status : null,
        }
      : null,
  }

  mkdirSync(historyDir, { recursive: true, mode: 0o750 })
  appendFileSync(join(historyDir, 'history.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o640 })
  const currentPath = join(historyDir, 'current.json')
  const temporaryPath = `${currentPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o640 })
  renameSync(temporaryPath, currentPath)
  return record
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const record = recordRelease()
    process.stdout.write(`Recorded ${record.operation} release ${record.sha}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
