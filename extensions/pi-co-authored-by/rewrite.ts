import { parse, type Command, type ParsedScript, type Word, type WordPart } from "unbash"

const JJ_SUBCOMMANDS = new Set(["commit", "ci", "describe", "desc", "new"])
const WRAPPERS = new Set([
  "command",
  "env",
  "exec",
  "nohup",
  "sudo",
  "timeout",
])

interface Edit {
  position: number
  text: string
}

interface ResolvedCommand {
  executable: string
  executableIndex: number
}

function isStaticPart(part: WordPart): boolean {
  if (
    part.type === "Literal" ||
    part.type === "SingleQuoted" ||
    part.type === "AnsiCQuoted"
  )
    return true
  if (part.type === "DoubleQuoted" || part.type === "LocaleString")
    return part.parts.every(isStaticPart)
  return false
}

function staticWord(word: Word | undefined): string | undefined {
  if (!word || (word.parts && !word.parts.every(isStaticPart))) return undefined
  return word.value
}

function commandName(word: Word | undefined): string | undefined {
  const value = staticWord(word)
  return value?.slice(value.lastIndexOf("/") + 1)
}

function consumeOptions(
  words: Word[],
  start: number,
  optionsWithValues: Set<string>,
): number | undefined {
  let index = start
  while (index < words.length) {
    const value = staticWord(words[index])
    if (value === undefined) return undefined
    if (value === "--") return index + 1
    if (!value.startsWith("-") || value === "-") return index

    const option = value.split("=", 1)[0]
    if (optionsWithValues.has(option) && !value.includes("=")) index++
    index++
  }
  return undefined
}

function unwrapCommand(words: Word[]): ResolvedCommand | undefined {
  let index = 0

  while (index < words.length) {
    const executable = commandName(words[index])
    if (!executable) return undefined
    if (!WRAPPERS.has(executable)) return { executable, executableIndex: index }

    index++
    if (executable === "nohup") continue

    if (executable === "command" || executable === "exec") {
      index =
        consumeOptions(
          words,
          index,
          executable === "exec" ? new Set(["-a"]) : new Set(),
        ) ?? words.length
      continue
    }

    if (executable === "env") {
      const valueOptions = new Set([
        "-C",
        "--chdir",
        "-S",
        "--split-string",
        "-u",
        "--unset",
        "--argv0",
      ])
      index = consumeOptions(words, index, valueOptions) ?? words.length
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(staticWord(words[index]) ?? ""))
        index++
      continue
    }

    if (executable === "timeout") {
      const valueOptions = new Set([
        "-k",
        "--kill-after",
        "-s",
        "--signal",
      ])
      index = consumeOptions(words, index, valueOptions) ?? words.length
      if (index >= words.length) return undefined
      index++ // duration
      continue
    }

    const sudoValueOptions = new Set([
      "-C",
      "--close-from",
      "-D",
      "--chdir",
      "-g",
      "--group",
      "-h",
      "--host",
      "-p",
      "--prompt",
      "-R",
      "--chroot",
      "-r",
      "--role",
      "-T",
      "--command-timeout",
      "-t",
      "--type",
      "-u",
      "--user",
    ])
    index = consumeOptions(words, index, sudoValueOptions) ?? words.length
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(staticWord(words[index]) ?? "")) index++
  }

  return undefined
}

const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
])

const JJ_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-R",
  "--repository",
  "--at-op",
  "--at-operation",
  "--color",
  "--config",
  "--config-file",
])

function findSubcommand(
  words: Word[],
  start: number,
  optionsWithValues: Set<string>,
): number | undefined {
  const index = consumeOptions(words, start, optionsWithValues)
  return index !== undefined && index < words.length ? index : undefined
}

interface MessageArguments {
  messages: Word[]
  terminator?: Word
}

// Value-taking options that may appear between a jj subcommand and its
// arguments, so their values are never mistaken for message flags.
const JJ_SUBCOMMAND_OPTIONS_WITH_VALUES: Record<string, string[]> = {
  commit: ["--tool"],
  ci: ["--tool"],
  describe: ["-r", "--revision"],
  desc: ["-r", "--revision"],
  new: ["-A", "--insert-after", "-B", "--insert-before"],
}

function findMessageArguments(
  words: Word[],
  start: number,
  optionsWithValues: Set<string>,
): MessageArguments {
  const messages: Word[] = []

  for (let index = start; index < words.length; index++) {
    const word = words[index]
    const value = staticWord(word)
    if (value === undefined) continue
    if (value === "--") return { messages, terminator: word }

    if (value === "-m" || value === "--message") {
      if (words[index + 1]) messages.push(words[++index])
      continue
    }
    if (value.startsWith("--message=")) {
      messages.push(word)
      continue
    }
    if (value.startsWith("-m") && value.length > 2) {
      messages.push(word)
      continue
    }

    const option = value.split("=", 1)[0]
    if (optionsWithValues.has(option) && !value.includes("=")) index++
  }

  return { messages }
}

function hasTrailer(words: Word[], trailer: string): boolean {
  return words.some((word) => staticWord(word)?.includes(trailer))
}

