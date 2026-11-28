import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { syncPackages } from "./pi-package-sync.mjs"

function fixture(t, live, profile) {
  const dir = mkdtempSync(join(tmpdir(), "pi-package-sync-test-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const livePath = join(dir, "live.json"),
    profilePath = join(dir, "profile.json"),
    statePath = join(dir, "private", "baseline.json")
  const set = (path, value) =>
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
  const get = (path) => JSON.parse(readFileSync(path, "utf8"))
  set(livePath, live)
  set(profilePath, profile)
  const log = []
  const sync = (options = {}) =>
    syncPackages({
      livePath,
      profilePath,
      statePath,
      log: (value) => log.push(value),
      ...options,
    })
  return {
    livePath,
    profilePath,
    statePath,
    log,
    sync,
    writeLive: (obj) => set(livePath, obj),
    writeProfile: (obj) => set(profilePath, obj),
    readProfile: () => get(profilePath),
  }
}

test("first run establishes a private baseline without inferring deletions", (t) => {
  const profile = { packages: ["npm:here", "npm:not-installed-here"] }
  const f = fixture(
    t,
    { packages: ["npm:here", "~/local-checkout"], secret: "not captured" },
    profile
  )
  f.sync({ apply: true })
  assert.deepEqual(f.readProfile(), profile)
  assert.deepEqual(JSON.parse(readFileSync(f.statePath, "utf8")).live, [
    "npm:here",
  ])
  assert.equal(statSync(f.statePath).mode & 0o777, 0o600)
  assert.match(f.log[0], /baseline/)
})

test("report and capture only observed npm changes, keeping unrelated source text", (t) => {
  const before = {
    packages: [
      "npm:remove-me",
      "npm:edit-me@1",
      "npm:@example/unchanged",
      "../../dev/pi-config",
      "npm:repo-only",
    ],
    options: { packages: [{ name: "nested" }] },
  }
  const f = fixture(
    t,
    {
      packages: [
        "npm:remove-me",
        "npm:edit-me@1",
        "npm:@example/unchanged",
        "git:private-source",
      ],
    },
    before
  )
  f.sync()
  const edited = {
    source: "npm:edit-me@2",
    extensions: ["+extensions/**", "-extensions/old.ts"],
  }
  f.writeLive({
    packages: [
      edited,
      "npm:@example/unchanged",
      "npm:new@next",
      "/private/local-package",
    ],
    local: "untouched",
  })
  f.sync()
  assert.deepEqual(f.readProfile(), before)
  assert.deepEqual(f.log.slice(1), [
    "Would capture remove: remove-me",
    "Would capture update: edit-me",
    "Would capture add: new",
  ])
  const original = readFileSync(f.profilePath, "utf8")
  f.sync({ apply: true })
  assert.deepEqual(f.readProfile(), {
    ...before,
    packages: [
      edited,
      "npm:@example/unchanged",
      "../../dev/pi-config",
      "npm:repo-only",
      "npm:new@next",
    ],
  })
  assert.equal(
    readFileSync(f.profilePath, "utf8").split('  "options"')[1],
    original.split('  "options"')[1]
  )
  const size = f.log.length
  f.sync({ apply: true })
  assert.equal(f.log.length, size)
})

test("an independent repo npm edit blocks capture; resetting accepts it without copying", (t) => {
  const f = fixture(t, { packages: ["npm:base"] }, { packages: ["npm:base"] })
  f.sync()
  f.writeLive({ packages: ["npm:base", "npm:live"] })
  const repo = { packages: ["npm:base", "npm:repo"] }
  f.writeProfile(repo)
  assert.throws(() => f.sync({ apply: true }), /changed independently/)
  assert.deepEqual(f.readProfile(), repo)
  f.sync({ reset: true })
  f.sync({ apply: true })
  assert.deepEqual(f.readProfile(), repo)
})

test("a repo edit outside packages survives capture", (t) => {
  const f = fixture(t, { packages: [] }, { packages: [] })
  f.sync()
  f.writeLive({ packages: ["npm:new"] })
  f.writeProfile({ model: "repo-edited", packages: [] })
  f.sync({ apply: true })
  assert.deepEqual(f.readProfile(), {
    model: "repo-edited",
    packages: ["npm:new"],
  })
})

test("invalid JSON, missing package arrays and nonportable declarations do not capture", (t) => {
  const f = fixture(t, { packages: [] }, { packages: [] })
  f.sync()
  writeFileSync(f.livePath, '{"packages":')
  assert.throws(() => f.sync({ apply: true }), /Invalid JSON/)
  f.writeLive({ model: "not a packages array" })
  assert.throws(() => f.sync({ apply: true }), /explicit packages array/)
  f.writeLive({
    packages: [
      { source: "npm:new", extensions: ["+/Users/name/extension.ts"] },
    ],
  })
  assert.throws(() => f.sync({ apply: true }), /Nonportable extensions filter/)
  assert.deepEqual(f.readProfile(), { packages: [] })
})

test("the old live symlink is rejected before any baseline is written", (t) => {
  const f = fixture(t, { packages: [] }, { packages: [] })
  rmSync(f.livePath)
  symlinkSync(f.profilePath, f.livePath)
  assert.throws(
    () => f.sync({ apply: true }),
    /Expected a regular settings file/
  )
  assert.equal(existsSync(f.statePath), false)
})
