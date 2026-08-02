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
  correctedById: string | null
  correctedAt: string | null
  payableMinutes: number
}

export type PlotOption = { id: string; name: string; active: boolean }

/** Clock-in/out and correction state for Today's attendance panel. */
export function useTodayAttendance(getRole: () => string | undefined) {
  const { t } = useI18n()

  const attendance = ref<AttendanceSession[]>([])
  const plots = ref<PlotOption[]>([])
  const attendanceBusy = ref(false)
  const attendanceError = ref<string | null>(null)
  const selectedPlotId = ref('')
  const selectedTaskId = ref('')
  const attendanceNotes = ref('')
  const workSummary = ref('')
  const correctingId = ref<string | null>(null)
  const correctionClockIn = ref('')
  const correctionClockOut = ref('')
  const correctionNotes = ref('')

  // Clocking is a field-worker workflow. Owner, supervisor and sales use Today
  // for oversight, approvals, orders and day close—not personal attendance.
  const showAttendance = computed(() => getRole() === 'field_worker')
  const openAttendance = computed(
    () => attendance.value.find((session) => session.clockOutAt === null) ?? null,
  )

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
    if (getRole() === 'field_worker') {
      const plotData = await api<{ plots: PlotOption[] }>('/api/zones/plots')
      plots.value = plotData.plots.filter((plot) => plot.active)
    }
  }

  async function clockInNow() {
    attendanceBusy.value = true
    attendanceError.value = null
    try {
      await api('/api/attendance/clock-in', {
        method: 'POST',
        body: JSON.stringify({
          plotId: selectedPlotId.value || null,
          taskId: selectedTaskId.value || null,
          notes: attendanceNotes.value.trim() || null,
        }),
      })
      await refresh()
    } catch (e) {
      attendanceError.value = e instanceof Error ? e.message : t('today.attendanceActionFailed')
    } finally {
      attendanceBusy.value = false
    }
  }

  async function clockOutNow() {
    attendanceBusy.value = true
    attendanceError.value = null
    try {
      await api('/api/attendance/clock-out', {
        method: 'POST',
        body: JSON.stringify({ workSummary: workSummary.value.trim() || null }),
      })
      workSummary.value = ''
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
    attendanceNotes,
    workSummary,
    correctingId,
    correctionClockIn,
    correctionClockOut,
    correctionNotes,
    showAttendance,
    openAttendance,
    loadAttendance,
    refresh,
    clockInNow,
    clockOutNow,
    startCorrection,
    saveCorrection,
    formatMinutes,
  }
}
