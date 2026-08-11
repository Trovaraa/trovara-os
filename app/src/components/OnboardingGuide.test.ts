import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: { value: 'en' },
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/LanguageSwitcher.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/lib/onboarding', () => {
  const copy = {
    help: 'Help',
    pageHelp: 'Page help',
    close: 'Close',
    fullGuide: 'Full guide',
    skip: 'Skip',
    back: 'Back',
    finish: 'Finish',
    start: 'Start',
    next: 'Next',
    assignedRole: 'Assigned role',
    roleHeading: 'Role',
    roleBody: 'Role body',
    yourPages: 'Your pages',
    pagesBody: 'Pages body',
    basicsTitle: 'Basics',
    basics: ['One'],
    readyTitle: 'Ready',
    readyBody: 'Ready body',
    welcomeBody: 'Welcome body',
    languagePrompt: 'Language',
    roles: {
      owner: { title: 'Owner', summary: 'Owner summary', duties: ['Review'] },
    },
    welcome: (name: string) => `Welcome ${name}`,
    step: (step: number, total: number) => `${step}/${total}`,
    pageRoleLead: (role: string) => role,
  }
  return {
    onboardingCopy: () => copy,
    pageGuide: () => ({ summary: 'Page summary', actions: ['Review this page'] }),
  }
})

describe('OnboardingGuide help affordance', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="mobile-guide-trigger"></div><div id="mobile-drawer-guide-trigger"></div><div id="desktop-guide-trigger"></div><div id="mount"></div>'
    localStorage.setItem('trovara_onboarding:2026-08-guided-v2:user-1', 'complete')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('places accessible icon triggers in app chrome and keeps page help working', async () => {
    const OnboardingGuide = (await import('./OnboardingGuide.vue')).default
    const wrapper = mount(OnboardingGuide, {
      attachTo: '#mount',
      props: {
        userId: 'user-1',
        userName: 'Ada',
        role: 'owner',
        pages: [{ to: '/finance', labelKey: 'nav.finance' }],
        currentPath: '/finance',
        currentTitle: 'Finance',
      },
    })

    const mobile = document.querySelector<HTMLButtonElement>('[data-testid="mobile-help-trigger"]')!
    const drawer = document.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-drawer-help-trigger"]',
    )!
    const desktop = document.querySelector<HTMLButtonElement>('[data-testid="desktop-help-trigger"]')!
    expect(mobile.getAttribute('aria-label')).toBe('Help')
    expect(drawer.textContent).toContain('Help')
    expect(desktop.title).toBe('Help')
    expect(mobile.textContent?.trim()).toBe('')

    mobile.click()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Page summary')
    wrapper.unmount()
  })
})
