import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'

export type BackupStatus = {
  lastBackup: string | null
  backupCount: number
  backupEvidence: 'report' | 'filesystem' | 'none'
  backupReportStatus: string | null
  remoteDeliveryStatus: string | null
  lastRestoreTest: string | null
  restoreTestStatus: string | null
  restoreTestAgeHours: number | null
  restoreTestFresh: boolean | null
}

type BackupReport = {
  status?: unknown
  completedAt?: unknown
  databaseBackup?: unknown
  evidenceBackup?: unknown
  manifest?: unknown
  remoteDelivery?: { status?: unknown }
}

type RestoreTestStatus = Pick<
  BackupStatus,
  'lastRestoreTest' | 'restoreTestStatus' | 'restoreTestAgeHours' | 'restoreTestFresh'
>

function readRestoreTestStatus(reportDir: string): RestoreTestStatus {
  try {
    const report = JSON.parse(
      readFileSync(resolve(reportDir, 'latest-restore-test.json'), 'utf8'),
    ) as { status?: unknown; completedAt?: unknown }
    const completedMs =
      typeof report.completedAt === 'string' ? Date.parse(report.completedAt) : Number.NaN
    if (!Number.isFinite(completedMs)) throw new Error('invalid restore report date')
    const ageHours = Math.max(0, Math.round(((Date.now() - completedMs) / 3_600_000) * 10) / 10)
    const maxAge = Number.parseInt(process.env.RESTORE_TEST_MAX_AGE_HOURS?.trim() || '192', 10)
    return {
      lastRestoreTest: new Date(completedMs).toISOString(),
      restoreTestStatus: typeof report.status === 'string' ? report.status : null,
      restoreTestAgeHours: ageHours,
      restoreTestFresh: report.status === 'success' && ageHours <= (Number.isFinite(maxAge) ? maxAge : 192),
    }
  } catch {
    return {
      lastRestoreTest: null,
      restoreTestStatus: null,
      restoreTestAgeHours: null,
      restoreTestFresh: null,
    }
  }
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

    const reportConfigured = process.env.BACKUP_REPORT_DIR?.trim()
    const reportDir = reportConfigured
      ? isAbsolute(reportConfigured)
        ? reportConfigured
        : resolve(rootDir, reportConfigured)
      : resolve(backupDir, 'reports')
    const reportPath = resolve(reportDir, 'latest-backup.json')
    const restoreTest = readRestoreTestStatus(reportDir)
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
            ...restoreTest,
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
        ...restoreTest,
      }
    }
    return {
      lastBackup: new Date(files[0].mtimeMs).toISOString(),
      backupCount: files.length,
      backupEvidence: 'filesystem',
      backupReportStatus: null,
      remoteDeliveryStatus: null,
      ...restoreTest,
    }
  } catch {
    return {
      lastBackup: null,
      backupCount: 0,
      backupEvidence: 'none',
      backupReportStatus: null,
      remoteDeliveryStatus: null,
      lastRestoreTest: null,
      restoreTestStatus: null,
      restoreTestAgeHours: null,
      restoreTestFresh: null,
    }
  }
}
