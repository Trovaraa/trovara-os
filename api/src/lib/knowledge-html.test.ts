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

  it('escapes backslashes and pipes inside table cells', () => {
    const markdown = htmlToGuidelineMarkdown(
      '<table><tr><td>A|B</td><td>C\\D</td></tr><tr><td>1</td><td>2</td></tr></table>',
    )
    expect(markdown).toContain('| A\\|B | C\\\\D |')
  })

  it('does not leave nested comments, style, or script markup', () => {
    const markdown = htmlToGuidelineMarkdown(
      '<!--<!-- --> --><style>p{}<style>p{}</style></style><script>alert(1)<script>alert(1)</script></script><p>Safe</p>',
    )
    expect(markdown).toContain('Safe')
    expect(markdown).not.toMatch(/<!--|<style|<script/i)
  })

  it('strips script and style end tags that include whitespace', () => {
    const markdown = htmlToGuidelineMarkdown(
      '<script>alert(1)</script ><style>p{}</style ><p>Safe</p>',
    )
    expect(markdown).toBe('Safe')
    expect(markdown).not.toMatch(/alert|p\{\}/i)
  })

  it('strips malformed executable elements instead of filtering HTML with regular expressions', () => {
    const markdown = htmlToGuidelineMarkdown(
      '<script>alert(1)</script\t\n data-test><iframe src="https://example.com">bad</iframe><p>Safe</p>',
    )
    expect(markdown).toBe('Safe')
    expect(markdown).not.toMatch(/alert|iframe|bad/i)
  })

  it('escapes entity-encoded HTML and rejects unsafe link protocols', () => {
    const markdown = htmlToGuidelineMarkdown(
      '<p>&lt;img src=x onerror=alert(1)&gt; <a href="javascript:alert(1)">Open</a></p>',
    )
    expect(markdown).toContain('\\<img src=x onerror=alert(1)\\> Open')
    expect(markdown).not.toContain('javascript:')
  })

  it('keeps safe links without exposing URL credentials', () => {
    const markdown = htmlToGuidelineMarkdown(
      '<p><a href="https://example.com/guideline">Safe</a> <a href="https://user:pass@example.com/">Secret</a></p>',
    )
    expect(markdown).toContain('[Safe](<https://example.com/guideline>)')
    expect(markdown).toContain('Secret')
    expect(markdown).not.toContain('user:pass')
  })
})
