import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CollapsibleSection from './CollapsibleSection.vue'

describe('CollapsibleSection', () => {
  it('starts closed when requested and exposes its state accessibly', async () => {
    const wrapper = mount(CollapsibleSection, {
      props: { title: 'Add user', defaultOpen: false },
      slots: { default: '<input aria-label="Name" />' },
    })

    const trigger = wrapper.get('button')
    const content = wrapper.get('[id^="collapsible-"]')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(content.attributes('style')).toContain('display: none')

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(content.attributes('style') ?? '').not.toContain('display: none')
  })

  it('keeps mounted form state when collapsed and reopened', async () => {
    const wrapper = mount(CollapsibleSection, {
      props: { title: 'Details' },
      slots: { default: '<input aria-label="Reference" />' },
    })
    const input = wrapper.get('input')
    await input.setValue('TRV-101')

    await wrapper.get('button').trigger('click')
    await wrapper.get('button').trigger('click')

    expect(wrapper.get('input').element.value).toBe('TRV-101')
  })
})
