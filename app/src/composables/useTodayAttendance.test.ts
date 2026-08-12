import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

describe('useTodayAttendance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['owner', 'supervisor', 'sales', 'field_worker'])(
    'loads attendance for %s',
    async (role) => {
      api.mockResolvedValueOnce({ sessions: [] }).mockResolvedValueOnce({ plots: [] })
      const { useTodayAttendance } = await import('./useTodayAttendance')
      const attendance = useTodayAttendance(() => role, () => 'user-1')
      await attendance.loadAttendance()
      expect(api).toHaveBeenCalledWith('/api/attendance/today')
      expect(api).toHaveBeenCalledWith('/api/zones/plots')
      expect(attendance.showAttendance.value).toBe(true)
      expect(attendance.canManageAttendance.value).toBe(role === 'owner' || role === 'supervisor')
      expect(attendance.canClockSelf.value).toBe(true)
    },
  )

  it('does not load attendance controls for an unsupported role', async () => {
    const { useTodayAttendance } = await import('./useTodayAttendance')
    const attendance = useTodayAttendance(() => 'custom_role', () => 'custom-1')
    await attendance.loadAttendance()
    expect(api).not.toHaveBeenCalled()
    expect(attendance.showAttendance.value).toBe(false)
    expect(attendance.canClockSelf.value).toBe(false)
  })

  it('scopes open attendance to the current user for managers', async () => {
    api.mockResolvedValueOnce({
      sessions: [
        {
          id: 'worker-open',
          userId: 'worker-1',
          userName: 'Worker',
          clockInAt: '2026-08-10T07:00:00.000Z',
          clockOutAt: null,
          payableMinutes: 0,
        },
        {
          id: 'manager-closed',
          userId: 'manager-1',
          userName: 'Manager',
          clockInAt: '2026-08-10T08:00:00.000Z',
          clockOutAt: '2026-08-10T09:00:00.000Z',
          payableMinutes: 60,
        },
      ],
    }).mockResolvedValueOnce({ plots: [] })
    const { useTodayAttendance } = await import('./useTodayAttendance')
    const attendance = useTodayAttendance(() => 'owner', () => 'manager-1')
    await attendance.loadAttendance()
    expect(attendance.openAttendance.value).toBeNull()
  })

  it('clockInNow posts then refreshes', async () => {
    api
      .mockResolvedValueOnce({}) // clock-in
      .mockResolvedValueOnce({
        sessions: [
          {
            id: 's1',
            userName: 'Ada',
            clockInAt: '2026-07-25T08:00:00.000Z',
            clockOutAt: null,
            payableMinutes: 0,
          },
        ],
      })
    const { useTodayAttendance } = await import('./useTodayAttendance')
    const attendance = useTodayAttendance(() => 'field_worker')
    attendance.attendanceNotes.value = 'Block 1'
    await attendance.clockInNow()
    expect(api).toHaveBeenCalledWith(
      '/api/attendance/clock-in',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(attendance.attendance.value).toHaveLength(1)
  })

  it('sends the optional daily summary when clocking out', async () => {
    api.mockResolvedValueOnce({}).mockResolvedValueOnce({ sessions: [] })
    const { useTodayAttendance } = await import('./useTodayAttendance')
    const attendance = useTodayAttendance(() => 'field_worker')
    attendance.workSummary.value = 'Weeded rows 3–6 and checked irrigation.'

    await attendance.clockOutNow()

    expect(api).toHaveBeenNthCalledWith(1, '/api/attendance/clock-out', {
      method: 'POST',
      body: JSON.stringify({ workSummary: 'Weeded rows 3–6 and checked irrigation.' }),
    })
    expect(attendance.workSummary.value).toBe('')
  })
})
