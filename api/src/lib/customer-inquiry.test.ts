import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'
  process.env.PUBLIC_SHOP_URL = 'https://shop.trovara.farm'
  process.env.PUBLIC_MARKETING_URL = 'https://www.trovara.farm'
})

// With no LLM configured, answerCustomerInquiry returns the deterministic
// keyword answer, which is the product matcher under test here.
vi.mock('./llm.js', () => ({
  isLlmConfigured: () => false,
  completeChat: vi.fn(),
}))

import {
  answerCustomerInquiry,
  canonicalizeForSuggestion,
  DEFAULT_SUGGESTIONS,
  isCustomerProgrammeQuestion,
  normalizeQuestion,
} from './customer-inquiry.js'
import type { CatalogItem } from './customer-cart.js'

describe('normalizeQuestion', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeQuestion('  How much is plantain?? ')).toBe('how much is plantain')
  })
})

describe('canonicalizeForSuggestion', () => {
  it('maps typo-ridden customer phrasing to curated labels', () => {
    expect(canonicalizeForSuggestion('were r u located??')).toBe('Where are you located?')
    expect(canonicalizeForSuggestion('how much doe plantain cost')).toBe('How much is plantain?')
    expect(canonicalizeForSuggestion('wat u sell')).toBe('What do you sell?')
    expect(canonicalizeForSuggestion('do u deliver to abuja')).toBe('How does delivery work?')
    expect(canonicalizeForSuggestion('can i pay by transfer')).toBe('How do I pay?')
    expect(canonicalizeForSuggestion('how much are eggs')).toBe('What are your prices?')
    expect(canonicalizeForSuggestion('how do my credits work')).toBe(
      'How do Trovara Credits work?',
    )
    expect(canonicalizeForSuggestion('where is your online shop')).toBe(
      'Where is the online shop?',
    )
  })

  it('returns DEFAULT_SUGGESTIONS labels for punct/case variants', () => {
    for (const label of DEFAULT_SUGGESTIONS) {
      expect(canonicalizeForSuggestion(label.toLowerCase())).toBe(label)
    }
  })

  it('falls back to trimmed original when topic is unknown', () => {
    expect(canonicalizeForSuggestion('  do you grow cacao?  ')).toBe('do you grow cacao?')
  })
})

describe('customer programme answers', () => {
  const base = {
    farmName: 'Trovara Farm',
    farmLocation: 'Ogun',
    catalog: [] as CatalogItem[],
  }

  it.each([
    'How do Trovara Credits work?',
    'What is my referral code?',
    'Where is the shop?',
    'Can I make a recurring basket?',
    'Where is the survey?',
  ])('recognizes programme question %j', (question) => {
    expect(isCustomerProgrammeQuestion(question)).toBe(true)
  })

  it('explains credits and sends an unlinked customer to the shop', async () => {
    const answer = await answerCustomerInquiry({ ...base, question: 'How do credits work?' })
    expect(answer.reply).toContain('2,000')
    expect(answer.reply).toContain('not cash')
    expect(answer.reply).toContain('https://shop.trovara.farm')
  })

  it('returns a linked customer referral code, link, and counts', async () => {
    const answer = await answerCustomerInquiry({
      ...base,
      question: 'What is my referral code?',
      rewards: {
        balance: 2_000,
        referralCode: 'TRVTEST123',
        referralUrl: 'https://www.trovara.farm/survey?ref=TRVTEST123',
        referralCount: 2,
        referralPendingCount: 1,
        referralActivatedCount: 1,
        welcomeCredits: 2_000,
        welcomeCreditAwarded: true,
        referralCredits: 1_000,
        referralRefundWindowDays: 2,
      },
    })
    expect(answer.reply).toContain('TRVTEST123')
    expect(answer.reply).toContain('survey?ref=TRVTEST123')
    expect(answer.reply).toContain('2 referred surveys (1 pending, 1 activated)')
    expect(answer.reply).toContain('1,000 Trovara Credits')
  })

  it('explains browser baskets without claiming the bot can see an unfinished one', async () => {
    const answer = await answerCustomerInquiry({
      ...base,
      question: 'Can you see my basket?',
    })
    expect(answer.reply).toContain('Recurring baskets are optional')
    expect(answer.reply).toContain('cannot see an unfinished browser basket')
  })

  it('links the customer survey and separates it from current availability', async () => {
    const answer = await answerCustomerInquiry({
      ...base,
      question: 'Which products are in your survey?',
    })
    expect(answer.reply).toContain('https://www.trovara.farm/survey')
    expect(answer.reply).toContain('Current products and availability')
    expect(answer.reply).toContain('https://shop.trovara.farm')
  })
})

describe('deterministic product matching', () => {
  const catalog: CatalogItem[] = [
    { id: 'p1', name: 'Noix de Coco', unit: 'kg', priceKobo: 250000, currency: 'NGN' },
    { id: 'p2', name: 'Plantain', unit: 'bunch', priceKobo: 180000, currency: 'NGN' },
  ]

  const ask = async (question: string) =>
    (await answerCustomerInquiry({
      farmName: 'Trovara Farm',
      farmLocation: 'Ogun',
      catalog,
      question,
    })).reply

  it('matches a product across accents, case and punctuation', async () => {
    for (const question of [
      'how much is noix de coco?',
      'How much is NOIX DE COCO',
      'combien coûte la noix de côco ?',
    ]) {
      expect(await ask(question)).toContain('Noix de Coco')
    }
  })

  it('includes the online shop in product answers', async () => {
    expect(await ask('how much is plantain?')).toContain('https://shop.trovara.farm')
  })

  it('quotes the stored spelling back, not the folded form', async () => {
    const reply = await ask('price of noix de coco')
    expect(reply).toContain('Noix de Coco')
    expect(reply).not.toContain('noix de coco -')
  })

  it('does not match an unrelated question', async () => {
    const reply = await ask('where are you located')
    expect(reply).not.toContain('Noix de Coco')
    expect(reply).not.toContain('Plantain')
  })

  // Folding a punctuation-only name yields '', and every string contains '',
  // so without a guard this product would answer every question asked.
  it('ignores a catalog entry whose name folds to nothing', async () => {
    const reply = (
      await answerCustomerInquiry({
        farmName: 'Trovara Farm',
        farmLocation: 'Ogun',
        catalog: [{ id: 'p3', name: '---', unit: 'kg', priceKobo: 100, currency: 'NGN' }],
        question: 'where are you located',
      })
    ).reply
    expect(reply).not.toContain('---')
  })
})
