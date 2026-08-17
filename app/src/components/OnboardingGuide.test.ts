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
    contributionTitle: 'Improve Trovara OS',
    contributionBody: 'Contributor guidance',
    contributionSteps: ['Use a branch', 'Open a pull request'],
    contributionSafety: 'Do not share secrets',
    welcomeBody: 'Welcome body',
    languagePrompt: 'Language',
    roles: {
      owner: { title: 'Owner', summary: 'Owner summary', duties: ['Review'] },
      field_worker: { title: 'Field worker', summary: 'Worker summary', duties: ['Report'] },
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
    document.body.innerHTML = '<div id="mount"></div>'
    localStorage.setItem('trovara_onboarding:2026-08-guided-v2:user-1', 'complete')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('keeps a persistent accessible page-help trigger outside the sidebar', async () => {
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

    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="page-help-trigger"]')!
    expect(trigger.getAttribute('aria-label')).toBe('Help')
    expect(trigger.title).toBe('Help')
    expect(trigger.textContent).toContain('Help')
    expect(trigger.className).toContain('fixed')
    expect(trigger.className).toContain('right-3')
    expect(trigger.className).toContain('bottom-[calc(1rem+env(safe-area-inset-bottom))]')
    expect(trigger.className).not.toContain('top-')
    expect(trigger.className).not.toContain('left-[6.5rem]')

    trigger.click()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Page summary')
    expect(document.querySelector('[data-testid="contribution-help"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Improve Trovara OS')
    wrapper.unmount()
  })

  it('floats above the mobile bottom navigation for field workers', async () => {
    const OnboardingGuide = (await import('./OnboardingGuide.vue')).default
    const wrapper = mount(OnboardingGuide, {
      attachTo: '#mount',
      props: {
        userId: 'user-1',
        userName: 'Ada',
        role: 'field_worker',
        pages: [{ to: '/today', labelKey: 'nav.today' }],
        currentPath: '/today',
        currentTitle: 'Today',
      },
    })

    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="page-help-trigger"]')!
    expect(trigger.className).toContain('right-3')
    expect(trigger.className).toContain(
      'bottom-[calc(5.25rem+env(safe-area-inset-bottom))]',
    )

    trigger.click()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[data-testid="contribution-help"]')).toBeNull()

    wrapper.unmount()
  })
})
