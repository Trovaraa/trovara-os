import { describe, expect, it } from 'vitest'
import { containsPesticideLanguage, filterUnsafeProductText } from './pesticide-filter.js'

describe('pesticide-filter', () => {
  it('flags pesticide language', () => {
    expect(containsPesticideLanguage('Buy glyphosate herbicide')).toBe(true)
    expect(containsPesticideLanguage('organic compost fertilizer')).toBe(false)
  })

  it('filters unsafe product rows', () => {
    const out = filterUnsafeProductText([
      { title: 'Organic compost 25kg' },
      { title: 'Paraquat concentrate', reason: 'weed killer' },
      { title: 'Broiler starter feed' },
    ])
    expect(out.map((r) => r.title)).toEqual(['Organic compost 25kg', 'Broiler starter feed'])
  })
})
