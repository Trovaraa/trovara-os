/**
 * Canonical Trovara email layout — dark header card matching marketing-lead alerts.
 * All transactional mail (shop, newsletter, staff alerts, orders) should use this.
 */

export function escapeEmailHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export type EmailFooterVariant = 'default' | 'shop' | 'newsletter' | 'transactional' | 'staff'
export type EmailBrandVariant = 'os' | 'farm'

export type EmailFooterOptions = {
  variant?: EmailFooterVariant
  /** When set (newsletter), utility line includes Unsubscribe. */
  unsubscribeUrl?: string
  /** Extra utility links after Privacy (label + absolute URL). */
  extraUtilityLinks?: Array<{ label: string; href: string }>
}

export type EmailLayoutOptions = {
  preheader: string
  /** Browser / client title */
  documentTitle?: string
  /** Pill above the headline (uppercase in UI) */
  badge?: string
  /** Main headline */
  headline: string
  /** Supporting sentence under the headline */
  intro?: string
  /** Main body HTML (tables, paragraphs, callouts) */
  body?: string
  cta?: { href: string; label: string }
  /**
   * Raw HTML footer. Prefer {@link emailFooterHtml} / `footerVariant`.
   * When omitted, a structured Trovara footer is used.
   */
  footer?: string
  footerVariant?: EmailFooterVariant
  unsubscribeUrl?: string
  /** Public/customer mail uses FARM; internal staff mail keeps FARM OS. */
  brandVariant?: EmailBrandVariant
}

const PRIVACY_URL = 'https://www.trovara.farm/privacy'

const SOCIAL_LINKS = [
  { label: 'Facebook', href: 'https://www.facebook.com/trovarafarm' },
  { label: 'Instagram', href: 'https://www.instagram.com/trovara_farm/' },
  { label: 'TikTok', href: 'https://www.tiktok.com/@trovarafarm' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/trovarafarm/' },
] as const

export const TROVARA_CREDITS_MARK_URL =
  'https://www.trovara.farm/brand/trovara-credits-symbol.png'

/** Absolute PNG (no apex→www redirect). Gmail often blocks redirected image URLs. */
export const EMAIL_BRAND_MARK_URL = 'https://www.trovara.farm/brand/trovara-mark.png'

/**
 * Structured email footer: social links, copyright, and context utility links.
 * Matches the Coconoto-style layout adapted for Trovara.
 */
export function emailFooterHtml(options: EmailFooterOptions = {}): string {
  const variant = options.variant ?? 'default'
  const social = SOCIAL_LINKS.map((link, index) => {
    const sep =
      index < SOCIAL_LINKS.length - 1
        ? `<span style="color:#2f6b3b;padding:0 6px">·</span>`
        : ''
    return `<a href="${escapeEmailHtml(link.href)}" style="color:#2f6b3b;text-decoration:none;font-weight:700">${escapeEmailHtml(link.label)}</a>${sep}`
  }).join('')

  const utility: Array<{ label: string; href: string }> = []
  if (variant === 'newsletter' && options.unsubscribeUrl) {
    utility.push({ label: 'Unsubscribe', href: options.unsubscribeUrl })
  }
  if (variant !== 'staff') {
    utility.push({ label: 'Privacy', href: PRIVACY_URL })
  }
  for (const link of options.extraUtilityLinks ?? []) {
    utility.push(link)
  }

  const utilityHtml =
    utility.length > 0
      ? `<p style="margin:10px 0 0;color:#8a948c;font-size:11px;line-height:1.5">${utility
          .map((link, index) => {
            const sep =
              index < utility.length - 1
                ? `<span style="color:#b0b8b2;padding:0 5px">|</span>`
                : ''
            return `<a href="${escapeEmailHtml(link.href)}" style="color:#8a948c;text-decoration:none">${escapeEmailHtml(link.label)}</a>${sep}`
          })
          .join('')}</p>`
      : ''

  return `<p style="margin:0 0 8px;line-height:1.5">${social}</p>
<p style="margin:0;color:#8b6914;font-size:12px;font-weight:700;line-height:1.5">© Trovara Farm | All Rights Reserved</p>
${utilityHtml}`
}

function brandHeaderHtml(variant: EmailBrandVariant = 'os'): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0">
  <tr>
    <td style="padding-right:12px;vertical-align:middle">
      <img src="${EMAIL_BRAND_MARK_URL}" width="46" height="46" alt="Trovara" style="display:block;width:46px;height:46px;border:0;border-radius:9px;outline:none;text-decoration:none">
    </td>
    <td style="vertical-align:middle">
      <span style="display:block;color:#ffffff;font-size:19px;font-weight:800;letter-spacing:1.5px;line-height:1.1">TROVARA</span>
      <span style="display:block;margin-top:4px;color:#c5ce82;font-size:9px;font-weight:700;letter-spacing:3.5px;line-height:1">${variant === 'farm' ? 'FARM' : 'FARM OS'}</span>
    </td>
  </tr>
</table>`
}

export function emailButton(link: string, label: string): string {
  return `<p style="margin:28px 0 0">
  <a href="${escapeEmailHtml(link)}" style="display:inline-block;padding:13px 20px;background:#2f6b3b;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700">${escapeEmailHtml(label)}</a>
</p>`
}

/** Two-column detail table (label / value), matching enquiry emails. */
export function emailDetailRows(
  rows: Array<{ label: string; valueHtml: string; last?: boolean }>,
): string {
  const cells = rows
    .map((row, index) => {
      const isLast = row.last ?? index === rows.length - 1
      const border = isLast ? '' : 'border-bottom:1px solid #e8eee5;'
      return `<tr>
  <td style="width:34%;padding:13px 16px;${border}color:#718075;font-size:12px;font-weight:700;text-transform:uppercase">${escapeEmailHtml(row.label)}</td>
  <td style="padding:13px 16px;${border}color:#28382f;font-size:14px;font-weight:700">${row.valueHtml}</td>
</tr>`
    })
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e9df;border-radius:10px">${cells}</table>`
}

