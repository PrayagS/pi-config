import { createHash } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const npmSource =
  /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@[a-zA-Z0-9.*^~<>=|+ -]+)?$/
const filters = ["extensions", "skills", "prompts", "themes"]

function declarations(packages) {
  if (!Array.isArray(packages))
    throw new Error(
      "Expected an explicit packages array; refusing to infer deletions."
    )
  const entries = new Map()
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry?.source
    if (typeof source !== "string")
      throw new Error("Invalid package declaration.")
    if (!source.startsWith("npm:")) continue
    const name = npmSource.exec(source)?.[1]
    if (!name)
      throw new Error(
        "Unsupported npm source; only registry package specifications can be captured."
      )
    if (entries.has(name))
      throw new Error(`Duplicate npm declaration for ${name}.`)
    if (typeof entry === "string") {
      entries.set(name, { entry, value: entry })
      continue
    }
    if (
      Object.keys(entry).some(
        (key) => !["source", "autoload", ...filters].includes(key)
      )
    ) {
      throw new Error(
        `Unknown fields in ${name}; review the declaration manually.`
      )
    }
    const value = { source }
    if ("autoload" in entry) {
      if (typeof entry.autoload !== "boolean")
        throw new Error(`Invalid autoload flag in ${name}.`)
      value.autoload = entry.autoload
    }
    for (const key of filters) {
      if (!(key in entry)) continue
      if (
        !Array.isArray(entry[key]) ||
        entry[key].some((pattern) => {
          if (
            typeof pattern !== "string" ||
            !/^[\w@.+!*?[\]{} ,/-]*$/.test(pattern)
          )
            return true
          const path = pattern.replace(/^[+!-]/, "")
          return path.startsWith("/") || path.split("/").includes("..")
        })
      )
        throw new Error(
          `Nonportable ${key} filter in ${name}; review the declaration manually.`
        )
      value[key] = entry[key]
    }
    entries.set(name, { entry, value: JSON.stringify(value) })
  }
  return entries
}

function readSettings(path) {
  if (!lstatSync(path).isFile())
    throw new Error(
      `Expected a regular settings file at ${path}; apply the missing-key merge before watching it.`
    )
  const text = readFileSync(path, "utf8")
  let packages
  try {
    ;({ packages } = JSON.parse(text))
  } catch {
    throw new Error(`Invalid JSON at ${path}; nothing captured.`)
  }
  return { text, packages, npm: declarations(packages) }
}

function changes(before, after) {
  const result = []
  for (const [name, item] of before) {
    const next = after.get(name)
    if (!next) result.push({ name, kind: "remove" })
    else if (next.value !== item.value) result.push({ name, kind: "update" })
  }
  for (const name of after.keys())
    if (!before.has(name)) result.push({ name, kind: "add" })
  return result
}

// Keep unrelated settings and the original text of untouched package entries.
function rewritePackages(text, packages, before) {
  const tokens = /"(?:[^"\\]|\\.)*"|[{}[\],]/gs
  let depth = 0,
    start,
    entryStart,
    end,
    indent
  const original = []
  for (const token of text.matchAll(tokens)) {
    const [symbol] = token
    if (
      depth === 1 &&
      symbol.startsWith('"') &&
      JSON.parse(symbol) === "packages"
    ) {
      const rest = text.slice(token.index + symbol.length)
      const prefix = /^\s*:\s*(?=\[)/.exec(rest)
      if (prefix) {
        start = token.index + symbol.length + prefix[0].length
        entryStart = start + 1
        indent = /^[\t ]*/.exec(
          text.slice(text.lastIndexOf("\n", token.index) + 1)
        )[0]
      }
    }
    if (
      start !== undefined &&
      token.index > start &&
      depth === 2 &&
      (symbol === "," || symbol === "]")
    ) {
      const item = text.slice(entryStart, token.index).trim()
      if (item) original.push(item)
      entryStart = token.index + 1
      if (symbol === "]") {
        end = token.index + 1
        break
      }
    }
    if (symbol === "{" || symbol === "[") depth++
    if (symbol === "}" || symbol === "]") depth--
  }
  if (end === undefined || original.length !== before.length)
    throw new Error("Could not locate the profile packages array.")
  const raw = new Map(
    before.map((item, i) => [JSON.stringify(item), original[i]])
  )
  const items = packages.map(
    (item) =>
      `${indent}  ${raw.get(JSON.stringify(item)) ?? JSON.stringify(item)}`
  )
  return (
    text.slice(0, start) +
    (items.length ? `[\n${items.join(",\n")}\n${indent}]` : "[]") +
    text.slice(end)
  )
}

