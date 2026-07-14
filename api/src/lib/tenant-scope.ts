export function sanitizeAnonymizedName(): string {
  return 'Anonymized'
}

export function sanitizeAnonymizedEmail(userId: string): string {
  return `anon@${userId}.invalid`
}

export function assertTenantScope(actorFarmId: string, targetFarmId: string): void {
  if (actorFarmId !== targetFarmId) {
    throw new Error('TENANT_SCOPE_MISMATCH')
  }
}
