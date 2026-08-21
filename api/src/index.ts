import './lib/env.js'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { authRoutes } from './routes/auth.js'
import { taskRoutes } from './routes/tasks.js'
import { inventoryRoutes } from './routes/inventory.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { todayRoutes } from './routes/today.js'
import { reportRoutes } from './routes/reports.js'
import { cropRoutes } from './routes/crops.js'
import { livestockRoutes } from './routes/livestock.js'
import { salesRoutes } from './routes/sales.js'
import { productRoutes } from './routes/products.js'
import { financeRoutes } from './routes/finance.js'
import { publicFinanceInboundRoutes } from './routes/finance-inbound.js'
import { careersRoutes, publicCareersRoutes } from './routes/careers.js'
import { traceabilityRoutes } from './routes/traceability.js'
import { assetRoutes } from './routes/assets.js'
import { maintenanceRoutes } from './routes/maintenance.js'
import { contractorRoutes } from './routes/contractors.js'
import { anomalyRoutes } from './routes/anomalies.js'
import { scanningRoutes } from './routes/scanning.js'
import { customerInsightsRoutes } from './routes/customer-insights.js'
import { aiRoutes } from './routes/ai.js'
import { whatsappRoutes } from './routes/whatsapp.js'
import { telegramRoutes } from './routes/telegram.js'
import { paystackRoutes } from './routes/paystack.js'
import { startTelegramPolling } from './lib/telegram-inbound.js'
import { startCustomerTelegramPolling } from './lib/customer-telegram-inbound.js'
import { resumeBrandAssetProcessing } from './lib/brand-processing.js'
import { userRoutes } from './routes/users.js'
import { roleRoutes } from './routes/roles.js'
import { permissionTeamRoutes } from './routes/permission-teams.js'
import { operationGuidelineRoutes } from './routes/operation-guidelines.js'
import { vaultRoutes } from './routes/vault.js'
import { eventRoutes } from './routes/events.js'
import { publicRoutes } from './routes/public.js'
import { templateRoutes } from './routes/templates.js'
import { zoneRoutes } from './routes/zones.js'
import { onboardingRoutes } from './routes/onboarding.js'
import { billingRoutes } from './routes/billing.js'
import { systemRoutes } from './routes/system.js'
import { dayCloseRoutes } from './routes/day-close.js'
import { alertsRoutes } from './routes/alerts.js'
import { advisoryRoutes } from './routes/advisory.js'
import { exportRoutes } from './routes/exports.js'
import { consentRoutes } from './routes/consent.js'
import { privacyRoutes } from './routes/privacy.js'
import { evidenceRoutes } from './routes/evidence.js'
import { censusRoutes, taskCensusRoutes } from './routes/census.js'
import { handoverRoutes } from './routes/handover.js'
import { farmRoutes } from './routes/farm.js'
import { attendanceRoutes } from './routes/attendance.js'
import { supplierRoutes } from './routes/suppliers.js'
import { purchaseOrderRoutes } from './routes/purchase-orders.js'
import { fieldReportRoutes } from './routes/field-reports.js'
import { supportRoutes } from './routes/support.js'
import { customerShopRoutes } from './routes/customer-shop.js'
import { journalRoutes, publicJournalRoutes } from './routes/journal.js'
import { brandRoutes, publicBrandRoutes } from './routes/brand.js'
import { newsletterRoutes, publicNewsletterRoutes } from './routes/newsletter.js'
import { newsletterCampaignRoutes } from './routes/newsletter-campaigns.js'
import {
  marketingLeadRoutes,
  publicMarketingLeadRoutes,
} from './routes/marketing-leads.js'
import {
  customerSurveyRoutes,
  publicCustomerSurveyRoutes,
} from './routes/customer-surveys.js'
import { momentsRoutes, publicMomentsRoutes } from './routes/moments.js'
import { shopCustomerRoutes } from './routes/shop-customers.js'
import { customerCreditRoutes } from './routes/customer-credits.js'
import { newsletterConfigMissing } from './lib/newsletter-resend.js'
import {
  apiMutationRateLimit,
  authMutationRateLimit,
  securityMiddleware,
  requestLogger,
} from './middleware/security.js'
import { logSecurityEvent } from './lib/security-log.js'
import { logApiEvent } from './lib/api-log.js'
import { ensureBreakGlassOwner } from './lib/break-glass.js'
import { getBreakGlassEmail, getBreakGlassPasswordFromEnv } from './lib/registration.js'
import { clientIpFromHeaders } from './lib/client-ip.js'
import { deploymentSha } from './lib/deployment.js'

