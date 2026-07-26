import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@/lib/roles', () => ({
  roleLabel: (role: string) => role,
}))

describe('useUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads users on mount', async () => {
    api.mockResolvedValueOnce({
      users: [
        {
          id: 'u1',
          email: 'a@b.com',
          name: 'Ada',
          role: 'field_worker',
          active: true,
          createdAt: '2026-01-01',
        },
      ],
    })

    const { useUsers } = await import('./useUsers')
    let composable!: ReturnType<typeof useUsers>
    const Comp = defineComponent({
      setup() {
        composable = useUsers()
        return () => h('div')
      },
    })
    mount(Comp)
    await flushPromises()

    expect(api).toHaveBeenCalledWith('/api/users')
    expect(composable.users.value).toHaveLength(1)
    expect(composable.loading.value).toBe(false)
  })

  it('createUser posts staff payload then reloads', async () => {
    api
      .mockResolvedValueOnce({ users: [] }) // mount load
      .mockResolvedValueOnce({}) // create
      .mockResolvedValueOnce({
        users: [{ id: 'u2', email: 'n@b.com', name: 'New', role: 'supervisor', active: true, createdAt: 'x' }],
      })

    const { useUsers } = await import('./useUsers')
    let composable!: ReturnType<typeof useUsers>
    mount(
      defineComponent({
        setup() {
          composable = useUsers()
          return () => h('div')
        },
      }),
    )
    await flushPromises()

    composable.newEmail.value = 'n@b.com'
    composable.newName.value = 'New'
    composable.newPassword.value = 'password123'
    composable.newRoleChoice.value = 'supervisor'
    await composable.createUser()
    await flushPromises()

    expect(api).toHaveBeenCalledWith(
      '/api/users',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"email":"n@b.com"'),
      }),
    )
    expect(composable.users.value[0]?.email).toBe('n@b.com')
  })
})
