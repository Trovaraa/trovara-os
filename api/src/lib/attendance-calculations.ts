const WORKING_DAYS_PER_MONTH = 22
const HOURS_PER_WORKING_DAY = 8
const MINUTES_PER_MONTH = WORKING_DAYS_PER_MONTH * HOURS_PER_WORKING_DAY * 60

export function payableMinutes(clockInAt: Date, clockOutAt: Date): number {
  return Math.max(0, Math.floor((clockOutAt.getTime() - clockInAt.getTime()) / 60_000))
}

export function payableMinutesWithinBounds(
  clockInAt: Date,
  clockOutAt: Date,
  rangeStart: Date,
  rangeEnd: Date,
): number {
  const clippedStart = new Date(Math.max(clockInAt.getTime(), rangeStart.getTime()))
  const clippedEnd = new Date(Math.min(clockOutAt.getTime(), rangeEnd.getTime()))
  return payableMinutes(clippedStart, clippedEnd)
}

export function attendanceLabourCostNgn(monthlyWageNgn: number, minutes: number): number {
  return Math.round((Math.max(0, monthlyWageNgn) * Math.max(0, minutes)) / MINUTES_PER_MONTH)
}
