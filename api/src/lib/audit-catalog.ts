/**
 * Audit vs security catalog — source of truth for what belongs where.
 *
 * Security (`logs/security.log`): auth, abuse, access-control, sensitive access attempts.
 * Audit (`audit_events`): who changed farm data, money, or admin config.
 *
 * Dual-write privileged admin actions (staff role, vault reveal, break-glass, TOTP)
 * to both. Auth noise stays security-only. Pure business mutations stay audit-only.
 */

export type AuditDomain =
  | 'identity'
  | 'vault'
  | 'orders'
  | 'payments'
  | 'finance'
  | 'inventory'
  | 'catalog'
  | 'farm_ops'
  | 'privacy'
  | 'integrations'
  | 'other'

/** entityType values grouped for the Audit dashboard domain filter. */
export const AUDIT_DOMAIN_ENTITY_TYPES: Record<AuditDomain, readonly string[]> = {
  identity: ['user', 'farm_role', 'session', 'registration_token'],
  vault: ['portal_vault_entry'],
  orders: ['order'],
  payments: ['payment', 'payment_attempt', 'invoice', 'receipt', 'refund'],
  finance: ['expense', 'purchase_order', 'goods_receipt', 'supplier'],
  inventory: ['inventory_item', 'inventory_movement', 'inventory_count'],
  catalog: ['product'],
  farm_ops: [
    'zone',
    'plot',
    'crop_cycle',
    'livestock_batch',
    'livestock_log',
    'harvest_lot',
    'task',
    'farm',
  ],
  privacy: ['privacy', 'data_export', 'consent'],
  integrations: ['whatsapp', 'telegram', 'newsletter', 'journal', 'marketing_lead', 'brand_asset', 'brand_pack'],
  other: [],
}

export const AUDIT_DOMAIN_LABELS: Record<AuditDomain, string> = {
  identity: 'Identity & access',
  vault: 'Vault',
  orders: 'Orders',
  payments: 'Payments',
  finance: 'Finance & purchasing',
  inventory: 'Inventory',
  catalog: 'Catalog',
  farm_ops: 'Farm operations',
  privacy: 'Privacy & exports',
  integrations: 'Integrations & content',
  other: 'Other',
}

/** Map a free-form entityType to a dashboard domain. */
export function auditDomainForEntityType(entityType: string): AuditDomain {
  const key = entityType.trim().toLowerCase()
  for (const [domain, types] of Object.entries(AUDIT_DOMAIN_ENTITY_TYPES) as [
    AuditDomain,
    readonly string[],
  ][]) {
    if (domain === 'other') continue
    if (types.includes(key)) return domain
  }
  return 'other'
}

export function entityTypesForAuditDomain(domain: AuditDomain | 'all'): string[] | null {
  if (domain === 'all') return null
  if (domain === 'other') {
    const known = new Set(
      Object.entries(AUDIT_DOMAIN_ENTITY_TYPES)
        .filter(([d]) => d !== 'other')
        .flatMap(([, types]) => types),
    )
    return [...known]
  }
  return [...AUDIT_DOMAIN_ENTITY_TYPES[domain]]
}

/**
 * Guidance only — not enforced at runtime.
 * security_only: do not put on Audit dashboard as primary signal.
 * audit_only: business mutations without security.log.
 * dual: privileged admin — write both.
 */
export const AUDIT_SECURITY_SPLIT = {
  security_only: [
    'failed_login',
    'csrf_failure',
    'forbidden_access',
    'invalid_webhook_signature',
    'customer_order_abuse',
    'break_glass_disarmed_attempt',
    'vault_reveal_failed',
  ],
  dual: [
    'staff_user_*',
    'farm_role_*',
    'vault_entry_*',
    'vault_password_revealed',
    'break_glass_*',
    'totp_*',
    'login',
    'logout',
  ],
  audit_primary: [
    'order create/status (incl. customer channels)',
    'payment succeeded (webhook + manual)',
    'expense / PO / inventory / product / farm structure mutations',
    'privacy exports and retention',
  ],
} as const
