import { describe, expect, it } from 'vitest'
import { onboardingCopy, pageGuide } from './onboarding'

const locales = ['en', 'yo', 'pcm', 'fr'] as const
const roles = ['owner', 'supervisor', 'field_worker', 'sales'] as const
const routes = [
  '/dashboard', '/today', '/hours', '/advisory', '/worker', '/tasks', '/tasks/post-approval',
  '/field-reports', '/crops', '/livestock', '/inventory', '/assets', '/sales',
  '/support', '/products', '/customer-insights', '/whatsapp', '/telegram', '/traceability',
  '/events', '/ai', '/reports', '/finance', '/journal', '/brand-kits', '/newsletter',
  '/marketing-leads', '/customer-surveys', '/shop-customers', '/moments', '/careers', '/templates', '/zones',
  '/users', '/settings', '/settings/security', '/settings/audit',
]

describe('guided onboarding copy', () => {
  it('explains every supported role in every language', () => {
    for (const locale of locales) {
      const copy = onboardingCopy(locale)
      for (const role of roles) {
        expect(copy.roles[role].title).toBeTruthy()
        expect(copy.roles[role].summary).toBeTruthy()
        expect(copy.roles[role].duties.length).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('provides page-level help for every application tab in every language', () => {
    for (const locale of locales) {
      const copy = onboardingCopy(locale)
      for (const role of roles) {
        for (const route of routes) {
          const guide = pageGuide(copy, route, role)
          expect(guide).not.toBe(copy.fallbackPage)
          expect(guide.summary).toBeTruthy()
          expect(guide.actions.length).toBeGreaterThanOrEqual(2)
        }
      }
    }
  })

  it('gives each role the correct Today workflow', () => {
    for (const locale of locales) {
      const copy = onboardingCopy(locale)
      const workerGuide = pageGuide(copy, '/today', 'field_worker')
      expect(workerGuide).not.toBe(copy.pages['/today'])
      expect(workerGuide.summary).toBeTruthy()

      for (const role of ['owner', 'supervisor', 'sales'] as const) {
        const guide = pageGuide(copy, '/today', role)
        expect(guide).not.toBe(workerGuide)
        expect(guide).not.toBe(copy.pages['/today'])
        expect(guide.summary).toBeTruthy()
      }
    }
  })

  it('tells every English role to submit their Today work hours', () => {
    const copy = onboardingCopy('en')
    for (const role of roles) {
      const guide = pageGuide(copy, '/today', role)
      expect(guide.actions.some((action) => action.toLowerCase().includes('submit'))).toBe(true)
      expect(guide.summary).not.toMatch(/do not clock/i)
    }
  })

  it('personalizes field worker help for every page they use', () => {
    const workerRoutes = [
      '/today',
      '/advisory',
      '/worker',
      '/field-reports',
      '/inventory',
      '/settings',
      '/assets',
      '/traceability',
    ] as const

    for (const locale of locales) {
      const copy = onboardingCopy(locale)
      expect(copy.pageRoleLead(copy.roles.field_worker.title)).toContain(copy.roles.field_worker.title)

      for (const route of workerRoutes) {
        const guide = pageGuide(copy, route, 'field_worker')
        expect(guide).toBe(copy.rolePages.field_worker?.[route])
        expect(guide).not.toBe(copy.pages[route])
        expect(guide.actions.length).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('falls back safely for a future page', () => {
    const copy = onboardingCopy('en')
    expect(pageGuide(copy, '/future', 'owner')).toBe(copy.fallbackPage)
  })
})
