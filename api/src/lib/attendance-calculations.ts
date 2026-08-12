const WORKING_DAYS_PER_MONTH = 22
const HOURS_PER_WORKING_DAY = 8
const MINUTES_PER_MONTH = WORKING_DAYS_PER_MONTH * HOURS_PER_WORKING_DAY * 60

type TimestampValue = Date | string | number

function timestampMs(value: TimestampValue): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

export function payableMinutes(clockInAt: TimestampValue, clockOutAt: TimestampValue): number {
  const startMs = timestampMs(clockInAt)
  const endMs = timestampMs(clockOutAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0
  return Math.max(0, Math.floor((endMs - startMs) / 60_000))
}

export function payableMinutesWithinBounds(
  clockInAt: TimestampValue,
  clockOutAt: TimestampValue,
  rangeStart: TimestampValue,
  rangeEnd: TimestampValue,
): number {
  const clockInMs = timestampMs(clockInAt)
  const clockOutMs = timestampMs(clockOutAt)
  const rangeStartMs = timestampMs(rangeStart)
  const rangeEndMs = timestampMs(rangeEnd)
  if (![clockInMs, clockOutMs, rangeStartMs, rangeEndMs].every(Number.isFinite)) return 0
  return Math.max(
    0,
    Math.floor(
      (Math.min(clockOutMs, rangeEndMs) - Math.max(clockInMs, rangeStartMs)) / 60_000,
    ),
  )
}

export function attendanceLabourCostNgn(monthlyWageNgn: number, minutes: number): number {
  return Math.round((Math.max(0, monthlyWageNgn) * Math.max(0, minutes)) / MINUTES_PER_MONTH)
}
