import { describe, expect, mock, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendTrailer } from "./rewrite"

mock.module("@mariozechner/pi-coding-agent", () => ({
  isToolCallEventType: (tool: string, event: { toolName: string }) =>
    tool === event.toolName,
}))

const model = "GPT-5.6 Sol"
const trailer = `Co-Authored-By: ${model} <noreply@pi.dev>`
const messageFlag = `-m $'${trailer}'`
const trailerFlag = `--trailer $'${trailer}'`
const dedup = `-c trailer.ifexists=addIfDifferent`
const suffix = `$'\\n\\n${trailer}'`

describe("native Git and jj commands", () => {
  test.each([
    [`git commit -m "message"`, `git ${dedup} commit ${trailerFlag} -m "message"`],
    [
      `git commit --message="message"`,
      `git ${dedup} commit ${trailerFlag} --message="message"`,
    ],
    [`git commit -mmessage`, `git ${dedup} commit ${trailerFlag} -mmessage`],
    [`git commit`, `git ${dedup} commit ${trailerFlag}`],
    [
      `git commit --amend --no-edit`,
      `git ${dedup} commit ${trailerFlag} --amend --no-edit`,
    ],
    [`git commit -F body.txt`, `git ${dedup} commit ${trailerFlag} -F body.txt`],
    [`jj commit -m "message"`, `jj commit -m "message" ${messageFlag}`],
    [`jj ci --message message`, `jj ci --message message ${messageFlag}`],
    [`jj describe -m message`, `jj describe -m message ${messageFlag}`],
    [`jj desc -m message`, `jj desc -m message ${messageFlag}`],
    [`jj new -m message`, `jj new -m message ${messageFlag}`],
  ])("rewrites %s", (command, expected) => {
    expect(appendTrailer(command, model)).toBe(expected)
  })

  test("handles option terminators, message values named --, and redirects", () => {
    expect(appendTrailer(`git commit -m message -- path`, model)).toBe(
      `git ${dedup} commit ${trailerFlag} -m message -- path`,
    )
    expect(appendTrailer(`git commit -m message 2>&1 | tail`, model)).toBe(
      `git ${dedup} commit ${trailerFlag} -m message 2>&1 | tail`,
    )
    expect(appendTrailer(`jj describe -m message -- path`, model)).toBe(
      `jj describe -m message ${messageFlag} -- path`,
    )
  })

  test("never misreads value-taking options as message flags", () => {
    // Git short-option clusters are irrelevant to --trailer insertion.
    expect(appendTrailer(`git commit -Sm path`, model)).toBe(
      `git ${dedup} commit ${trailerFlag} -Sm path`,
    )
    // jj option values that look like message flags are consumed as values.
    const toolOnly = `jj commit --tool "-m hacked"`
    expect(appendTrailer(toolOnly, model)).toBe(toolOnly)
    expect(appendTrailer(`jj new -A "-m hacked" -m real`, model)).toBe(
      `jj new -A "-m hacked" -m real ${messageFlag}`,
    )
    expect(appendTrailer(`jj describe -r "-m hacked" -m real`, model)).toBe(
      `jj describe -r "-m hacked" -m real ${messageFlag}`,
    )
  })

  test("recognizes assignments, wrappers, global options, and control flow", () => {
    const command = [
      `FOO=bar git -C repo commit -m one`,
      `if env FOO=bar jj -R repo describe -m two; then`,
      `  timeout 60 jj --at-op @ commit -m three`,
      `  exec git commit -m four`,
      `fi`,
    ].join("\n")

    expect(appendTrailer(command, model)).toBe(
      [
        `FOO=bar git ${dedup} -C repo commit ${trailerFlag} -m one`,
        `if env FOO=bar jj -R repo describe -m two ${messageFlag}; then`,
        `  timeout 60 jj --at-op @ commit -m three ${messageFlag}`,
        `  exec git ${dedup} commit ${trailerFlag} -m four`,
        `fi`,
      ].join("\n"),
    )
  })

  test("supports line continuations and nested command substitutions", () => {
    const command = `git \\\n  commit -m "$(jj describe -m nested)"`
    expect(appendTrailer(command, model)).toBe(
      `git ${dedup} \\\n  commit ${trailerFlag} -m "$(jj describe -m nested ${messageFlag})"`,
    )
  })

  test("does not duplicate an existing trailer", () => {
    for (const command of [
      `git commit ${trailerFlag} -m message`,
      `git commit -m $'message\\n\\n${trailer}'`,
      `jj commit -m $'message\\n\\n${trailer}'`,
      `jj-hunk commit '{}' "message"${suffix}`,
    ]) {
      expect(appendTrailer(appendTrailer(command, model), model)).toBe(command)
    }
  })
})

describe("jj-hunk commit", () => {
  test("appends to its positional message", () => {
    const command = String.raw`jj-hunk commit '{"files":{"values.yaml":{"action":"keep"}},"default":"reset"}' $'refactor(vector): isolate pipeline\n\nRestrict the consumer.'`
    expect(appendTrailer(command, model)).toBe(`${command}${suffix}`)
  })

  test("supports spec-file options before, after, and attached", () => {
    expect(
      appendTrailer(
        `jj-hunk commit --spec-file spec.json "fix: message" && jj st`,
        model,
      ),
    ).toBe(`jj-hunk commit --spec-file spec.json "fix: message"${suffix} && jj st`)
    expect(appendTrailer(`jj-hunk commit "fix: message" -f spec.json`, model)).toBe(
      `jj-hunk commit "fix: message"${suffix} -f spec.json`,
    )
    expect(appendTrailer(`jj-hunk commit -fspec.json "fix: message"`, model)).toBe(
      `jj-hunk commit -fspec.json "fix: message"${suffix}`,
    )
  })

  test("supports leading-dash messages after an option terminator", () => {
    expect(
      appendTrailer(
        `jj-hunk commit --spec-file spec.json -- "-leading message"`,
        model,
      ),
    ).toBe(
      `jj-hunk commit --spec-file spec.json -- "-leading message"${suffix}`,
    )
  })

  test("inserts before redirects and pipelines", () => {
    expect(appendTrailer(`jj-hunk commit '{}' "message" 2>&1 | tail`, model)).toBe(
      `jj-hunk commit '{}' "message"${suffix} 2>&1 | tail`,
    )
  })

  test("skips commands without a positional message", () => {
    const command = `jj-hunk commit '{"default":"reset"}'`
    expect(appendTrailer(command, model)).toBe(command)
  })
})

