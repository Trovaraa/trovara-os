/** Source-backed suggestions only. A forwarding mailbox is never an applicant identity. */
export function resolveTalentEmailIdentity(input: { senderName?: string; senderEmail: string; subject: string; body: string }) {
  const senderEmail = input.senderEmail.trim().toLowerCase()
  const text = input.body.slice(0, 100_000).replace(/^\s*>\s?/gm, '')
  const marker = /^(?:[= -]*Forwarded message[= :-]*|Begin forwarded message:|[ -]*Original Message[ -]*)$/im
  const forwarded = /^(?:fw|fwd)\s*:/i.test(input.subject.trim()) || marker.test(text) || senderEmail.endsWith('@trovara.farm')
  if (!forwarded) return { name: input.senderName || senderEmail, email: senderEmail, forwarded: false, warning: null }

  // Accept one explicit header block, not an arbitrary address in a signature/CV.
  // Nested forwards or multiple From headers are ambiguous and require human review.
  const start = text.search(marker)
  const forwardedText = start >= 0 ? text.slice(start) : text
  const fromLines = [...forwardedText.matchAll(/^From\s*:\s*(.+)$/gim)]
  let name = 'Forwarded application — review identity'
  let email: string | null = null
  if (fromLines.length === 1) {
    const line = fromLines[0]
    const header = forwardedText.slice(line.index, line.index! + 2000).split(/\r?\n/).slice(0, 12).join('\n')
    const address = line[1].trim().match(/^(?:([^<>]*)\s*<([^<>\s]+@[^<>\s]+)>|([^<>\s]+@[^<>\s]+))\s*$/)
    const originalEmail = (address?.[2] || address?.[3] || '').toLowerCase()
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(originalEmail) && !originalEmail.endsWith('@trovara.farm') &&
      /^To\s*:/im.test(header) && /^(?:Date|Sent)\s*:/im.test(header) && /^Subject\s*:/im.test(header)) {
      email = originalEmail
      name = address?.[1]?.trim().replace(/^['"]|['"]$/g, '') || email
    }
  }
  return { name: name.slice(0, 200), email, forwarded: true,
    warning: email ? 'Forwarded applicant details are unverified. Check the original email and CV; this import is not automatically linked to another candidate.'
      : 'The original applicant could not be identified unambiguously. The forwarding mailbox was not used as the applicant. Review the original email/CV.' }
}
