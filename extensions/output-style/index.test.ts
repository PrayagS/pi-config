import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildStylePrompt,
  loadGlobalStyles,
  normalizeStyles,
  type StylePrompts,
} from "./index"

const prompts: StylePrompts = new Map([
  ["attention-control", "Attention prompt"],
  ["caveman", "Caveman prompt"],
  ["i-have-adhd", "ADHD prompt"],
])

describe("output style config", () => {
  test("migrates a legacy style to the styles list", () => {
    const directory = mkdtempSync(join(tmpdir(), "output-style-"))
    const configPath = join(directory, "output-style.json")
    writeFileSync(configPath, `${JSON.stringify({ style: "caveman" })}\n`)

    expect(loadGlobalStyles(prompts, configPath)).toEqual(["caveman"])
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      styles: ["caveman"],
    })

    rmSync(directory, { recursive: true, force: true })
  })

  test("filters unknown and duplicate styles in prompt filename order", () => {
    const directory = mkdtempSync(join(tmpdir(), "output-style-"))
    const configPath = join(directory, "output-style.json")
    writeFileSync(
      configPath,
      `${JSON.stringify({
        styles: ["caveman", "unknown", "attention-control", "caveman", 42],
      })}\n`
    )

    expect(loadGlobalStyles(prompts, configPath)).toEqual([
      "attention-control",
      "caveman",
    ])

    rmSync(directory, { recursive: true, force: true })
  })

  test("uses the new styles list when both config fields exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "output-style-"))
    const configPath = join(directory, "output-style.json")
    writeFileSync(
      configPath,
      `${JSON.stringify({ style: "caveman", styles: ["i-have-adhd"] })}\n`
    )

    expect(loadGlobalStyles(prompts, configPath)).toEqual(["i-have-adhd"])

    rmSync(directory, { recursive: true, force: true })
  })
})

describe("combined output style prompt", () => {
  test("deduplicates and emits prompts in prompt filename order", () => {
    const styles = normalizeStyles(
      ["i-have-adhd", "caveman", "attention-control", "caveman"],
      prompts
    )

    expect(styles).toEqual(["attention-control", "caveman", "i-have-adhd"])
    expect(buildStylePrompt(styles, prompts)).toBe(
      "\n\nOUTPUT STYLE ACTIVE — attention-control\n\nAttention prompt" +
        "\n\nOUTPUT STYLE ACTIVE — caveman\n\nCaveman prompt" +
        "\n\nOUTPUT STYLE ACTIVE — i-have-adhd\n\nADHD prompt"
    )
  })
})
