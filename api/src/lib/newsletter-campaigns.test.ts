import { describe, expect, it } from 'vitest'
import { newsletterCampaignEmailContent } from './newsletter-campaigns.js'

const baseCampaign = {
  subject: 'Fresh plantain is ready',
  previewText: 'The harvest is now available.',
  bodyText: 'You asked us to let you know.\nOrders are now open.',
  campaignType: 'product_availability',
  ctaLabel: 'View plantain',
  ctaUrl: 'https://www.trovara.farm/products/plantain',
} as const

describe('newsletter campaign email content', () => {
  it('adds a Resend-managed unsubscribe link to newsletter broadcasts', () => {
    const content = newsletterCampaignEmailContent(
      { ...baseCampaign, campaignType: 'marketing' },
      { newsletter: true },
    )
    expect(content.html).toContain('{{{RESEND_UNSUBSCRIBE_URL}}}')
    expect(content.text).toContain('Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}')
  })

  it('keeps requested product availability follow-up separate from newsletter unsubscribe', () => {
    const content = newsletterCampaignEmailContent(baseCampaign)
    expect(content.html).not.toContain('RESEND_UNSUBSCRIBE_URL')
    expect(content.text).not.toContain('Unsubscribe:')
    expect(content.html).toContain('View plantain')
  })

  it('escapes message content instead of accepting campaign HTML', () => {
    const content = newsletterCampaignEmailContent({
      ...baseCampaign,
      bodyText: '<script>alert("x")</script>',
    })
    expect(content.html).not.toContain('<script>')
    expect(content.html).toContain('&lt;script&gt;')
  })
})
