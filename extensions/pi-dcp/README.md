# Pi-DCP: Dynamic Context Pruning Extension

![Monolith logo](pi-dcp-banner.png)

Intelligently prunes conversation context to optimize token usage while preserving conversation coherence.

## Features

- **Deduplication**: Removes duplicate tool outputs based on content hash
- **Superseded Writes**: Removes older file writes when newer versions exist
- **Error Purging**: Removes resolved errors from context
- **Recency Protection**: Always preserves recent messages
- **Turn Protection**: Shields messages from the last N agent turns against automatic pruning
- **Tool Pairing**: Guarantees tool_use/tool_result pairs are never broken (API compliance)

## Installation

Clone the repository into your pi agent extensions directory:

```bash
git clone https://github.com/zenobi-us/pi-dcp.git ~/.pi/agent/extensions/pi-dcp
```

## Usage

The extension runs automatically on every LLM call. No manual intervention needed.

### Commands

- `/dcp-debug` - Toggle debug logging
- `/dcp-stats` - Show pruning statistics for current session
- `/dcp-toggle` - Enable/disable the extension
- `/dcp-recent <number>` - Set how many recent messages to always keep (default: 10)

### Flags

- `--dcp-enabled=true/false` - Enable/disable extension at startup
- `--dcp-debug=true/false` - Enable debug logging at startup

## Architecture

### Workflow

1. **Prepare Phase**: Rules annotate message metadata
2. **Process Phase**: Rules make pruning decisions based on metadata
3. **Filter Phase**: Messages marked for pruning are removed

### Built-in Rules

Located in `src/rules/`:

1. **Deduplication** (`deduplication.ts`)
   - Prepare: Hash message content
   - Process: Mark duplicates for pruning

2. **Superseded Writes** (`superseded-writes.ts`)
   - Prepare: Extract file paths from write/edit operations
   - Process: Mark older writes to the same file for pruning

3. **Error Purging** (`error-purging.ts`)
   - Prepare: Identify errors and check if resolved
   - Process: Mark resolved errors for pruning

4. **Tool Pairing** (`tool-pairing.ts`)
   - Prepare: Extract tool IDs and type flags
   - Process: Forward pass cascades prune to orphaned results; backward pass protects tool_use when its result is kept

5. **Recency** (`recency.ts`)
   - Process: Protect last N messages from pruning (overrides other rules)

### Turn Protection

Turn protection prevents automatic rules from pruning messages in the most recent agent turns. This ensures that a burst of tool calls within a single turn won't be pruned just because the message count is high.

A "turn" increments on each user message. All assistant and tool result messages between two user messages share the same turn index.

**How it works:**

1. Before rules run, every message is annotated with a `turnIndex`
2. During the process phase, deduplication, error-purging, and superseded-writes each check `isTurnProtected()` before marking a message for pruning
3. Messages from the last N turns (configurable via `turnProtection.turns`) are skipped by auto-rules
4. The same config also gates the `<prunable-tools>` list, preventing the LLM from pruning recent tool outputs

Turn protection and recency are complementary:
- **Recency** protects the last N *messages* (position-based)
- **Turn protection** protects the last N *turns* (semantic — a turn can contain many messages)

This means a single turn with 20 tool calls is fully protected by turn protection even if `keepRecentCount` is only 4.

### Configuration

Default configuration in `src/config.ts`:

```typescript
{
  enabled: true,
  debug: false,
  rules: ['deduplication', 'superseded-writes', 'error-purging', 'tool-pairing', 'recency'],
  keepRecentCount: 10,
  turnProtection: { enabled: true, turns: 3 }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master toggle |
| `debug` | `boolean` | `false` | Verbose logging |
| `rules` | `(string \| PruneRule)[]` | see above | Rules to run, in order |
| `keepRecentCount` | `number` | `10` | Always keep last N messages (recency) |
| `turnProtection.enabled` | `boolean` | `true` | Enable turn-based protection |
| `turnProtection.turns` | `number` | `3` | Number of recent turns to protect |

## Custom Rules

Create custom pruning rules by implementing the `PruneRule` interface:

```typescript
import type { PruneRule } from "./src/types";

