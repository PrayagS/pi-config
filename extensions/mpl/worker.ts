/** Worker-thread entry: renders one chart so a slow render never blocks pi and can be terminated. */
import { parentPort, workerData } from "node:worker_threads"
import { type MplRenderInput, renderChart } from "./render.ts"

export interface MplWorkerRequest {
  readonly input: MplRenderInput
  readonly outDir?: string
}

const { input, outDir } = workerData as MplWorkerRequest
try {
  const out = renderChart(input, outDir)
  parentPort?.postMessage({ out })
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  })
}
