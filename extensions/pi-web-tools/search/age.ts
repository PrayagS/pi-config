import type { SearchAge } from "./types"

/** Start of the `age` window, measured back from now. */
export function ageCutoff(age: SearchAge | undefined, now = new Date()): Date | undefined {
  if (!age) return undefined
  const date = new Date(now)
  if (age === "day") date.setDate(date.getDate() - 1)
  if (age === "week") date.setDate(date.getDate() - 7)
  if (age === "month") date.setMonth(date.getMonth() - 1)
  if (age === "year") date.setFullYear(date.getFullYear() - 1)
  return date
}

/** `age` cutoff as YYYY-MM-DD, for APIs that take calendar dates. */
export function ageCutoffDate(age: SearchAge | undefined, now?: Date) {
  return ageCutoff(age, now)?.toISOString().slice(0, 10)
}
