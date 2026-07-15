/**
 * Turn an arbitrary name into a URL-safe slug used in public farm links.
 * Lowercases, strips accents, collapses non-alphanumerics to single hyphens,
 * trims stray hyphens and caps length. Never returns an empty string.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug || 'farm'
}
