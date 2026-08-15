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

  it('scopes today submission to the current user for managers', async () => {
    const today = new Date().toISOString().slice(0, 10)
    api.mockResolvedValueOnce({
      sessions: [
        {
          id: 'worker-open',
          userId: 'worker-1',
          userName: 'Worker',
          clockInAt: '2026-08-10T07:00:00.000Z',
          clockOutAt: null,
          payableMinutes: 0,
          workDate: today,
        },
        {
          id: 'manager-closed',
          userId: 'manager-1',
          userName: 'Manager',
          clockInAt: '2026-08-10T08:00:00.000Z',
          clockOutAt: '2026-08-10T09:00:00.000Z',
          payableMinutes: 60,
          workDate: today,
        },
      ],
    }).mockResolvedValueOnce({ plots: [] })
    const { useTodayAttendance } = await import('./useTodayAttendance')
    const attendance = useTodayAttendance(() => 'owner', () => 'manager-1')
    await attendance.loadAttendance()
    expect(attendance.myTodaySubmission.value?.id).toBe('manager-closed')
  })

  it('submits hours with a required work summary then refreshes', async () => {
    api
      .mockResolvedValueOnce({})
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
    attendance.hoursValue.value = '7.5'
    attendance.workSummary.value = 'Weeded Block 1 and checked irrigation.'
    await attendance.submitHoursNow()
    expect(api).toHaveBeenCalledWith(
      '/api/attendance/submit-hours',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(attendance.attendance.value).toHaveLength(1)
    expect(attendance.workSummary.value).toBe('')
  })

  it('reviews a submitted entry', async () => {
    api.mockResolvedValueOnce({}).mockResolvedValueOnce({ sessions: [] })
    const { useTodayAttendance } = await import('./useTodayAttendance')
    const attendance = useTodayAttendance(() => 'owner')
    const session = { id: 'entry-1' } as never
    await attendance.reviewHoursNow(session, 'approved')

    expect(api).toHaveBeenNthCalledWith(1, '/api/attendance/entry-1/review', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', rejectionReason: null }),
    })
  })
})