function writeAtomic(path, text, mode, expected) {
  const temp = mkdtempSync(join(dirname(path), ".pi-package-sync-"))
  const file = join(temp, "next")
  try {
    writeFileSync(file, text, { mode, flag: "wx" })
    if (
      expected !== undefined &&
      (!lstatSync(path).isFile() || readFileSync(path, "utf8") !== expected)
    ) {
      throw new Error(
        "The profile changed during capture; retry after reviewing it."
      )
    }
    renameSync(file, path)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export function syncPackages({
  livePath,
  profilePath,
  statePath,
  apply = false,
  reset = false,
  log = console.log,
}) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const lock = `${statePath}.lock`
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Capture is already running (lock: ${lock}).`)
    throw error
  }
  try {
    const live = readSettings(livePath)
    const profile = readSettings(profilePath)
    const save = (repo) =>
      writeAtomic(
        statePath,
        JSON.stringify({
          version: 1,
          live: [...live.npm.values()].map(({ entry }) => entry),
          profile: [...repo.values()].map(({ entry }) => entry),
        }) + "\n",
        0o600
      )
    let baseline
    if (!reset) {
      try {
        baseline = JSON.parse(readFileSync(statePath, "utf8"))
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error(
            "Cannot read the package sync baseline; review it before resetting."
          )
      }
    }
    if (!baseline) {
      save(profile.npm)
      log("Recorded npm package baseline; no profile changes made.")
      return
    }
    if (baseline.version !== 1)
      throw new Error(
        "Unsupported package sync baseline; review it before resetting."
      )
    const delta = changes(declarations(baseline.live), live.npm)
    if (!delta.length) return
    if (changes(declarations(baseline.profile), profile.npm).length) {
      throw new Error(
        "The repo npm list changed independently. Review both lists before resetting the baseline."
      )
    }
    for (const { kind, name } of delta)
      log(`${apply ? "Capture" : "Would capture"} ${kind}: ${name}`)
    if (!apply) return

    const pending = new Map(delta.map(({ name, kind }) => [name, kind]))
    const result = profile.packages.flatMap((entry) => {
      const name = npmSource.exec(
        typeof entry === "string" ? entry : entry.source
      )?.[1]
      if (!pending.has(name)) return [entry]
      pending.delete(name)
      const next = live.npm.get(name)
      return next ? [next.entry] : []
    })
    for (const name of pending.keys())
      if (live.npm.has(name)) result.push(live.npm.get(name).entry)
    if (JSON.stringify(result) !== JSON.stringify(profile.packages)) {
      // A Pi change during capture will be observed against the saved baseline on the next event.
      const next = rewritePackages(profile.text, result, profile.packages)
      if (
        JSON.stringify(JSON.parse(next).packages) !== JSON.stringify(result)
      ) {
        throw new Error(
          "Ambiguous packages array; review the profile manually."
        )
      }
      writeAtomic(
        profilePath,
        next,
        lstatSync(profilePath).mode & 0o777,
        profile.text
      )
    }
    save(declarations(result))
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function main() {
  const args = process.argv.slice(2)
  if (
    args.length > 1 ||
    (args.length && args[0] !== "--apply" && args[0] !== "--reset-baseline")
  ) {
    throw new Error("Usage: pi-package-sync.mjs [--apply | --reset-baseline]")
  }
  const home = homedir()
  const livePath = join(home, ".pi/agent/settings.json")
  const profilePath = fileURLToPath(
    new URL("../profile/settings.json", import.meta.url)
  )
  const id = createHash("sha256")
    .update(`${livePath}\0${profilePath}`)
    .digest("hex")
    .slice(0, 16)
  const statePath = join(
    process.env.XDG_STATE_HOME || join(home, ".local/state"),
    "pi-config",
    `npm-packages-${id}.json`
  )
  syncPackages({
    livePath,
    profilePath,
    statePath,
    reset: args[0] === "--reset-baseline",
    apply:
      args[0] === "--apply" ||
      (!args.length && process.env.PI_PACKAGE_SYNC_APPLY === "1"),
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
