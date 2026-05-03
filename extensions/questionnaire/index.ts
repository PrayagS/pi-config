import { accessSync, constants as fsConstants } from "node:fs"
import { delimiter, join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import {
  CombinedAutocompleteProvider,
  Editor,
  type EditorTheme,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"

type QuestionType = "single" | "multi" | "preview"

interface QuestionOption {
  value: string
  label: string
  description?: string
  preview?: string
  freeform?: boolean
}

interface Question {
  id: string
  label: string
  prompt: string
  type: QuestionType
  required: boolean
  options: QuestionOption[]
}

interface Answer {
  id: string
  values: string[]
  labels: string[]
  indices: number[]
  customText?: string
}

interface QuestionnaireResult {
  title?: string
  questions: Question[]
  answers: Record<string, Answer>
  cancelled: boolean
  mode: "submit"
}

const OTHER_VALUE = "__other__"
const OTHER_LABEL = "Type your own"
const FD_BINARY_NAMES =
  process.platform === "win32"
    ? ["fd.exe", "fdfind.exe", "fd", "fdfind"]
    : ["fd", "fdfind"]

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" })
  ),
  preview: Type.Optional(
    Type.String({ description: "Preview pane content for preview questions" })
  ),
})

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({ description: "Short tab label, e.g. Scope, Priority" })
  ),
  prompt: Type.String({ description: "The question text to display" }),
  type: Type.Optional(
    Type.String({
      description: 'Question type: "single", "multi", or "preview"',
    })
  ),
  required: Type.Optional(
    Type.Boolean({ description: "Metadata only; does not block submission" })
  ),
  options: Type.Array(QuestionOptionSchema, {
    description: "Available options to choose from",
  }),
})

const QuestionnaireParams = Type.Object({
  title: Type.Optional(Type.String({ description: "Optional flow title" })),
  questions: Type.Array(QuestionSchema, {
    description: "Questions to ask the user",
  }),
})

function errorResult(message: string): {
  content: { type: "text"; text: string }[]
  details: QuestionnaireResult
} {
  return {
    content: [{ type: "text", text: message }],
    details: {
      questions: [],
      answers: {},
      cancelled: true,
      mode: "submit",
    },
  }
}

function normalizeType(value: unknown): QuestionType {
  return value === "multi" || value === "preview" ? value : "single"
}

function normalizeQuestions(params: {
  questions: Array<{
    id: string
    label?: string
    prompt: string
    type?: string
    required?: boolean
    options: QuestionOption[]
  }>
}): Question[] {
  return params.questions.map((q, i) => ({
    id: q.id,
    label: q.label || `Q${i + 1}`,
    prompt: q.prompt,
    type: normalizeType(q.type),
    required: q.required === true,
    options: q.options.map((o) => ({ ...o })),
  }))
}

function withOther(q: Question): QuestionOption[] {
  return [...q.options, { value: OTHER_VALUE, label: OTHER_LABEL, freeform: true }]
}

function findAutocompleteBinary(): string | null {
  const pathValue = process.env.PATH
  if (!pathValue) return null
  for (const binaryName of FD_BINARY_NAMES) {
    for (const directory of pathValue.split(delimiter).filter(Boolean)) {
      const executablePath = join(directory, binaryName)
      try {
        accessSync(executablePath, fsConstants.X_OK)
        return executablePath
      } catch {
        // keep searching
      }
    }
  }
  return null
}

function createAutocompleteProvider(cwd: string) {
  return new CombinedAutocompleteProvider([], cwd, findAutocompleteBinary())
}