const myRule: PruneRule = {
  name: "my-custom-rule",
  description: "My custom pruning logic",

  prepare(msg, ctx) {
    // Annotate metadata during prepare phase
    msg.metadata.myScore = calculateScore(msg.message);
  },

  process(msg, ctx) {
    // Make pruning decision during process phase
    if (msg.metadata.myScore < threshold) {
      msg.metadata.shouldPrune = true;
      msg.metadata.pruneReason = "low score";
    }
  },
};
```

Then add to configuration: `rules: ['deduplication', myRule]`

## Development

### Type Checking

```bash
bun run typecheck
```

### Project Structure

```
pi-dcp/
├── index.ts              # Main extension entry point
├── package.json          # Bun package config
├── tsconfig.json         # TypeScript config
├── src/
│   ├── types.ts          # Core type definitions
│   ├── config.ts         # Configuration management
│   ├── metadata.ts       # Message metadata + turn protection helpers
│   ├── registry.ts       # Rule registration system
│   ├── workflow.ts       # Prepare > Process > Filter workflow
│   ├── tool-cache.ts     # Tracks tool calls for LLM-driven pruning
│   ├── tokens.ts         # Token counting utilities
│   ├── prompts.ts        # Prunable-tools list + nudge prompts
│   ├── events/
│   │   └── context.ts    # Context event handler (layer 1 + 2 + injection)
│   ├── tools/             # LLM-callable tools (prune, distill, compress)
│   ├── rules/
│   │   ├── deduplication.ts
│   │   ├── superseded-writes.ts
│   │   ├── error-purging.ts
│   │   ├── tool-pairing.ts
│   │   └── recency.ts
│   └── __tests__/
│       ├── tool-pairing.test.ts
│       └── turn-protection.test.ts
└── README.md
```

## How It Works

### Layer 1: Automatic Rule-Based Pruning

1. **Context Event Hook**: The extension subscribes to the `context` event, which fires before each LLM call
2. **Message Processing**: All messages are wrapped with metadata containers
3. **Turn Annotation**: Each message is stamped with a `turnIndex` (increments on user messages)
4. **Prepare Phase**: Each rule's `prepare` function annotates metadata (hashes, file paths, etc.)
5. **Process Phase**: Each rule's `process` function makes pruning decisions. Rules check turn protection via `isTurnProtected()` before marking messages.
6. **Repair Phase**: Orphaned tool pairs from rule interactions are fixed
7. **Filter Phase**: Messages marked with `shouldPrune: true` are removed

### Layer 2: LLM-Driven Pruning

8. **Tool Cache Sync**: Tool calls are indexed with numeric IDs
9. **Apply Decisions**: Previous `dcp_prune`, `dcp_distill`, and `dcp_compress` calls are applied (stub/replace/summarize)
10. **Post-Repair**: Final safety net fixes any orphaned pairs from layer 2

### Layer 3: Context Injection

11. **Prunable Tools List**: `<prunable-tools>` block injected into context (respects turn protection)
12. **Nudge Prompts**: Periodic or threshold-based nudges encourage the LLM to manage context

## Benefits

- **Token Savings**: Removes redundant and obsolete messages
- **Cost Reduction**: Fewer tokens = lower API costs
- **Preserved Coherence**: Smart rules keep important context
- **Transparent**: No changes to user experience
- **Configurable**: Adjust rules and thresholds as needed
- **Extensible**: Easy to add custom rules

## Example Output

```
[pi-dcp] Initialized with 4 rules: deduplication, superseded-writes, error-purging, recency
[pi-dcp] Pruned 12 / 45 messages
[pi-dcp] Pruned 8 / 52 messages
```

With debug mode enabled (`/dcp-debug`):

```
[pi-dcp] Dedup: marking duplicate message at index 15 (hash: k2l9x)
[pi-dcp] SupersededWrites: found file operation at index 23: src/index.ts
[pi-dcp] SupersededWrites: marking superseded write at index 23: src/index.ts
[pi-dcp] ErrorPurging: found resolved error at index 31
[pi-dcp] Recency: protecting message at index 48 (distance from end: 3, threshold: 10)
[pi-dcp] Filter phase complete: 12 pruned, 33 kept (45 total)
[pi-dcp] Pruned messages:
  [15] assistant: duplicate content
  [23] toolResult: superseded by later write to src/index.ts
  [31] toolResult: error resolved by later success
  ...
```

## License

MIT