export function emailCallout(label: string, bodyHtml: string): string {
  return `<div style="margin:24px 0 0;padding:18px 20px;background:#f4f7f2;border-left:4px solid #889058;border-radius:0 8px 8px 0">
  <p style="margin:0 0 8px;color:#617064;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase">${escapeEmailHtml(label)}</p>
  <p style="margin:0;color:#28382f;font-size:15px;line-height:1.65">${bodyHtml}</p>
</div>`
}

function trovaraCreditsWelcomeCard(claimUrl: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#123a27;border:2px solid #d4af57;border-radius:22px;overflow:hidden">
  <tr>
    <td style="padding:28px 28px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding-right:12px;vertical-align:middle">
            <img src="${TROVARA_CREDITS_MARK_URL}" width="54" height="54" alt="Trovara Credits" style="display:block;width:54px;height:54px;border:0;outline:none;text-decoration:none">
          </td>
          <td style="vertical-align:middle">
            <span style="display:block;color:#ffffff;font-size:19px;font-weight:800;letter-spacing:1.4px;line-height:1.1">TROVARA</span>
            <span style="display:block;margin-top:4px;color:#d4af57;font-size:10px;font-weight:800;letter-spacing:2.4px;line-height:1">CREDITS</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:22px 28px 32px">
      <p style="margin:0;color:#ffffff;font-size:52px;font-weight:900;line-height:1">2,000</p>
      <p style="margin:8px 0 0;color:#d4af57;font-size:13px;font-weight:800;letter-spacing:1.5px">WELCOME CREDITS</p>
      <p style="margin:26px 0 0">
        <a href="${escapeEmailHtml(claimUrl)}" style="display:inline-block;padding:14px 24px;background:#ffffff;color:#123a27;text-decoration:none;border-radius:999px;font-size:13px;font-weight:800;letter-spacing:.4px">CLAIM MY CREDITS</a>
      </p>
    </td>
  </tr>
</table>`
}

/**
 * Dark-header Trovara card (TROVARA / FARM OS). Prefer this over ad-hoc HTML.
 * @deprecated Prefer {@link emailLayout} — kept as a thin alias for older call sites.
 */
export function emailFrame(preheader: string, body: string, options?: { footer?: string; title?: string }): string {
  return emailLayout({
    preheader,
    documentTitle: options?.title,
    headline: '',
    body,
    footer: options?.footer,
  })
}

export function emailLayout(options: EmailLayoutOptions): string {
  const title = escapeEmailHtml(options.documentTitle ?? (options.headline || 'Trovara'))
  const badge = options.badge
    ? `<span style="display:inline-block;padding:6px 10px;background:#edf4e9;color:#276338;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:1px">${escapeEmailHtml(options.badge)}</span>`
    : ''
  const headline = options.headline
    ? `<h1 style="margin:${badge ? '16px' : '0'} 0 8px;color:#18311f;font-size:27px;line-height:1.25">${escapeEmailHtml(options.headline)}</h1>`
    : ''
  const intro = options.intro
    ? `<p style="margin:0 0 26px;color:#617064;font-size:15px;line-height:1.6">${escapeEmailHtml(options.intro)}</p>`
    : options.headline
      ? `<div style="margin:0 0 18px"></div>`
      : ''
  const body = options.body ?? ''
  const cta = options.cta ? emailButton(options.cta.href, options.cta.label) : ''
  const footer =
    options.footer ??
    emailFooterHtml({
      variant: options.footerVariant ?? 'default',
      unsubscribeUrl: options.unsubscribeUrl,
    })

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head>
<body style="margin:0;background:#f1f4ef;color:#28382f;font-family:Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden">${escapeEmailHtml(options.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4ef">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid #dfe8dc;border-radius:14px;overflow:hidden">
          <tr>
            <td style="padding:24px 28px;background:#18311f">
              ${brandHeaderHtml(options.brandVariant)}
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px">
              ${badge}
              ${headline}
              ${intro}
              ${body}
              ${cta}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px;background:#f8faf7;border-top:1px solid #e2e9df;color:#718075;font-size:12px;line-height:1.5;text-align:center">
              ${footer}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export function shopVerifyEmailContent(
  name: string,
  verifyUrl: string,
): { subject: string; text: string; html: string } {
  return {
    subject: 'Verify your Trovara shop account',
    text: `Hi ${name},\n\nVerify your email to complete your Trovara Farm shop registration:\n${verifyUrl}\n\nThis link expires in 48 hours. If you did not create an account, you can ignore this email.`,
    html: emailLayout({
      preheader: 'Verify your Trovara Farm shop email to finish registration.',
      documentTitle: 'Verify your email · Trovara Farm',
      badge: 'SHOP ACCOUNT',
      headline: `Confirm your email, ${name}`,
      intro: 'Thanks for creating a Trovara Farm shop account. Confirm your email so you can sign in, track orders, and get harvest updates.',
      body: `<p style="margin:0;color:#617064;font-size:14px;line-height:1.5">This link expires in 48 hours. If you did not create an account, you can ignore this email.</p>`,
      cta: { href: verifyUrl, label: 'Verify email' },
      footerVariant: 'shop',
      brandVariant: 'farm',
    }),
  }
}

export function trovaraCreditInvitationEmailContent(
  name: string,
  claimUrl: string,
): { subject: string; text: string; html: string } {
  const firstName = name.trim().split(/\s+/)[0] || 'there'
  const text = [
    `Hi ${firstName},`,
    '',
    'Because you asked Trovara Farm to stay in touch by filling our survey, you are eligible for Trovara Credits.',
    '',
    'Claim your Trovara Farm account to receive 2,000 Trovara Credits and unlock your personal referral link.',
    '',
    claimUrl,
    '',
    "P.S. Get 1,000 more Trovara Credits when your referral completes their first eligible Trovara Farm purchase. The credits become available after the purchase passes its refund period without a refund.",
    'P.P.S. Trovara Credits can only be used to buy eligible products sold by Trovara Farm. They are promotional credits, not cash.',
  ].join('\n')

  return {
    subject: 'Trovara Farm account invitation',
    text,
    html: emailLayout({
      preheader: 'An invitation to create your Trovara Farm account.',
      documentTitle: 'Your Trovara Credits are ready',
      badge: 'TROVARA CREDITS',
      headline: `Your 2,000 Trovara Credits are ready, ${firstName}`,
      intro:
        'Because you asked Trovara Farm to stay in touch by filling our survey, you are eligible for Trovara Credits.',
      body: `${trovaraCreditsWelcomeCard(claimUrl)}
<p style="margin:24px 0 0;color:#28382f;font-size:15px;line-height:1.65">Claim your Trovara Farm account and unlock your personal referral link.</p>
<p style="margin:24px 0 0;color:#617064;font-size:13px;line-height:1.6"><strong>P.S.</strong> Get 1,000 more Trovara Credits when your referral completes their first eligible Trovara Farm purchase. The credits become available after the purchase passes its refund period without a refund.</p>
<p style="margin:8px 0 0;color:#617064;font-size:13px;line-height:1.6"><strong>P.P.S.</strong> Trovara Credits can only be used to buy eligible products sold by Trovara Farm. They are promotional credits, not cash.</p>`,
      footerVariant: 'shop',
      brandVariant: 'farm',
    }),
  }
}

export function trovaraCreditsReadyEmailContent(
  name: string,
  accountUrl: string,
): { subject: string; text: string; html: string } {
  const firstName = name.trim().split(/\s+/)[0] || 'there'
  return {
    subject: '2,000 Trovara Credits have been added to your account',
    text: `Hi ${firstName},\n\nWe added 2,000 Trovara Credits to your Trovara Farm account. Sign in to see your balance and personal referral link:\n${accountUrl}\n\nP.S. Get 1,000 more Trovara Credits when your referral completes their first eligible Trovara Farm purchase. The credits become available after the purchase passes its refund period without a refund.\nP.P.S. Trovara Credits can only be used to buy eligible products sold by Trovara Farm. They are promotional credits, not cash.`,
    html: emailLayout({
      preheader: 'Your Trovara Credits are now in your shop account.',
      documentTitle: 'Trovara Credits added',
      badge: 'TROVARA CREDITS',
      headline: `2,000 Trovara Credits added, ${firstName}`,
      intro: 'Your Trovara Farm shop account now includes your welcome Trovara Credits.',
      body: `<p style="margin:0;color:#28382f;font-size:15px;line-height:1.65">Sign in to see your balance and personal referral link.</p>
<p style="margin:24px 0 0;color:#617064;font-size:13px;line-height:1.6"><strong>P.S.</strong> Get 1,000 more Trovara Credits when your referral completes their first eligible Trovara Farm purchase. The credits become available after the purchase passes its refund period without a refund.</p>
<p style="margin:8px 0 0;color:#617064;font-size:13px;line-height:1.6"><strong>P.P.S.</strong> Trovara Credits can only be used to buy eligible products sold by Trovara Farm. They are promotional credits, not cash.</p>`,
      cta: { href: accountUrl, label: 'Open my account' },
      footerVariant: 'shop',
      brandVariant: 'farm',
    }),
  }
}

export function shopResetPasswordEmailContent(
  name: string,
  resetUrl: string,
): { subject: string; text: string; html: string } {
  return {
    subject: 'Reset your Trovara shop password',
    text: `Hi ${name},\n\nReset your Trovara Farm shop password within one hour:\n${resetUrl}\n\nIf you did not request this, you can ignore this message.`,
    html: emailLayout({
      preheader: 'Reset your Trovara Farm shop password.',
      documentTitle: 'Reset password · Trovara Farm',
      badge: 'PASSWORD RESET',
      headline: `Reset your password, ${name}`,
      intro: 'We received a request to reset the password for your Trovara Farm shop account. Use the button below within one hour.',
      body: `<p style="margin:0;color:#617064;font-size:14px;line-height:1.5">If you did not request this, you can ignore this message. Your password will stay the same.</p>`,
      cta: { href: resetUrl, label: 'Reset password' },
      footerVariant: 'shop',
      brandVariant: 'farm',
    }),
  }
}

export function newsletterConfirmEmailContent(
  name: string,
  confirmUrl: string,
): { subject: string; text: string; html: string } {
  return {
    subject: 'Confirm your Trovara newsletter subscription',
    text: `Hi ${name},\n\nConfirm your Trovara newsletter subscription:\n${confirmUrl}\n\nThis link expires in 48 hours. If you did not request this, ignore this email.`,
    html: emailLayout({
      preheader: 'Confirm your subscription to Trovara updates.',
      documentTitle: 'Confirm subscription · Trovara Farm',
      badge: 'NEWSLETTER',
      headline: `One last step, ${name}`,
      intro: 'Please confirm that you want to receive Trovara farm stories and seasonal updates.',
      body: `<p style="margin:0;color:#617064;font-size:14px;line-height:1.5">This link expires in 48 hours. If you did not request this, you can ignore this email.</p>`,
      cta: { href: confirmUrl, label: 'Confirm subscription' },
      footerVariant: 'newsletter',
      brandVariant: 'farm',
    }),
  }
}

export function newsletterWelcomeEmailContent(
  name: string,
  unsubscribeUrl: string,
): { subject: string; text: string; html: string } {
  return {
    subject: 'Welcome to the Trovara newsletter',
    text: `Hi ${name},\n\nYour Trovara newsletter subscription is confirmed.\n\nUnsubscribe at any time: ${unsubscribeUrl}`,
    html: emailLayout({
      preheader: 'Welcome to Trovara farm stories and seasonal updates.',
      documentTitle: 'Welcome · Trovara Farm',
      badge: 'NEWSLETTER',
      headline: `Welcome, ${name}`,
      intro:
        'Your subscription is confirmed. We look forward to sharing what is growing, what is in season, and life around the farm.',
      body: `<p style="margin:0;color:#617064;font-size:13px;line-height:1.5">You can <a href="${escapeEmailHtml(unsubscribeUrl)}" style="color:#276338;font-weight:700;text-decoration:none">unsubscribe at any time</a>.</p>`,
      footerVariant: 'newsletter',
      unsubscribeUrl,
      brandVariant: 'farm',
    }),
  }
}

export function staffPasswordResetEmailContent(resetUrl: string): {
  subject: string
  text: string
  html: string
} {
  return {
    subject: 'Reset your Trovara OS password',
    text: `Use this link to reset your password. It expires in one hour:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this message.`,
    html: emailLayout({
      preheader: 'Reset your Trovara OS password.',
      documentTitle: 'Reset password · Trovara OS',
      badge: 'SECURITY',
      headline: 'Reset your password',
      intro: 'Use the button below to choose a new Trovara OS password. This link expires in one hour.',
      body: `<p style="margin:0;color:#617064;font-size:14px;line-height:1.5">If you did not request this, you can ignore this message.</p>`,
      cta: { href: resetUrl, label: 'Reset password' },
      footerVariant: 'staff',
    }),
  }
}

export function customerOrderEmailContent(params: {
  name: string
  reference: string
  accountUrl: string
  traceabilityUrl?: string | null
}): { subject: string; text: string; html: string } {
  const rows = [
    { label: 'Order', valueHtml: escapeEmailHtml(params.reference) },
    {
      label: 'Account',
      valueHtml: `<a href="${escapeEmailHtml(params.accountUrl)}" style="color:#276338;text-decoration:none;font-weight:700">Open shop account</a>`,
    },
  ]
  if (params.traceabilityUrl) {
    rows.push({
      label: 'Lot',
      valueHtml: `<a href="${escapeEmailHtml(params.traceabilityUrl)}" style="color:#276338;text-decoration:none;font-weight:700">View traceability</a>`,
    })
  }
  const textLines = [
    `Hello ${params.name},`,
    '',
    `We received your Trovara order ${params.reference}.`,
    `Track your order: ${params.accountUrl}`,
    ...(params.traceabilityUrl
      ? [`Traceability record (available after farm verification): ${params.traceabilityUrl}`]
      : []),
    '',
    'You can also track this order through your linked WhatsApp or Telegram account.',
  ]
  return {
    subject: `Trovara order ${params.reference}`,
    text: textLines.join('\n'),
    html: emailLayout({
      preheader: `We received your Trovara order ${params.reference}.`,
      documentTitle: `Order ${params.reference} · Trovara Farm`,
      badge: 'ORDER CONFIRMED',
      headline: `Thanks, ${params.name}`,
      intro: `We received your Trovara order ${params.reference}. Track it from your shop account anytime.`,
      body: emailDetailRows(rows),
      cta: { href: params.accountUrl, label: 'View shop account' },
      footerVariant: 'shop',
    }),
  }
}

export function marketingLeadEmailContent(params: {
  badge: string
  headline: string
  intro: string
  preheader: string
  rows: Array<{ label: string; valueHtml: string }>
  messageHtml?: string
  ctaHref: string
  ctaLabel?: string
  footer?: string
}): string {
  return emailLayout({
    preheader: params.preheader,
    documentTitle: params.headline,
    badge: params.badge,
    headline: params.headline,
    intro: params.intro,
    body:
      emailDetailRows(params.rows) +
      (params.messageHtml ? emailCallout('Message', params.messageHtml) : ''),
    cta: { href: params.ctaHref, label: params.ctaLabel ?? 'Open in Trovara OS' },
    footer: params.footer,
    footerVariant: 'staff',
  })
}

/** Auto-ack after Finance approves an inbound invoice email. */
export function financeInboundApprovalAckEmailContent(params: {
  senderName?: string | null
  subject?: string | null
}): { subject: string; text: string; html: string } {
  const greetingName = params.senderName?.trim() || null
  const greeting = greetingName ? `Hi ${greetingName},` : 'Hello,'
  const invoiceLine = params.subject?.trim()
    ? `We approved your invoice email (“${params.subject.trim()}”) in Trovara Finance.`
    : 'We approved your invoice email in Trovara Finance.'
  const subject = params.subject?.trim()
    ? `Re: ${params.subject.trim()}`
    : 'We received your invoice — Trovara Finance'
  const text = [
    greeting,
    '',
    'Thank you for your email. We have received it and recorded your invoice.',
    invoiceLine,
    'Our Finance team will get in touch if anything else is needed.',
    '',
    'Best regards,',
    'The Trovara Finance Team',
    'finance@trovara.farm · www.trovara.farm',
  ].join('\n')
  return {
    subject,
    text,
    html: emailLayout({
      preheader: 'We received your invoice and will follow up if needed.',
      documentTitle: 'Invoice received · Trovara Finance',
      badge: 'FINANCE',
      headline: 'We received your invoice',
      intro: `${greeting} Thank you for your email.`,
      body: `<p style="margin:0 0 12px 0;color:#28382f;font-size:15px;line-height:1.65">${escapeEmailHtml(invoiceLine)}</p><p style="margin:0;color:#28382f;font-size:15px;line-height:1.65">Our Finance team will get in touch if anything else is needed.</p>`,
      footerVariant: 'transactional',
    }),
  }
}
