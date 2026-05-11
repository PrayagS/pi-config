export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 30_000
): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(t)
  }
}
