import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'

export type BackupStatus = {
  lastBackup: string | null
  backupCount: number
  backupEvidence: 'report' | 'filesystem' | 'none'
  backupReportStatus: string | null
  remoteDeliveryStatus: string | null
}

type BackupReport = {
  status?: unknown
  completedAt?: unknown
  databaseBackup?: unknown
  evidenceBackup?: unknown
  manifest?: unknown
  remoteDelivery?: { status?: unknown }
}

function isBackupFile(name: string): boolean {
  return name.endsWith('.sql') || name.endsWith('.sql.gpg')
}

function safeArtifactName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === basename(value) &&
    /^[A-Za-z0-9._-]+$/.test(value)
  )
}

export function getBackupDir(rootDir: string): string {
  const configured = process.env.BACKUP_DIR?.trim()
  if (!configured) return resolve(rootDir, 'backups')
  return isAbsolute(configured) ? configured : resolve(rootDir, configured)
}

export function getLastBackupInfo(rootDir: string): BackupStatus {
  try {
    const backupDir = getBackupDir(rootDir)
    const files = readdirSync(backupDir)
      .filter(isBackupFile)
      .map((name) => {
        const fullPath = resolve(backupDir, name)
        return { name, mtimeMs: statSync(fullPath).mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    const reportDir = process.env.BACKUP_REPORT_DIR?.trim()
      ? resolve(rootDir, process.env.BACKUP_REPORT_DIR.trim())
      : resolve(backupDir, 'reports')
    const reportPath = resolve(reportDir, 'latest-backup.json')
    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BackupReport
        const completedMs =
          typeof report.completedAt === 'string' ? Date.parse(report.completedAt) : Number.NaN
        const validArtifacts =
          safeArtifactName(report.databaseBackup) &&
          safeArtifactName(report.evidenceBackup) &&
          safeArtifactName(report.manifest) &&
          existsSync(resolve(backupDir, report.databaseBackup)) &&
          existsSync(resolve(backupDir, report.evidenceBackup)) &&
          existsSync(resolve(backupDir, report.manifest))

        if (report.status === 'success' && Number.isFinite(completedMs) && validArtifacts) {
          return {
            lastBackup: new Date(completedMs).toISOString(),
            backupCount: files.length,
            backupEvidence: 'report',
            backupReportStatus: 'success',
            remoteDeliveryStatus:
              typeof report.remoteDelivery?.status === 'string'
                ? report.remoteDelivery.status
                : null,
          }
        }
      } catch {
        // Fall back to filesystem evidence for legacy backups or malformed reports.
      }
    }

    if (!files.length) {
      return {
        lastBackup: null,
        backupCount: 0,
        backupEvidence: 'none',
        backupReportStatus: null,
        remoteDeliveryStatus: null,
      }
    }
    return {
      lastBackup: new Date(files[0].mtimeMs).toISOString(),
      backupCount: files.length,
      backupEvidence: 'filesystem',
      backupReportStatus: null,
      remoteDeliveryStatus: null,
    }
  } catch {
    return {
      lastBackup: null,
      backupCount: 0,
      backupEvidence: 'none',
      backupReportStatus: null,
      remoteDeliveryStatus: null,
    }
  }
}
