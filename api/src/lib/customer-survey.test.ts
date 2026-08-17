import { describe, expect, it } from 'vitest'
import {
  customerSurveySchema,
  parseCustomerSurvey,
  parseSurveyContact,
  presentSurveyAnswers,
} from './customer-survey.js'

function validSurvey(overrides: Record<string, unknown> = {}) {
  return {
    location: 'abeokuta',
    household: '3_4',
    buyPlaces: ['open_market', 'neighbourhood_shop'],
    frequency: 'weekly',
    frustrations: ['inconsistent_quality', 'unknown_source'],
    topFrustration: 'unknown_source',
    priorities: ['freshness', 'origin', 'consistent_quality'],
    products: ['eggs', 'plantain', 'palm_oil'],
    hardToGet: 'Good chicken that lasts more than a day.',
    sourceMatters: 'definitely',
    shopPreference: 'customise_basket',
    priceExpectation: '5_to_10',
    oneChange: 'I want to know where the food came from.',
    heardFrom: 'whatsapp',
    followUp: 'no',
    consent: true,
    ...overrides,
  }
}

describe('customer survey validation', () => {
  it('accepts a complete anonymous response', () => {
    const parsed = customerSurveySchema.safeParse(validSurvey())
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const record = parseCustomerSurvey(parsed.data)
    expect(record.followUp).toBe('no')
    expect(record.contact).toBeNull()
    expect(record.answers.topFrustration).toBe('unknown_source')
    expect(record.answers.locationOther).toBeNull()
  })

  it('fills the top frustration when only one problem is selected', () => {
    const parsed = customerSurveySchema.safeParse(
      validSurvey({
        frustrations: ['poor_delivery'],
        topFrustration: undefined,
      }),
    )
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parseCustomerSurvey(parsed.data).answers.topFrustration).toBe('poor_delivery')
  })

  it('requires a WhatsApp number or email when they want a follow-up', () => {
    const missing = customerSurveySchema.safeParse(validSurvey({ followUp: 'yes' }))
    expect(missing.success).toBe(false)

    const invalid = customerSurveySchema.safeParse(
      validSurvey({ followUp: 'maybe', contact: 'not-a-contact' }),
    )
    expect(invalid.success).toBe(false)

    const ok = customerSurveySchema.safeParse(
      validSurvey({ followUp: 'yes', name: 'Ada', contact: '08012345678' }),
    )
    expect(ok.success).toBe(true)
    if (!ok.success) return
    const record = parseCustomerSurvey(ok.data)
    expect(record.contact?.normalized).toBe('phone:+2348012345678')
    expect(record.name).toBe('Ada')
  })

  it('requires Other text only when Other is selected', () => {
    const missing = customerSurveySchema.safeParse(validSurvey({ location: 'other' }))
    expect(missing.success).toBe(false)

    const ok = customerSurveySchema.safeParse(
      validSurvey({ location: 'other', locationOther: 'Ibadan' }),
    )
    expect(ok.success).toBe(true)
    if (!ok.success) return
    expect(parseCustomerSurvey(ok.data).answers.locationOther).toBe('Ibadan')
  })

  it('rejects extra keys and more than three priorities', () => {
    expect(customerSurveySchema.safeParse(validSurvey({ extra: true })).success).toBe(false)
    expect(
      customerSurveySchema.safeParse(
        validSurvey({ priorities: ['price', 'freshness', 'taste', 'convenience'] }),
      ).success,
    ).toBe(false)
  })

  it('parses email and Nigerian phone contacts', () => {
    expect(parseSurveyContact('Ada@Example.com')?.normalized).toBe('email:ada@example.com')
    expect(parseSurveyContact('+234 801 234 5678')?.normalized).toBe('phone:+2348012345678')
    expect(parseSurveyContact('hello')).toBeNull()
  })

  it('presents answers with human labels', () => {
    const parsed = parseCustomerSurvey(customerSurveySchema.parse(validSurvey()))
    const rows = presentSurveyAnswers(parsed.answers)
    expect(rows.find((row) => row.key === 'location')?.value).toBe('Abeokuta')
    expect(rows.find((row) => row.key === 'sourceMatters')?.value).toBe('Definitely')
  })
})
