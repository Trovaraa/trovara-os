import { describe, expect, it } from 'vitest'
import {
  EMAIL_BRAND_MARK_URL,
  emailFooterHtml,
  emailLayout,
  marketingLeadEmailContent,
  newsletterWelcomeEmailContent,
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
    expect(html).toContain('© Trovara Farm | All Rights Reserved')
    expect(html).toContain('instagram.com/trovara_farm')
    expect(html).toContain('Privacy')
  })

  it('builds a structured footer with social, copyright, and utility links', () => {
    const footer = emailFooterHtml({
      variant: 'newsletter',
      unsubscribeUrl: 'https://www.trovara.farm/newsletter/unsubscribe?token=abc',
    })
    expect(footer).toContain('Facebook')
    expect(footer).toContain('Instagram')
    expect(footer).toContain('LinkedIn')
    expect(footer).toContain('#2f6b3b')
    expect(footer).toContain('© Trovara Farm | All Rights Reserved')
    expect(footer).toContain('Unsubscribe')
    expect(footer).toContain('Privacy')
  })

  it('builds branded shop verify mail', () => {
    const mail = shopVerifyEmailContent('Ada Lovelace', 'https://trovara.farm/shop/verify-email?token=abc')
    expect(mail.html).toContain('FARM OS')
    expect(mail.html).toContain('SHOP ACCOUNT')
    expect(mail.html).toContain('Verify email')
    expect(mail.html).toContain('Ada Lovelace')
    expect(mail.html).toContain('© Trovara Farm | All Rights Reserved')
  })

  it('builds branded shop reset mail', () => {
    const mail = shopResetPasswordEmailContent('Ada', 'https://example.test/reset')
    expect(mail.html).toContain('PASSWORD RESET')
    expect(mail.html).toContain('#2f6b3b')
  })

  it('puts unsubscribe into the newsletter welcome footer', () => {
    const mail = newsletterWelcomeEmailContent('Ada', 'https://www.trovara.farm/newsletter/unsubscribe?token=xyz')
    expect(mail.html).toContain('Unsubscribe')
    expect(mail.html).toContain('token=xyz')
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