const app = new Hono()

app.use('*', ...securityMiddleware())
app.use('*', requestLogger)
app.use('/auth/*', authMutationRateLimit)
app.use('/api/*', apiMutationRateLimit)
app.use('/shop/*', apiMutationRateLimit)

app.route('/auth', authRoutes)
app.route('/api/dashboard', dashboardRoutes)
app.route('/api/today', todayRoutes)
app.route('/api/tasks', taskRoutes)
app.route('/api/tasks', taskCensusRoutes)
app.route('/api/census', censusRoutes)
app.route('/api/handover', handoverRoutes)
app.route('/api/farm', farmRoutes)
app.route('/api/attendance', attendanceRoutes)
app.route('/api/evidence', evidenceRoutes)
app.route('/api/inventory', inventoryRoutes)
app.route('/api/suppliers', supplierRoutes)
app.route('/api/purchase-orders', purchaseOrderRoutes)
app.route('/api/field-reports', fieldReportRoutes)
app.route('/api/support', supportRoutes)
app.route('/api/journal', journalRoutes)
app.route('/api/brand', brandRoutes)
app.route('/api/newsletter', newsletterRoutes)
app.route('/api/newsletter-campaigns', newsletterCampaignRoutes)
app.route('/api/marketing-leads', marketingLeadRoutes)
app.route('/api/customer-surveys', customerSurveyRoutes)
app.route('/api/moments', momentsRoutes)
app.route('/api/careers', careersRoutes)
app.route('/api/shop-customers', shopCustomerRoutes)
app.route('/api/customer-credits', customerCreditRoutes)
app.route('/api/reports', reportRoutes)
app.route('/api/crops', cropRoutes)
app.route('/api/livestock', livestockRoutes)
app.route('/api/sales', salesRoutes)
app.route('/api/products', productRoutes)
app.route('/api/customer-insights', customerInsightsRoutes)
app.route('/api/finance', financeRoutes)
app.route('/public/finance', publicFinanceInboundRoutes)
app.route('/api/traceability', traceabilityRoutes)
app.route('/api/assets', assetRoutes)
app.route('/api/maintenance', maintenanceRoutes)
app.route('/api/contractors', contractorRoutes)
app.route('/api/anomalies', anomalyRoutes)
app.route('/api/scanning', scanningRoutes)
app.route('/api/ai', aiRoutes)
app.route('/api/whatsapp', whatsappRoutes)
app.route('/api/telegram', telegramRoutes)
app.route('/api/paystack', paystackRoutes)
app.route('/public', publicRoutes)
app.route('/public/journal', publicJournalRoutes)
app.route('/public/brand', publicBrandRoutes)
app.route('/public/newsletter', publicNewsletterRoutes)
app.route('/public/leads', publicMarketingLeadRoutes)
app.route('/public/surveys', publicCustomerSurveyRoutes)
app.route('/public/moments', publicMomentsRoutes)
app.route('/public/careers', publicCareersRoutes)
app.route('/shop', customerShopRoutes)
app.route('/api/templates', templateRoutes)
app.route('/api/zones', zoneRoutes)
app.route('/api/users', userRoutes)
app.route('/api/roles', roleRoutes)
app.route('/api/permission-teams', permissionTeamRoutes)
app.route('/api/operation-guidelines', operationGuidelineRoutes)
app.route('/api/vault', vaultRoutes)
app.route('/api/events', eventRoutes)
app.route('/api/onboarding', onboardingRoutes)
app.route('/api/billing', billingRoutes)
app.route('/api/day-close', dayCloseRoutes)
app.route('/api/alerts', alertsRoutes)
app.route('/api/advisory', advisoryRoutes)
app.route('/api/exports', exportRoutes)
app.route('/api/consent', consentRoutes)
app.route('/api', privacyRoutes)
// health / ready / version / system-status - no /api prefix for liveness probes
app.route('/', systemRoutes)

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  if (err.message === 'FORBIDDEN') {
    logSecurityEvent('forbidden_access', {
      path: c.req.path,
      method: c.req.method,
      ip: clientIpFromHeaders((name) => c.req.header(name)) ?? 'local',
    })
    return c.json({ error: 'Forbidden' }, 403)
  }
  const message = err instanceof Error ? err.message : String(err)
  console.error('Unhandled error:', message)
  logApiEvent('unhandled_error', {
    requestId: c.res.headers.get('x-request-id') ?? c.req.header('x-request-id') ?? 'unknown',
    path: c.req.path,
    method: c.req.method,
    status: c.res.status,
    message,
    deploymentSha: deploymentSha(),
  })
  if (process.env.NODE_ENV === 'development' && err instanceof Error && err.stack) {
    console.error(err.stack)
  }
  return c.json({ error: 'Internal server error' }, 500)
})