function jjMessageEdit(
  command: Command,
  words: Word[],
  subcommandIndex: number,
  trailer: string,
): Edit | undefined {
  const optionsWithValues = new Set([
    ...JJ_GLOBAL_OPTIONS_WITH_VALUES,
    ...(JJ_SUBCOMMAND_OPTIONS_WITH_VALUES[
      staticWord(words[subcommandIndex]) ?? ""
    ] ?? []),
  ])
  const { messages, terminator } = findMessageArguments(
    words,
    subcommandIndex + 1,
    optionsWithValues,
  )
  if (messages.length === 0 || hasTrailer(messages, trailer)) return undefined

  if (terminator) {
    return { position: terminator.pos, text: `-m ${ansiCQuote(trailer)} ` }
  }

  const lastArgument = command.suffix.at(-1)
  if (!lastArgument) return undefined
  return { position: lastArgument.end, text: ` -m ${ansiCQuote(trailer)}` }
}

function jjHunkMessage(
  words: Word[],
  subcommandIndex: number,
): Word | undefined {
  const args = words.slice(subcommandIndex + 1)
  const positional: Word[] = []
  let usesSpecFile = false
  let optionsEnded = false

  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    const value = staticWord(word)

    if (!optionsEnded && value === "--") {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && (value === "-f" || value === "--spec-file")) {
      usesSpecFile = true
      index++
      continue
    }
    if (
      !optionsEnded &&
      (value?.startsWith("--spec-file=") ||
        (value?.startsWith("-f") && value.length > 2))
    ) {
      usesSpecFile = true
      continue
    }
    if (!optionsEnded && value?.startsWith("-") && value !== "-") continue
    positional.push(word)
  }

  return usesSpecFile ? positional[0] : positional[1]
}

function editsForCommand(command: Command, trailer: string): Edit[] {
  const words = command.name ? [command.name, ...command.suffix] : command.suffix
  const resolved = unwrapCommand(words)
  if (!resolved) return []

  if (resolved.executable === "git") {
    const subcommandIndex = findSubcommand(
      words,
      resolved.executableIndex + 1,
      GIT_GLOBAL_OPTIONS_WITH_VALUES,
    )
    if (subcommandIndex === undefined || staticWord(words[subcommandIndex]) !== "commit")
      return []
    // Git's native --trailer (git >= 2.32) handles placement and covers -m,
    // -F, editor, --amend, and --fixup commits. Idempotence needs two layers:
    // the explicit guard below for trailers visible in the command itself, and
    // trailer.ifexists=addIfDifferent for trailers already in the target
    // message (e.g. --amend --no-edit), since git's default only dedups
    // adjacent duplicates.
    if (hasTrailer(words.slice(subcommandIndex + 1), trailer)) return []
    return [
      {
        position: words[resolved.executableIndex].end,
        text: " -c trailer.ifexists=addIfDifferent",
      },
      {
        position: words[subcommandIndex].end,
        text: ` --trailer ${ansiCQuote(trailer)}`,
      },
    ]
  }

  if (resolved.executable === "jj") {
    const subcommandIndex = findSubcommand(
      words,
      resolved.executableIndex + 1,
      JJ_GLOBAL_OPTIONS_WITH_VALUES,
    )
    if (
      subcommandIndex === undefined ||
      !JJ_SUBCOMMANDS.has(staticWord(words[subcommandIndex]) ?? "")
    )
      return []
    const edit = jjMessageEdit(command, words, subcommandIndex, trailer)
    return edit ? [edit] : []
  }

  if (resolved.executable !== "jj-hunk") return []
  const subcommandIndex = resolved.executableIndex + 1
  if (staticWord(words[subcommandIndex]) !== "commit") return []
  const message = jjHunkMessage(words, subcommandIndex)
  if (!message || staticWord(message)?.includes(trailer)) return []
  return [{ position: message.end, text: ansiCQuote(`\n\n${trailer}`) }]
}

function isWord(value: object): value is Word {
  return (
    typeof Reflect.get(value, "text") === "string" &&
    typeof Reflect.get(value, "value") === "string" &&
    typeof Reflect.get(value, "pos") === "number" &&
    typeof Reflect.get(value, "end") === "number"
  )
}

function collectEdits(script: ParsedScript, trailer: string): Edit[] {
  if (script.errors?.length) return []

  const edits: Edit[] = []
  const seen = new Set<object>()

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return
    // Escaped backtick substitutions use a decoded source with unrelated spans.
    if (Reflect.get(value, "type") === "Script") {
      // Escaped backticks use decoded source with unrelated spans. Malformed
      // nested scripts are skipped just like malformed root scripts.
      if (Reflect.get(value, "source") || Reflect.get(value, "errors")?.length)
        return
    }

    seen.add(value)
    if (Reflect.get(value, "type") === "Command") {
      edits.push(...editsForCommand(value as Command, trailer))
    }
    if (isWord(value)) {
      for (const part of value.parts ?? []) visit(part)
    }
    for (const child of Object.values(value)) visit(child)
  }

  visit(script)
  return edits
}

function ansiCQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("'", "\\'")
  return `$'${escaped}'`
}

export function appendTrailer(command: string, modelName: string): string {
  const trailer = `Co-Authored-By: ${modelName} <noreply@pi.dev>`
  let edits: Edit[]
  try {
    edits = collectEdits(parse(command), trailer).sort(
      (left, right) => right.position - left.position,
    )
  } catch {
    return command
  }

  let result = command
  for (const edit of edits) {
    result = `${result.slice(0, edit.position)}${edit.text}${result.slice(edit.position)}`
  }
  return result
}
