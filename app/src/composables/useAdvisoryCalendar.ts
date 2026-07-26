import { ref } from 'vue'
import { api } from '@/lib/api'
import type { Recommendation } from '@/composables/useAdvisoryAnalysis'

export type CalendarData = {
  month: string
  observations: Array<{ id: string; loggedAt: string; tiles: string[] }>
  recommendations: Recommendation[]
}

/** Month navigation + calendar fetch for the Advisory calendar tab. */
export function useAdvisoryCalendar() {
  const calendarMonth = ref('')
  const calendarData = ref<CalendarData | null>(null)

  async function loadCalendar() {
    const q = calendarMonth.value ? `?month=${calendarMonth.value}` : ''
    const data = await api<CalendarData>(`/api/advisory/calendar${q}`)
    calendarData.value = data
    calendarMonth.value = data.month
  }

  function shiftMonth(delta: number) {
    const [y, m] = (calendarMonth.value || new Date().toISOString().slice(0, 7))
      .split('-')
      .map(Number)
    const d = new Date(Date.UTC(y, m - 1 + delta, 1))
    calendarMonth.value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    void loadCalendar()
  }

  return {
    calendarMonth,
    calendarData,
    loadCalendar,
    shiftMonth,
  }
}
