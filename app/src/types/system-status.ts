export type SystemStatus = {
  api: string
  db: string
  dbLatencyMs: number
  lastBackup: string | null
  backupCount: number
  whatsappConfigured: boolean
  aiMode: string
  commit: string
  env: string
  ts: string
}
