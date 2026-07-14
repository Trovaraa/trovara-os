import { Hono } from 'hono'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAccessFinance } from '../lib/rbac.js'

export const billingRoutes = new Hono<{ Variables: AppVariables }>()

billingRoutes.use('*', authMiddleware)

/** SaaS billing placeholder — not active for single-farm laptop deploy */
billingRoutes.get('/status', async (c) => {
  const user = c.get('user')
  if (!canAccessFinance(user)) return c.json({ error: 'Forbidden' }, 403)

  return c.json({
    enabled: false,
    mode: 'single_farm',
    message: 'Multi-farm SaaS billing is not enabled. Trovara OS runs as a single-farm deployment on your laptop.',
    roadmap: {
      stripe: 'Connect Stripe account + webhook for subscriptions',
      plans: ['Starter (1 farm, 10 users)', 'Growth (3 farms)', 'Enterprise'],
      tenantSignup: 'Public signup wizard + farm provisioning',
      metering: 'Per-farm monthly fee or per-active-user pricing',
      ndpa: 'Nigeria NDPA consent + data processing agreement',
    },
    docs: 'docs/SAAS-BILLING.md',
  })
})

billingRoutes.post('/checkout', async (c) => {
  const user = c.get('user')
  if (!canAccessFinance(user)) return c.json({ error: 'Forbidden' }, 403)

  return c.json(
    {
      error: 'SaaS billing not configured',
      hint: 'See docs/SAAS-BILLING.md for steps to sell Trovara OS to other farms',
    },
    501,
  )
})