const host = process.env.API_HOST ?? '127.0.0.1'
const port = Number(process.env.API_PORT ?? 3000)

if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  console.warn('WARNING: CORS_ORIGIN is not set in production')
}

if (
  process.env.NODE_ENV === 'production' &&
  (process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_CUSTOMER_ACCESS_TOKEN) &&
  !process.env.META_APP_SECRET?.trim()
) {
  console.warn(
    'WARNING: WhatsApp is configured without META_APP_SECRET - inbound webhook signatures are NOT verified. Set META_APP_SECRET (Meta app dashboard → App settings → Basic).',
  )
}

if (process.env.NODE_ENV === 'production') {
  const missingNewsletterConfig = newsletterConfigMissing()
  if (missingNewsletterConfig.length) {
    console.warn(
      `WARNING: Newsletter delivery/sync is not fully configured. Missing: ${missingNewsletterConfig.join(', ')}. Public signup will retain pending records but return 503 when confirmation cannot be sent.`,
    )
  }
}

console.log(`Trovara OS API listening on http://${host}:${port}`)

serve({ fetch: app.fetch, hostname: host, port })

void ensureBreakGlassOwner()
  .then((result) => {
    if (result === 'created') {
      console.log(`Break-glass owner provisioned (${getBreakGlassEmail()})`)
    } else if (result === 'skipped' && !getBreakGlassPasswordFromEnv()) {
      console.warn('BREAK_GLASS_PASSWORD is unset - emergency owner login will not work')
    } else if (result === 'skipped') {
      console.warn(
        'Break-glass owner not provisioned yet (no farm row). Create the farm, then restart the API or sign in once as the break-glass email.',
      )
    }
    if (process.env.BREAK_GLASS_ENABLED === 'true') {
      console.warn(
        'WARNING: BREAK_GLASS_ENABLED=true — env break-glass login is armed (single-factor until TOTP is enabled on that account). Disarm after use: unset BREAK_GLASS_ENABLED and restart.',
      )
      logSecurityEvent('break_glass_armed', {
        email: getBreakGlassEmail(),
        source: 'api_boot',
      })
    } else if (getBreakGlassPasswordFromEnv()) {
      console.log(
        'Break-glass env login is disarmed (BREAK_GLASS_ENABLED unset). Password is ready; set BREAK_GLASS_ENABLED=true only for emergency recovery.',
      )
      logSecurityEvent('break_glass_disarmed', {
        email: getBreakGlassEmail(),
        source: 'api_boot',
      })
    }
  })
  .catch((err) => {
    console.error('Failed to ensure break-glass owner:', err instanceof Error ? err.message : err)
  })

// Start the Telegram butler's long-poll loop (no-op unless TELEGRAM_BOT_TOKEN set
// and TELEGRAM_MODE is polling). Webhook mode uses /api/telegram/webhook instead.
startTelegramPolling()
// Start the customer order bot's long-poll loop (no-op unless
// TELEGRAM_CUSTOMER_BOT_TOKEN set). Webhook mode uses /api/telegram/customer/webhook.
startCustomerTelegramPolling()
void resumeBrandAssetProcessing().catch((err) => {
  console.error(
    'Failed to resume brand asset processing:',
    err instanceof Error ? err.message : err,
  )
})
