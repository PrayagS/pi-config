/** Spec size limits, checked before any rendering so an oversized spec fails fast. No mpl imports. */

/** Most Axes a grid may create (rows * cols). */
export const MPL_MAX_AXES = 64
/** Most leaf values (numbers, strings, ...) across all calls. 100k-point x/y line = 200k values, ~1.4 s to render. */
export const MPL_MAX_VALUES = 1_000_000
/** Wall-clock limit for one render, after which the worker is terminated. */
export const MPL_RENDER_TIMEOUT_MS = 30_000

interface LimitedSpec {
  readonly grid?: { readonly rows: number; readonly cols: number }
  readonly calls: readonly unknown[]
}

function countLeaves(value: unknown, budget: number): number {
  let count = 0
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const v = stack.pop()
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item)
    } else if (v !== null && typeof v === "object") {
      for (const item of Object.values(v)) stack.push(item)
    } else if (++count > budget) {
      return count
    }
  }
  return count
}

/** Throws a model-facing error when the spec is too large to render. */
export function checkSpecLimits(spec: LimitedSpec): void {
  if (spec.grid) {
    const { rows, cols } = spec.grid
    if (
      !Number.isInteger(rows) ||
      !Number.isInteger(cols) ||
      rows < 1 ||
      cols < 1
    )
      throw new Error(
        `grid rows and cols must be positive integers, got ${rows}x${cols}`
      )
    if (rows * cols > MPL_MAX_AXES)
      throw new Error(
        `grid ${rows}x${cols} has ${rows * cols} Axes; the limit is ${MPL_MAX_AXES}. Split it into several charts.`
      )
  }
  const values = countLeaves(spec.calls, MPL_MAX_VALUES)
  if (values > MPL_MAX_VALUES)
    throw new Error(
      `spec has more than ${MPL_MAX_VALUES.toLocaleString("en-US")} values; downsample or aggregate the data first.`
    )
}
