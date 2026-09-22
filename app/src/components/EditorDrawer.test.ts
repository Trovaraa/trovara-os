import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import EditorDrawer from './EditorDrawer.vue'

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.forEach(wrapper => wrapper.unmount()); wrappers.length = 0; document.body.innerHTML = ''; vi.restoreAllMocks() })
async function render() {
  document.body.innerHTML = '<div id="app"><main id="workspace"><button id="trigger">Edit row</button></main></div>'
  const workspace = document.querySelector<HTMLElement>('#workspace')!
  workspace.scrollTop = 760
  document.querySelector<HTMLButtonElement>('#trigger')!.focus()
  const wrapper = mount(EditorDrawer, {
    attachTo: document.body,
    props: { open: true, title: 'Edit expense' },
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
    slots: { default: '<label>Name<input id="name" /></label><button id="save">Save</button>' },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, workspace, dialog: document.querySelector<HTMLElement>('[role="dialog"]')! }
}

describe('contextual editor drawer', () => {
  it('teleports outside the inert app, traps focus and restores the exact workspace position', async () => {
    const { wrapper, workspace, dialog } = await render()
    expect(document.querySelector('#app')!.contains(dialog)).toBe(false)
    expect(document.querySelector<HTMLElement>('#app')!.inert).toBe(true)
    expect(dialog.className).toContain('h-dvh')
    expect(dialog.className).toContain('max-w-4xl')
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    // happy-dom does not lay out elements; supply visible rectangles for the focus trap.
    for (const element of dialog.querySelectorAll<HTMLElement>('button,input')) vi.spyOn(element, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    buttons.at(-1)!.focus()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(buttons[0])
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(buttons.at(-1))
    workspace.scrollTop = 20
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ open: false })
    expect(document.activeElement?.id).toBe('trigger')
    expect(workspace.scrollTop).toBe(760)
    expect(document.querySelector<HTMLElement>('#app')!.inert).toBe(false)
  })

  it('warns before losing edits, ignores backdrop clicks, and blocks closing during a save', async () => {
    const { wrapper, dialog } = await render()
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    dialog.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    dialog.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes and close?')
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.setProps({ busy: true })
    confirm.mockClear()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(confirm).not.toHaveBeenCalled()
    expect(dialog.querySelector('button')!.disabled).toBe(true)
    await wrapper.setProps({ busy: false, resetKey: 1 })
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('does not let a closed sibling dialog undo the active dialog’s inert background', async () => {
    const { wrapper } = await render()
    const sibling = mount(EditorDrawer, { props: { open: false, title: 'Hidden' }, global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
    expect(document.querySelector<HTMLElement>('#app')!.inert).toBe(true)
    sibling.unmount()
    expect(document.querySelector<HTMLElement>('#app')!.inert).toBe(true)
    wrapper.unmount()
    expect(document.querySelector<HTMLElement>('#app')!.inert).toBe(false)
    wrappers.length = 0
  })
})
