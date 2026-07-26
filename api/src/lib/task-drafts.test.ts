import { describe, expect, it, vi } from 'vitest'
import { contentLocaleValues, mergeContentLocale } from './task-drafts.js'

vi.mock('../db/index.js', () => ({ db: {} }))

describe('contentLocaleValues', () => {
  it('writes nothing for English text that needed no translation', () => {
    expect(contentLocaleValues(undefined)).toEqual({})
    expect(contentLocaleValues({ sourceLocale: null, translationStatus: 'done' })).toEqual({})
  })

  it('keeps the author locale of text that translated cleanly', () => {
    expect(contentLocaleValues({ sourceLocale: 'fr', translationStatus: 'done' })).toEqual({
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('marks unresolved text pending, even when the draft was already abandoned', () => {
    expect(contentLocaleValues({ sourceLocale: 'fr', translationStatus: 'pending' })).toEqual({
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    expect(contentLocaleValues({ sourceLocale: 'yo', translationStatus: 'failed' })).toEqual({
      sourceLocale: 'yo',
      translationStatus: 'pending',
    })
  })

  it('still marks pending when the locale could not be detected', () => {
    expect(contentLocaleValues({ translationStatus: 'pending' })).toEqual({
      sourceLocale: null,
      translationStatus: 'pending',
    })
  })
})

describe('mergeContentLocale', () => {
  const done = { sourceLocale: null, translationStatus: 'done' } as const
  const pendingRow = { sourceLocale: 'fr', translationStatus: 'pending' } as const

  it('escalates a settled row when the new text is not English yet', () => {
    expect(
      mergeContentLocale(done, { sourceLocale: 'fr', translationStatus: 'pending' }),
    ).toEqual({ sourceLocale: 'fr', translationStatus: 'pending' })
  })

  it('changes nothing when the new text is already English', () => {
    expect(mergeContentLocale(done, undefined)).toEqual({})
    expect(mergeContentLocale(done, { sourceLocale: null, translationStatus: 'done' })).toEqual({})
  })

  it('leaves a row that already owes a translation untouched', () => {
    expect(mergeContentLocale(pendingRow, { sourceLocale: null, translationStatus: 'done' })).toEqual({})
    expect(mergeContentLocale(pendingRow, { sourceLocale: 'yo', translationStatus: 'pending' })).toEqual({})
    expect(
      mergeContentLocale({ sourceLocale: 'fr', translationStatus: 'failed' }, {
        sourceLocale: 'yo',
        translationStatus: 'pending',
      }),
    ).toEqual({})
  })

  it('never downgrades a pending row to done', () => {
    expect(mergeContentLocale(pendingRow, { sourceLocale: 'fr', translationStatus: 'done' })).toEqual({})
  })
})
