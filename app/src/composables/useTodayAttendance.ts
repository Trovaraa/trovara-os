import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

export type AttendanceSession = {
  id: string
  userId: string
  userName: string
  clockInAt: string
  clockOutAt: string | null
  monthlyWageSnapshotNgn: number
  plotId: string | null
  plotName: string | null
  taskId: string | null
  taskTitle: string | null
  notes: string | null
  workSummary: string | null
  workDate: string | null
  submittedMinutes: number | null
  approvalStatus: 'pending' | 'approved' | 'rejected'
  approvedById: string | null
  approvedAt: string | null
  rejectionReason: string | null
  correctedById: string | null
  correctedAt: string | null
  payableMinutes: number
}

export type PlotOption = { id: string; name: string; active: boolean }

const SELF_ATTENDANCE_ROLES = new Set(['owner', 'supervisor', 'sales', 'field_worker'])

/** Clock-in/out and correction state for Today's attendance panel. */
export function useTodayAttendance(
  getRole: () => string | undefined,
  getUserId: () => string | undefined = () => undefined,
) {
  const { t } = useI18n()

  const attendance = ref<AttendanceSession[]>([])
  const plots = ref<PlotOption[]>([])
  const attendanceBusy = ref(false)
  const attendanceError = ref<string | null>(null)
  const selectedPlotId = ref('')
  const selectedTaskId = ref('')
  const workSummary = ref('')
  const workDate = ref(new Date().toISOString().slice(0, 10))
  const hoursValue = ref('')
  const correctingId = ref<string | null>(null)
  const correctionClockIn = ref('')
  const correctionClockOut = ref('')
  const correctionNotes = ref('')

  const showAttendance = computed(() => SELF_ATTENDANCE_ROLES.has(getRole() ?? ''))
  const canManageAttendance = computed(() => {
    const role = getRole()
    return role === 'owner' || role === 'supervisor'
  })
  const canClockSelf = computed(() => SELF_ATTENDANCE_ROLES.has(getRole() ?? ''))
  const myTodaySubmission = computed(() => {
    const userId = getUserId()
    const today = new Date().toISOString().slice(0, 10)
    return attendance.value.find((session) => session.userId === userId && session.workDate === today) ?? null
  })

  async function refresh() {
    const result = await api<{ sessions: AttendanceSession[] }>('/api/attendance/today')
    attendance.value = result.sessions
  }

  async function loadAttendance() {
    if (!showAttendance.value) {
      attendance.value = []
      return
    }
    await refresh()
    const plotData = await api<{ plots: PlotOption[] }>('/api/zones/plots')
    plots.value = plotData.plots.filter((plot) => plot.active)
  }

  async function submitHoursNow() {
    attendanceBusy.value = true
    attendanceError.value = null
    try {
      const hours = Number(hoursValue.value)
      if (!Number.isFinite(hours) || hours < 0.25 || hours > 16) throw new Error(t('hoursEntry.invalidHours'))
      if (!workSummary.value.trim()) throw new Error(t('hoursEntry.summaryRequired'))
      await api('/api/attendance/submit-hours', {
        method: 'POST',
        body: JSON.stringify({
          workDate: workDate.value,
          submittedMinutes: Math.round(hours * 60),
          plotId: selectedPlotId.value || null,
          taskId: selectedTaskId.value || null,
          workSummary: workSummary.value.trim(),
        }),
      })
      hoursValue.value = ''
      workSummary.value = ''
      await refresh()
    } catch (e) {
      attendanceError.value = e instanceof Error ? e.message : t('today.attendanceActionFailed')
    } finally {
      attendanceBusy.value = false
    }
  }

  async function reviewHoursNow(session: AttendanceSession, decision: 'approved' | 'rejected') {
    attendanceBusy.value = true
    attendanceError.value = null
    try {
      let rejectionReason: string | null = null
      if (decision === 'rejected') {
        rejectionReason = window.prompt(t('hoursEntry.returnQuestion'))?.trim() || null
        if (!rejectionReason) return
      }
      await api(`/api/attendance/${session.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, rejectionReason }),
      })
      await refresh()
    } catch (e) {
      attendanceError.value = e instanceof Error ? e.message : t('today.attendanceActionFailed')
    } finally {
      attendanceBusy.value = false
    }
  }

  function toLocalInput(iso: string | null) {
    if (!iso) return ''
    const date = new Date(iso)
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  }

  function startCorrection(session: AttendanceSession) {
    correctingId.value = session.id
    correctionClockIn.value = toLocalInput(session.clockInAt)
    correctionClockOut.value = toLocalInput(session.clockOutAt)
    correctionNotes.value = session.notes ?? ''
  }

  async function saveCorrection(session: AttendanceSession) {
    attendanceBusy.value = true
    attendanceError.value = null
    try {
      await api(`/api/attendance/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          clockInAt: new Date(correctionClockIn.value).toISOString(),
          clockOutAt: correctionClockOut.value
            ? new Date(correctionClockOut.value).toISOString()
            : null,
          notes: correctionNotes.value.trim() || null,
        }),
      })
      correctingId.value = null
      await refresh()
    } catch (e) {
      attendanceError.value = e instanceof Error ? e.message : t('today.attendanceActionFailed')
    } finally {
      attendanceBusy.value = false
    }
  }

  function formatMinutes(minutes: number) {
    const hours = Math.floor(minutes / 60)
    const remainder = minutes % 60
    return t('today.attendanceDuration', { hours, minutes: remainder })
  }

  return {
    attendance,
    plots,
    attendanceBusy,
    attendanceError,
    selectedPlotId,
    selectedTaskId,
    workSummary,
    workDate,
    hoursValue,
    correctingId,
    correctionClockIn,
    correctionClockOut,
    correctionNotes,
    showAttendance,
    canManageAttendance,
    canClockSelf,
    myTodaySubmission,
    loadAttendance,
    refresh,
    submitHoursNow,
    reviewHoursNow,
    startCorrection,
    saveCorrection,
    formatMinutes,
  }
}