export default function questionnaire(pi: ExtensionAPI) {
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more structured questions. Supports single-select, multi-select, preview-pane questions, review tab, and inline free-form answers with @ file references.",
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult("Error: UI not available (running in non-interactive mode)")
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided")
      }

      const questions = normalizeQuestions(params)
      const totalTabs = questions.length + 1
      const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
        let currentTab = 0
        let optionIndex = 0
        let inputMode = false
        let inputQuestionId: string | null = null
        let cachedLines: string[] | undefined
        const answers = new Map<string, Answer>()

        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        }
        const editor = new Editor(tui, editorTheme)
        editor.setAutocompleteProvider(createAutocompleteProvider(ctx.cwd))

        function refresh() {
          cachedLines = undefined
          tui.requestRender()
        }

        function submit(cancelled: boolean) {
          done({
            title: params.title,
            questions,
            answers: Object.fromEntries(answers),
            cancelled,
            mode: "submit",
          })
        }

        function currentQuestion(): Question | undefined {
          return questions[currentTab]
        }

        function currentOptions(): QuestionOption[] {
          const q = currentQuestion()
          return q ? withOther(q) : []
        }

        function setSingleAnswer(q: Question, opt: QuestionOption, index: number) {
          if (opt.freeform) {
            inputMode = true
            inputQuestionId = q.id
            editor.setText(answers.get(q.id)?.customText ?? "")
            refresh()
            return
          }
          answers.set(q.id, {
            id: q.id,
            values: [opt.value],
            labels: [opt.label],
            indices: [index + 1],
          })
          if (currentTab < questions.length - 1) currentTab++
          else currentTab = questions.length
          optionIndex = 0
          refresh()
        }

        function toggleMultiAnswer(q: Question, opt: QuestionOption, index: number) {
          if (opt.freeform) {
            inputMode = true
            inputQuestionId = q.id
            editor.setText(answers.get(q.id)?.customText ?? "")
            refresh()
            return
          }
          const existing = answers.get(q.id) ?? {
            id: q.id,
            values: [],
            labels: [],
            indices: [],
          }
          const pos = existing.values.indexOf(opt.value)
          if (pos >= 0) {
            existing.values.splice(pos, 1)
            existing.labels.splice(pos, 1)
            existing.indices.splice(pos, 1)
          } else {
            existing.values.push(opt.value)
            existing.labels.push(opt.label)
            existing.indices.push(index + 1)
          }
          if (existing.values.length || existing.customText) answers.set(q.id, existing)
          else answers.delete(q.id)
          refresh()
        }

        editor.onSubmit = (value) => {
          if (!inputQuestionId) return
          const q = questions.find((question) => question.id === inputQuestionId)
          if (!q) return
          const trimmed = value.trim()
          const existing = answers.get(q.id) ?? {
            id: q.id,
            values: [],
            labels: [],
            indices: [],
          }
          if (trimmed) {
            if (q.type === "multi") {
              existing.customText = trimmed
              if (!existing.values.includes(OTHER_VALUE)) {
                existing.values.push(OTHER_VALUE)
                existing.labels.push(trimmed)
                existing.indices.push(q.options.length + 1)
              } else {
                const idx = existing.values.indexOf(OTHER_VALUE)
                existing.labels[idx] = trimmed
              }
              answers.set(q.id, existing)
            } else {
              answers.set(q.id, {
                id: q.id,
                values: [OTHER_VALUE],
                labels: [trimmed],
                indices: [q.options.length + 1],
                customText: trimmed,
              })
            }
          } else if (q.type === "multi") {
            delete existing.customText
            const idx = existing.values.indexOf(OTHER_VALUE)
            if (idx >= 0) {
              existing.values.splice(idx, 1)
              existing.labels.splice(idx, 1)
              existing.indices.splice(idx, 1)
            }
            if (existing.values.length) answers.set(q.id, existing)
            else answers.delete(q.id)
          }
          inputMode = false
          inputQuestionId = null
          editor.setText("")
          if (q.type === "multi") refresh()
          else if (currentTab < questions.length - 1) {
            currentTab++
            optionIndex = 0
            refresh()
          } else {
            currentTab = questions.length
            optionIndex = 0
            refresh()
          }
        }

        function handleInput(data: string) {
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = false
              inputQuestionId = null
              editor.setText("")
              refresh()
              return
            }
            editor.handleInput(data)
            refresh()
            return
          }

          if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            currentTab = (currentTab + 1) % totalTabs
            optionIndex = 0
            refresh()
            return
          }
          if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
            currentTab = (currentTab - 1 + totalTabs) % totalTabs
            optionIndex = 0
            refresh()
            return
          }
          if (matchesKey(data, Key.escape)) {
            submit(true)
            return
          }

          if (currentTab === questions.length) {
            if (matchesKey(data, Key.enter)) submit(false)
            return
          }

          const q = currentQuestion()
          const opts = currentOptions()
          if (!q) return

          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1)
            refresh()
            return
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(opts.length - 1, optionIndex + 1)
            refresh()
            return
          }
          const digit = data >= "1" && data <= "9" ? Number(data) : 0
          if (digit > 0 && digit <= opts.length) {
            optionIndex = digit - 1
            const opt = opts[optionIndex]
            q.type === "multi" ? toggleMultiAnswer(q, opt, optionIndex) : setSingleAnswer(q, opt, optionIndex)
            return
          }
          if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
            const opt = opts[optionIndex]
            q.type === "multi" ? toggleMultiAnswer(q, opt, optionIndex) : setSingleAnswer(q, opt, optionIndex)
          }
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines
          const lines: string[] = []
          const add = (s = "") => lines.push(truncateToWidth(s, width))
          const q = currentQuestion()
          const opts = currentOptions()

          add(theme.fg("accent", "─".repeat(width)))
          if (params.title) add(` ${theme.fg("accent", theme.bold(params.title))}`)
          renderTabs(lines, width, theme, questions, currentTab, answers)

          if (inputMode && q) {
            add(theme.fg("text", ` ${q.prompt}`))
            add("")
            add(theme.fg("muted", " Type your answer. Use @ to reference files."))
            for (const line of editor.render(width - 2)) add(` ${line}`)
            add("")
            add(theme.fg("dim", " Enter save • Esc cancel editor"))
          } else if (currentTab === questions.length) {
            renderReview(lines, width, theme, questions, answers)
          } else if (q) {
            add(theme.fg("text", ` ${q.prompt}`))
            add("")
            if (q.type === "preview") renderPreview(lines, width, theme, opts, optionIndex, answers.get(q.id))
            else renderOptions(lines, width, theme, opts, optionIndex, answers.get(q.id), q.type)
          }

          add("")
          add(theme.fg("dim", " Tab/←→ tabs • ↑↓ move • 1-9 choose • Enter/Space select • Esc cancel"))
          add(theme.fg("accent", "─".repeat(width)))
          cachedLines = lines
          return lines
        }

        return { render, invalidate: () => (cachedLines = undefined), handleInput }
      })

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        }
      }

      const text = Object.values(result.answers)
        .map((a) => `${a.id}: ${a.labels.join(", ")}`)
        .join("\n")
      return { content: [{ type: "text", text }], details: result }
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[]) || []
      const labels = qs.map((q) => q.label || q.id).join(", ")
      let text = theme.fg("toolTitle", theme.bold("questionnaire "))
      text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`)
      if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`)
      return new Text(text, 0, 0)
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionnaireResult | undefined
      if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0)
      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0)
      const lines = Object.values(details.answers).map(
        (a) => `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${a.labels.join(", ")}`
      )
      return new Text(lines.join("\n"), 0, 0)
    },
  })
}

