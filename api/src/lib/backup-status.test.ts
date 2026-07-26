import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getLastBackupInfo } from './backup-status.js'

const originalBackupDir = process.env.BACKUP_DIR
const originalReportDir = process.env.BACKUP_REPORT_DIR
const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'trovara-backup-status-'))
  temporaryRoots.push(root)
  return root
}

/** Isolate from host/prod BACKUP_* so deploy VMs with real backup dirs cannot leak in. */
function useIsolatedBackupEnv(backupDir: string, reportDir?: string) {
  process.env.BACKUP_DIR = backupDir
  if (reportDir) process.env.BACKUP_REPORT_DIR = reportDir
  else delete process.env.BACKUP_REPORT_DIR
}

afterEach(() => {
  if (originalBackupDir === undefined) delete process.env.BACKUP_DIR
  else process.env.BACKUP_DIR = originalBackupDir
  if (originalReportDir === undefined) delete process.env.BACKUP_REPORT_DIR
  else process.env.BACKUP_REPORT_DIR = originalReportDir
  while (temporaryRoots.length) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
  }
})

describe('backup status evidence', () => {
  it('uses BACKUP_DIR instead of the repository default', () => {
    const root = temporaryRoot()
    const backupDir = join(root, 'external-backups')
    mkdirSync(backupDir)
    writeFileSync(join(backupDir, 'trovara.sql.gpg'), 'encrypted')
    useIsolatedBackupEnv(backupDir)

    const status = getLastBackupInfo(root)

    expect(status.backupCount).toBe(1)
    expect(status.backupEvidence).toBe('filesystem')
    expect(status.lastBackup).not.toBeNull()
  })

  it('prefers a valid atomic report with matching artifacts', () => {
    const root = temporaryRoot()
    const backupDir = join(root, 'backups')
    const reportDir = join(backupDir, 'reports')
    mkdirSync(reportDir, { recursive: true })
    useIsolatedBackupEnv(backupDir)
    writeFileSync(join(backupDir, 'trovara.sql.gpg'), 'database')
    writeFileSync(join(backupDir, 'trovara.evidence.tar.gpg'), 'evidence')
    writeFileSync(join(backupDir, 'trovara.manifest.sha256'), 'checksums')
    writeFileSync(
      join(reportDir, 'latest-backup.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'success',
        completedAt: '2026-07-17T12:00:00Z',
        databaseBackup: 'trovara.sql.gpg',
        evidenceBackup: 'trovara.evidence.tar.gpg',
        manifest: 'trovara.manifest.sha256',
        remoteDelivery: { enabled: true, status: 'delivered' },
      }),
    )

    expect(getLastBackupInfo(root)).toMatchObject({
      lastBackup: '2026-07-17T12:00:00.000Z',
      backupEvidence: 'report',
      backupReportStatus: 'success',
      remoteDeliveryStatus: 'delivered',
    })
  })

  it('does not trust a report whose evidence artifact is absent', () => {
    const root = temporaryRoot()
    const backupDir = join(root, 'backups')
    const reportDir = join(backupDir, 'reports')
    mkdirSync(reportDir, { recursive: true })
    useIsolatedBackupEnv(backupDir)
    writeFileSync(join(backupDir, 'trovara.sql.gpg'), 'database')
    writeFileSync(join(backupDir, 'trovara.manifest.sha256'), 'checksums')
    writeFileSync(
      join(reportDir, 'latest-backup.json'),
      JSON.stringify({
        status: 'success',
        completedAt: '2026-07-17T12:00:00Z',
        databaseBackup: 'trovara.sql.gpg',
        evidenceBackup: 'missing.evidence.tar.gpg',
        manifest: 'trovara.manifest.sha256',
      }),
    )

    expect(getLastBackupInfo(root).backupEvidence).toBe('filesystem')
  })
})
