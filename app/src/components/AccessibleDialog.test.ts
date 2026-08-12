import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import AccessibleDialog from './AccessibleDialog.vue'

afterEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})

describe('AccessibleDialog', () => {
  it('labels the dialog, traps focus, closes on Escape, and restores focus', async () => {
    document.body.innerHTML = '<div id="app"><button id="trigger">Open</button></div>'
    const trigger = document.querySelector<HTMLButtonElement>('#trigger')!
    trigger.focus()
    const wrapper = mount(AccessibleDialog, {
      attachTo: document.body,
      props: { open: true, titleId: 'title', closeLabel: 'Close' },
      slots: {
        default: '<h2 id="title">Title</h2><button id="first">First</button><button id="last">Last</button>',
      },
    })
    await nextTick()

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('title')
    expect(document.querySelector<HTMLElement>('#app')!.inert).toBe(true)

    document.querySelector<HTMLButtonElement>('#last')!.focus()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement?.id).toBe('first')

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ open: false })
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })
})