function renderTabs(lines: string[], width: number, theme: any, questions: Question[], currentTab: number, answers: Map<string, Answer>) {
  const tabs: string[] = []
  for (let i = 0; i < questions.length; i++) {
    const active = i === currentTab
    const answered = answers.has(questions[i].id)
    const text = ` ${answered ? "■" : "□"} ${questions[i].label} `
    tabs.push(active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text))
  }
  const review = " Review "
  tabs.push(currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", review)) : theme.fg("accent", review))
  lines.push(truncateToWidth(` ${tabs.join(" ")}`, width))
  lines.push("")
}

function renderOptions(lines: string[], width: number, theme: any, opts: QuestionOption[], optionIndex: number, answer: Answer | undefined, type: QuestionType) {
  for (let i = 0; i < opts.length; i++) {
    const opt = opts[i]
    const selected = i === optionIndex
    const checked = answer?.indices.includes(i + 1)
    const mark = type === "multi" ? (checked ? "■" : "□") : checked ? "●" : "○"
    const prefix = selected ? theme.fg("accent", "> ") : "  "
    const label = `${mark} ${i + 1}. ${opt.freeform && answer?.customText ? answer.customText : opt.label}`
    lines.push(truncateToWidth(prefix + theme.fg(selected ? "accent" : "text", label), width))
    if (opt.description) lines.push(truncateToWidth(`     ${theme.fg("muted", opt.description)}`, width))
  }
}

function renderPreview(lines: string[], width: number, theme: any, opts: QuestionOption[], optionIndex: number, answer: Answer | undefined) {
  const leftWidth = width >= 90 ? Math.min(34, Math.max(22, Math.floor(width * 0.34))) : width
  const left: string[] = []
  renderOptions(left, leftWidth, theme, opts, optionIndex, answer, "single")
  const selected = opts[optionIndex]
  const right = renderPreviewBox(selected, theme, Math.max(24, width - leftWidth - 2))
  if (width >= 90) {
    const rows = Math.max(left.length, right.length)
    for (let i = 0; i < rows; i++) {
      const l = padVisible(left[i] ?? "", leftWidth)
      lines.push(truncateToWidth(`${l}  ${right[i] ?? ""}`, width))
    }
  } else {
    lines.push(...left)
    lines.push("")
    lines.push(...renderPreviewBox(selected, theme, width))
  }
}

function renderPreviewBox(opt: QuestionOption | undefined, theme: any, width: number): string[] {
  const inner = Math.max(4, width - 4)
  const raw = [opt?.label ?? "No preview available"]
  if (opt?.description) raw.push(opt.description)
  raw.push("")
  raw.push(...(opt?.preview ?? "No preview available").split("\n"))
  const wrapped = raw.flatMap((line) => wrapTextWithAnsi(line, inner))
  const top = `┌${"─".repeat(inner + 2)}┐`
  const bottom = `└${"─".repeat(inner + 2)}┘`
  return [
    theme.fg("dim", top),
    ...wrapped.map((line, i) => {
      const color = i === 0 ? "accent" : opt?.preview ? "text" : "dim"
      return theme.fg("dim", "│ ") + theme.fg(color, padVisible(line, inner)) + theme.fg("dim", " │")
    }),
    theme.fg("dim", bottom),
  ]
}

function renderReview(lines: string[], width: number, theme: any, questions: Question[], answers: Map<string, Answer>) {
  lines.push(theme.fg("accent", theme.bold(" Review")))
  lines.push("")
  for (const q of questions) {
    const answer = answers.get(q.id)
    const text = answer ? answer.labels.join(", ") : theme.fg("dim", "Unanswered")
    lines.push(truncateToWidth(`${theme.fg("muted", ` ${q.label}: `)}${theme.fg("text", text)}`, width))
  }
  lines.push("")
  lines.push(theme.fg("success", " Press Enter to submit"))
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)))
}