describe("git end-to-end", () => {
  test("--trailer combines with --fixup and --squash on real git", () => {
    const dir = mkdtempSync(join(tmpdir(), "coauth-git-"))
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir })
    git(["init", "-q"])
    git(["config", "user.name", "Test"])
    git(["config", "user.email", "test@example.com"])
    git(["config", "core.hooksPath", "/dev/null"])
    git(["config", "commit.gpgsign", "false"])
    writeFileSync(join(dir, "f.txt"), "one")
    git(["add", "f.txt"])
    git(["commit", "-q", "-m", "base"])

    for (const command of [
      `git commit --fixup=HEAD`,
      `git commit --squash=HEAD -m extra`,
    ]) {
      writeFileSync(join(dir, "f.txt"), command)
      git(["add", "f.txt"])
      const run = Bun.spawnSync(["bash", "-c", appendTrailer(command, model)], {
        cwd: dir,
      })
      expect(run.exitCode).toBe(0)
      const log = git(["log", "-1", "--pretty=%B"])
      expect(log.stdout.toString()).toContain(trailer)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test("amend does not duplicate a non-adjacent existing trailer", () => {
    const dir = mkdtempSync(join(tmpdir(), "coauth-amend-"))
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir })
    git(["init", "-q"])
    git(["config", "user.name", "Test"])
    git(["config", "user.email", "test@example.com"])
    git(["config", "core.hooksPath", "/dev/null"])
    git(["config", "commit.gpgsign", "false"])
    writeFileSync(join(dir, "f.txt"), "one")
    git(["add", "f.txt"])
    const message = `base\n\n${trailer}\nSigned-off-by: S <s@s>`
    git(["commit", "-q", "-m", message])

    const run = Bun.spawnSync(
      ["bash", "-c", appendTrailer(`git commit --amend --no-edit`, model)],
      { cwd: dir },
    )
    expect(run.exitCode).toBe(0)
    const body = git(["log", "-1", "--pretty=%B"]).stdout.toString()
    expect(body.split(trailer).length - 1).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("Pi tool-call integration", () => {
  test("mutates Bash commands using the active model name", async () => {
    type Handler = (
      event: { toolName: string; input: { command: string } },
      ctx: { model?: { name?: string } },
    ) => Promise<void>

    let handler: Handler | undefined
    const pi = {
      on: (_event: string, callback: Handler) => {
        handler = callback
      },
    }
    const extension = (await import("./index")).default
    extension(pi as unknown as Parameters<typeof extension>[0])

    const event = {
      toolName: "bash",
      input: { command: `git commit -m message` },
    }
    await handler?.(event, { model: { name: model } })

    expect(event.input.command).toBe(
      `git ${dedup} commit ${trailerFlag} -m message`,
    )
  })
})

describe("shell parsing and quoting", () => {
  test("does not rewrite heredoc contents or ordinary arguments", () => {
    const command = [
      `cat <<'EOF'`,
      `git commit -m data`,
      `EOF`,
      `grep jj-hunk commit extensions/`,
      `git commit -m actual <<'MESSAGE'`,
      `jj commit -m heredoc-data`,
      `MESSAGE`,
    ].join("\n")

    expect(appendTrailer(command, model)).toBe(
      [
        `cat <<'EOF'`,
        `git commit -m data`,
        `EOF`,
        `grep jj-hunk commit extensions/`,
        `git ${dedup} commit ${trailerFlag} -m actual <<'MESSAGE'`,
        `jj commit -m heredoc-data`,
        `MESSAGE`,
      ].join("\n"),
    )
  })

  test("preserves hostile model names as one literal argv value", () => {
    const directory = mkdtempSync(join(tmpdir(), "coauth-"))
    const marker = join(directory, "injected")
    const argvFile = join(directory, "argv")
    const fakeGit = join(directory, "git")
    const hostileModel = `Model ' $(touch ${marker}) \\ name`
    const expectedTrailer = `Co-Authored-By: ${hostileModel} <noreply@pi.dev>`
    writeFileSync(fakeGit, `#!/bin/bash\nprintf '%s\\0' "$@" > "${argvFile}"\n`)
    chmodSync(fakeGit, 0o755)

    const rewritten = appendTrailer(`git commit -m message`, hostileModel)
    Bun.spawnSync(["bash", "-c", rewritten], {
      cwd: directory,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    })

    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(argvFile).toString().split("\0").slice(0, -1)).toEqual([
      "-c",
      "trailer.ifexists=addIfDifferent",
      "commit",
      "--trailer",
      expectedTrailer,
      "-m",
      "message",
    ])
    rmSync(directory, { recursive: true, force: true })
  })

  test("fails closed when root or nested shell programs cannot be parsed", () => {
    for (const command of [
      `git commit -m "unterminated`,
      `echo "$(git commit -m message; if)"`,
    ]) {
      expect(appendTrailer(command, model)).toBe(command)
    }
  })
})
