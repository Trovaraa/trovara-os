import { describe, expect, it } from 'vitest'
import { resolveTalentEmailIdentity as resolve } from './talent-identity.js'

const header = (name = 'Ada Example', email = 'ada@example.com') => `============ Forwarded message ============\nFrom: ${name} <${email}>\nTo : Info Trovara<info@trovara.farm>\nDate: Thu, 10 Sep 2026 18:53:46 +0100\nSubject: Application\n============ Forwarded message ============\nCV attached.`
const forwarded = (body: string, subject = 'Fwd: Application') => resolve({ senderName: 'Info Trovara', senderEmail: 'info@trovara.farm', subject, body })
describe('Forwarded applicant identity', () => {
  it('reads the original Zoho sender instead of Trovara or its signature', () => {
    expect(forwarded(header() + '\ninfo@trovara.farm')).toMatchObject({ name: 'Ada Example', email: 'ada@example.com', forwarded: true })
  })
  it('accepts Gmail forwarded headers and Outlook From/Sent/To/Subject headers', () => {
    expect(forwarded(header().replaceAll('============ Forwarded message ============', '---------- Forwarded message ---------'))).toMatchObject({ email: 'ada@example.com' })
    expect(forwarded('From: Ada Example <ada@example.com>\nSent: Thursday\nTo: info@trovara.farm\nSubject: Application')).toMatchObject({ email: 'ada@example.com' })
  })
  it('keeps ordinary direct applicants unchanged', () => {
    expect(resolve({ senderName: 'Ada Example', senderEmail: 'ADA@example.com', subject: 'Application', body: 'CV attached' }))
      .toMatchObject({ name: 'Ada Example', email: 'ada@example.com', forwarded: false })
  })
  it('never substitutes a signature, shared mailbox or ambiguous nested sender', () => {
    for (const body of ['CV attached\ninfo@trovara.farm', header('Info', 'info@trovara.farm'), header() + '\n' + header('Other Person', 'other@example.com'),
      'From: Ada <ada@example.com>\nMy CV is attached', header('Ada', 'ada@example.com>, Other <other@example.com')]) {
      expect(forwarded(body).email).toBeNull()
    }
  })
  it('does not treat an internal sender as an applicant even without Fwd in the subject', () => {
    expect(forwarded('Please consider the attached CV', 'Application')).toMatchObject({ email: null, forwarded: true })
  })
})
