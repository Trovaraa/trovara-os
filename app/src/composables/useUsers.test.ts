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

const assignableRoles = {
  roles: [
    { id: 'role-field', name: 'Field worker', isSystem: true, clonedFrom: 'field_worker' },
    { id: 'role-sup', name: 'Supervisor', isSystem: true, clonedFrom: 'supervisor' },
  ],
}

describe('useUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads users on mount', async () => {
    api
      .mockResolvedValueOnce({
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
      .mockResolvedValueOnce(assignableRoles)

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
    expect(api).toHaveBeenCalledWith('/api/roles/assignable')
    expect(composable.users.value).toHaveLength(1)
    expect(composable.newFarmRoleId.value).toBe('role-field')
    expect(composable.loading.value).toBe(false)
  })

  it('createUser posts farmRoleId payload then reloads', async () => {
    api
      .mockResolvedValueOnce({ users: [] }) // mount load users
      .mockResolvedValueOnce(assignableRoles) // mount load roles
      .mockResolvedValueOnce({}) // create
      .mockResolvedValueOnce({
        users: [
          {
            id: 'u2',
            email: 'n@b.com',
            name: 'New',
            role: 'supervisor',
            farmRoleId: 'role-sup',
            active: true,
            createdAt: 'x',
          },
        ],
      })
      .mockResolvedValueOnce(assignableRoles) // reload roles

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
    composable.newFarmRoleId.value = 'role-sup'
    await composable.createUser()
    await flushPromises()

    expect(api).toHaveBeenCalledWith(
      '/api/users',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"farmRoleId":"role-sup"'),
      }),
    )
    expect(composable.users.value[0]?.email).toBe('n@b.com')
  })
})
