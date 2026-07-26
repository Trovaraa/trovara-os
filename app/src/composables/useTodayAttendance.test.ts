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

  it('loadAttendance clears sessions for sales role', async () => {
    const { useTodayAttendance } = await import('./useTodayAttendance')
    const attendance = useTodayAttendance(() => 'sales')
    attendance.attendance.value = [{ id: 'x' } as never]
    await attendance.loadAttendance()
    expect(api).not.toHaveBeenCalled()
    expect(attendance.attendance.value).toEqual([])
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
})
