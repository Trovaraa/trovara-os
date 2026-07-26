import { describe, expect, it } from 'vitest'
import { findByName, matchByName, matchedRow } from './entity-name-match.js'

type Plot = { id: string; name: string }

const PLOTS: Plot[] = [
  { id: 'plot-1', name: 'Bloc-Nord' },
  { id: 'plot-2', name: 'Pépinière' },
  { id: 'plot-3', name: 'Block 2' },
]

describe('findByName', () => {
  it('matches the stored spelling exactly', () => {
    expect(findByName(PLOTS, 'Bloc-Nord')).toMatchObject({ id: 'plot-1' })
    expect(findByName(PLOTS, 'Pépinière')).toMatchObject({ id: 'plot-2' })
  })

  it('matches across a hyphen the worker typed as a space', () => {
    expect(findByName(PLOTS, 'Bloc Nord')).toMatchObject({ id: 'plot-1' })
    expect(findByName(PLOTS, 'bloc_nord')).toMatchObject({ id: 'plot-1' })
    expect(findByName(PLOTS, 'BLOC/NORD')).toMatchObject({ id: 'plot-1' })
  })

  it('matches a name typed without its diacritics', () => {
    expect(findByName(PLOTS, 'pepiniere')).toMatchObject({ id: 'plot-2' })
    expect(findByName(PLOTS, 'Pepiniere')).toMatchObject({ id: 'plot-2' })
  })

  it('matches regardless of case', () => {
    expect(findByName(PLOTS, 'block 2')).toMatchObject({ id: 'plot-3' })
    expect(findByName(PLOTS, 'BLOCK 2')).toMatchObject({ id: 'plot-3' })
  })

  it('matches through surrounding and repeated whitespace', () => {
    expect(findByName(PLOTS, '  Block   2 ')).toMatchObject({ id: 'plot-3' })
    expect(findByName(PLOTS, '\tbloc  nord\n')).toMatchObject({ id: 'plot-1' })
  })

  it('matches through punctuation the worker added or dropped', () => {
    expect(findByName([{ id: 'z-1', name: "Zone d'Ouest" }], 'Zone dOuest')).toMatchObject({
      id: 'z-1',
    })
    expect(findByName([{ id: 'z-1', name: 'Pen A' }], 'Pen A.')).toMatchObject({ id: 'z-1' })
  })

  it('still misses a name that is genuinely not the same word', () => {
    expect(findByName(PLOTS, 'Bloc Sud')).toBeNull()
    expect(findByName(PLOTS, 'Block 3')).toBeNull()
    // Folding must not turn a name into a prefix search.
    expect(findByName(PLOTS, 'Bloc')).toBeNull()
    expect(findByName(PLOTS, 'Nord')).toBeNull()
  })

  it('misses on empty input instead of taking the first row', () => {
    expect(findByName(PLOTS, '')).toBeNull()
    expect(findByName(PLOTS, '   ')).toBeNull()
    // Punctuation folds away to nothing, which must not match anything either.
    expect(findByName(PLOTS, '-')).toBeNull()
  })
})

describe('matchByName ambiguity', () => {
  const twins: Plot[] = [
    { id: 'plot-1', name: 'Bloc-Nord' },
    { id: 'plot-2', name: 'Bloc Nord' },
  ]

  it('reports the candidates rather than picking one of two folded matches', () => {
    const match = matchByName(twins, 'bloc nord!', (row) => [row.name])

    expect(match.status).toBe('ambiguous')
    expect(match.status === 'ambiguous' && match.rows.map((row) => row.id)).toEqual([
      'plot-1',
      'plot-2',
    ])
    // Callers get a miss, never a guess between two different places.
    expect(matchedRow(match)).toBeNull()
  })

  it('lets the exact stored spelling win over its folded twin', () => {
    expect(findByName(twins, 'Bloc-Nord')).toMatchObject({ id: 'plot-1' })
    expect(findByName(twins, 'Bloc Nord')).toMatchObject({ id: 'plot-2' })
  })

  it('treats rows with the same name as one spelling, not as ambiguous', () => {
    const duplicates: Plot[] = [
      { id: 'plot-1', name: 'Pen A' },
      { id: 'plot-2', name: 'Pen A' },
    ]

    // Nothing the worker could retype tells these apart, so the first row still
    // wins - the behaviour before folding landed.
    expect(findByName(duplicates, 'pen a')).toMatchObject({ id: 'plot-1' })
  })
})

describe('matchByName over several name columns', () => {
  type Asset = { id: string; name: string; assetTag: string | null }

  const assets: Asset[] = [
    { id: 'asset-1', name: 'Motopompe', assetTag: 'PMP-01' },
    { id: 'asset-2', name: 'Wheelbarrow', assetTag: null },
  ]
  const byNameOrTag = (asset: Asset) => [asset.name, asset.assetTag]

  it('matches a folded name or a folded tag', () => {
    expect(matchedRow(matchByName(assets, 'motopompe', byNameOrTag))).toMatchObject({
      id: 'asset-1',
    })
    expect(matchedRow(matchByName(assets, 'pmp 01', byNameOrTag))).toMatchObject({ id: 'asset-1' })
    expect(matchedRow(matchByName(assets, 'WHEELBARROW', byNameOrTag))).toMatchObject({
      id: 'asset-2',
    })
  })

  it('ignores a null tag instead of matching an empty query against it', () => {
    expect(matchedRow(matchByName(assets, '', byNameOrTag))).toBeNull()
    expect(matchByName(assets, 'nothing here', byNameOrTag).status).toBe('none')
  })
})
