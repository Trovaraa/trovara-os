import { describe, expect, it } from 'vitest'
import {
  EMAIL_BRAND_MARK_URL,
  emailLayout,
  marketingLeadEmailContent,
  shopResetPasswordEmailContent,
  shopVerifyEmailContent,
} from './email-template.js'

describe('email-template (canonical FARM OS card)', () => {
  it('uses the dark header Trovara / FARM OS chrome with a non-redirecting mark URL', () => {
    const html = emailLayout({
      preheader: 'pre',
      badge: 'TEST',
      headline: 'Hello',
      intro: 'Intro copy',
      body: '<p>Body</p>',
    })
    expect(html).toContain(EMAIL_BRAND_MARK_URL)
    expect(html).not.toContain('https://trovara.farm/brand/')
    expect(html).toContain('TROVARA')
    expect(html).toContain('FARM OS')
    expect(html).toContain('background:#18311f')
    expect(html).toContain('alt="Trovara"')
    expect(html).toContain('TEST')
    expect(html).toContain('Hello')
    expect(html).toContain('Body')
  })

  it('builds branded shop verify mail', () => {
    const mail = shopVerifyEmailContent('Ada Lovelace', 'https://trovara.farm/shop/verify-email?token=abc')
    expect(mail.html).toContain('FARM OS')
    expect(mail.html).toContain('SHOP ACCOUNT')
    expect(mail.html).toContain('Verify email')
    expect(mail.html).toContain('Ada Lovelace')
  })

  it('builds branded shop reset mail', () => {
    const mail = shopResetPasswordEmailContent('Ada', 'https://example.test/reset')
    expect(mail.html).toContain('PASSWORD RESET')
    expect(mail.html).toContain('#2f6b3b')
  })

  it('builds marketing-lead style content', () => {
    const html = marketingLeadEmailContent({
      badge: 'NEW WEBSITE ENQUIRY',
      headline: 'A new enquiry just came in',
      intro: 'Review the details.',
      preheader: 'Someone enquired',
      rows: [{ label: 'Name', valueHtml: 'Local Email Test' }],
      messageHtml: 'Testing delivery',
      ctaHref: 'https://os.trovara.farm/marketing-leads',
    })
    expect(html).toContain('NEW WEBSITE ENQUIRY')
    expect(html).toContain('Local Email Test')
    expect(html).toContain('Open in Trovara OS')
    expect(html).toContain('FARM OS')
  })
})
