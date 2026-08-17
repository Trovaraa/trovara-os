import { describe, expect, it } from 'vitest'
import { htmlToGuidelineMarkdown, isMarkdownTableBlock } from './knowledge-html.js'

describe('htmlToGuidelineMarkdown', () => {
  it('keeps a Word comparison table as a markdown table', () => {
    const html = `
      <p>Why Poultry.</p>
      <table>
        <tr><td><p>Enterprise</p></td><td><p>Poultry</p></td><td><p>Goats</p></td></tr>
        <tr><td><p>First Revenue</p></td><td><p>8–12 weeks</p></td><td><p>12–18 months</p></td></tr>
        <tr><td><p>Capital Intensity</p></td><td><p>Moderate</p></td><td><p>Moderate</p></td></tr>
      </table>
    `
    const markdown = htmlToGuidelineMarkdown(html)
    expect(markdown).toContain('Why Poultry.')
    expect(markdown).toContain('| Enterprise | Poultry | Goats |')
    expect(markdown).toContain('| --- | --- | --- |')
    expect(markdown).toContain('| First Revenue | 8–12 weeks | 12–18 months |')
    expect(isMarkdownTableBlock(markdown.split('\n\n')[1] ?? '')).toBe(true)
  })

  it('converts headings and lists without keeping raw HTML', () => {
    const markdown = htmlToGuidelineMarkdown(
      '<h2>Production Strategy</h2><ul><li>300 Noilers</li><li><strong>Phase 1</strong></li></ul>',
    )
    expect(markdown).toContain('## Production Strategy')
    expect(markdown).toContain('- 300 Noilers')
    expect(markdown).toContain('- **Phase 1**')
    expect(markdown).not.toContain('<')
  })
})
