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
