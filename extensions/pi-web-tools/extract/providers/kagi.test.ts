import { describe, expect, test } from "bun:test"
import { cliError, createKagiSummaryExtractor, parseKagiSummary } from "./kagi"

// Shape observed from `kagi summarize --subscriber` (kagi-cli 0.24.0).
const KAGI_HTML =
  "<p>Title: Example Domain</p>\n<ul>\n<li>Example Domain is for <b>documentation</b> examples.</li>\n<li>See <a href=\"https://www.iana.org/\">IANA</a>.</li>\n</ul>"

describe("kagi summary parsing", () => {
  test("converts the HTML summary to markdown and extracts the title", () => {
    expect(parseKagiSummary(KAGI_HTML)).toEqual({
      title: "Example Domain",
      content: "-   Example Domain is for **documentation** examples.\n-   See [IANA](https://www.iana.org/).",
    })
  })

  test("leaves markdown input alone", () => {
    expect(parseKagiSummary("- one\n- two")).toEqual({ content: "- one\n- two" })
  })

  test("extractor returns title, markdown and a small metadata object", async () => {
    const stdout = JSON.stringify({
      meta: { version: "1" },
      data: {
        id: "",
        thread_id: "t-1",
        state: "done",
        prompt: "very long prompt",
        output: KAGI_HTML,
        markdown: KAGI_HTML,
        metadata_html: "<div>big</div>",
        documents: [],
      },
    })
    const pi = { exec: async () => ({ stdout, stderr: "", code: 0 }) } as any
    const out = await createKagiSummaryExtractor(pi)({ urls: ["https://example.com"], mode: "summary" })
    expect(out?.[0]).toMatchObject({ title: "Example Domain", source: "kagi", metadata: { thread_id: "t-1" } })
    expect(out?.[0]?.content).not.toContain("<")
  })
})

describe("kagi CLI errors", () => {
  test("requests JSON errors and reports their code and message", async () => {
    const calls: string[][] = []
    const stderr = JSON.stringify({
      code: "auth_error",
      category: "auth",
      retryable: false,
      message: "auth error: session token expired",
    })
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        calls.push(args)
        return { stdout: "", stderr, code: 1 }
      },
    } as any
    const out = await createKagiSummaryExtractor(pi)({ urls: ["https://example.com"], mode: "summary" })
    expect(calls[0].slice(0, 3)).toEqual(["summarize", "--error-format", "json"])
    expect(out?.[0]?.error).toBe("kagi exited 1: auth_error: auth error: session token expired")
  })

  test("falls back to plain stderr", () => {
    expect(cliError("boom\n", 2)).toBe("kagi exited 2: boom")
  })
})
