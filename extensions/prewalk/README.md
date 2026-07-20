# Prewalk

Pi extension for one-way strong-model to fast-model handoffs.

The current model explores, produces a concrete plan, and starts implementation.
After its first successful `edit` or `write`, Pi switches to the configured target
model and immediately continues with a hidden completion checklist.

## Usage

Configure a default target:

```text
/prewalk target openai-codex/gpt-5.4-mini
/prewalk target openai-codex/gpt-5.4-mini high
```

Arm prewalk for the next task:

```text
/prewalk
```

Use a one-off target without changing the saved default:

```text
/prewalk anthropic/claude-haiku-4-5
/prewalk anthropic/claude-haiku-4-5 medium
```

Other commands:

```text
/prewalk status
/prewalk off
/prewalk target
```

`/prewalk target` opens a model selector. The first target selected when no
configuration exists is also saved.

Launch-time activation:

```bash
pi --prewalk
pi --prewalk-target openai-codex/gpt-5.4-mini
pi --prewalk --prewalk-target openai-codex/gpt-5.4-mini
```

`--prewalk-target` implies `--prewalk`.

## Configuration

Default target is stored globally at `~/.pi/agent/prewalk.json`:

```json
{
  "target": "openai-codex/gpt-5.4-mini",
  "thinkingLevel": "high"
}
```

Supported thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`. When omitted, Pi and other model-selection extensions decide target
thinking level normally.

## Handoff behavior

1. `/prewalk` arms a one-shot handoff. Current model remains selected.
2. Before next agent run, extension injects a hidden deep-plan instruction.
3. Exploration tools such as `read`, `grep`, and `bash` do not trigger handoff.
4. If active tool set contains `todo`, first successful `todo` call opens action
   gate. Without active `todo`, gate starts open.
5. First successful `edit` or `write` completes current assistant turn.
6. Extension removes plan instruction from target model context, changes model,
   and steers hidden verification checklist into next turn.
7. Handoff disarms. Model switch is one-way.

A hidden continuation message prevents text-only planning replies from ending
run before implementation starts. One continuation is armed by each tool-bearing
planning turn, matching oh-my-pi's loop guard.

Unlike oh-my-pi's internal ephemeral switch, Pi's public extension API only
exposes `setModel()`. Pi persists that selection as its default model, so the
target remains selected after handoff and for later sessions until changed.

## Implementation source

Adapted from oh-my-pi prewalk implementation:

- `packages/coding-agent/src/session/agent-session.ts`
  - `Prewalk`
  - `#advancePrewalk()`
  - `armPrewalk()`
  - `#scrubPrewalkPlanNudge()`
- `packages/coding-agent/src/prompts/system/prewalk-plan.md`
- `packages/coding-agent/src/prompts/system/prewalk-continue.md`
- `packages/coding-agent/src/prompts/system/prewalk-checklist.md`
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `packages/coding-agent/src/main.ts`

Pi adaptation uses public extension hooks only: `before_agent_start`, `turn_end`,
`context`, `setModel()`, and `sendMessage()`.
