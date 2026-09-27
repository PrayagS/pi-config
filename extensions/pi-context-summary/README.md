# Pi Context Summary

Standalone batch summarization with recoverable tool outputs, targeting **Pi 1.0+**. Verified against **Pi 1.0.0** using real SDK sessions and fake providers; no live-model quality or savings benchmark is claimed.

After a completed task settles, older eligible outputs receive concise, per-source summaries. Subsequent requests replace those outputs with small paired stubs pointing to `context_recall`. The original assistant calls, thinking/signatures, result IDs, error flags, usage and nested metadata remain intact. Originals stay in Pi's canonical session; there is no separate raw-output archive.

## Activate

From this repository's root:

```sh
pi -e ./extensions/pi-context-summary/index.ts
```

For persistent installation, explicitly run `pi install /absolute/path/to/extensions/pi-context-summary`. Installation/activation is your choice: this package is **not added to the repository's root manifest or your settings automatically**.

**Data destination:** defaults to the currently selected logical model through Pi's model registry. A virtual router may choose a different physical provider for direct summarization than for agent turns. Check its routing policy before enabling. Selecting another registered model explicitly opts into sending eligible full tool text and arguments to that destination. No credentials are copied or stored by this extension.

## Commands and tools

| Command | Effect |
| --- | --- |
| `/context-summary status` | Destination, attempts, reported cost, pending work, eligibility and skip reasons |
| `/context-summary preview` | Read-only plan with refs, tool names and character counts; no model call |
| `/context-summary now` | Manually summarize eligible older outputs after waiting for idle; no extra agent turn |
| `/context-summary cancel` | Cancel the current job |
| `/context-summary on` / `off` | Explicitly save enabled state; off also suppresses unmodified generated summaries/stubs |
| `/context-summary mode auto` / `manual` | Choose automatic completed-task settlement or manual-only work |
| `/context-summary model default` | Use the current logical model |
| `/context-summary model provider/model-id` | Select a registered model and explicitly authorize this data destination |
| `/context-summary restore r_ENTRY_ID` | Show the current original output and protect it on this branch |
| `/context-summary resume r_ENTRY_ID` | Allow its existing valid summary to be used again |

**Ctrl+Alt+S** also cancels. Native Esc alone is not a guaranteed cancellation mechanism during settlement: Pi has already finished its agent run. Task completion can wait for summarization; this is bounded settlement work, not a detached daemon.

Model-facing tools:

```json
{"action":"preview"}
```

Use the above with `context_summary` (`status` is also supported). It is read-only and useful for structured headless inspection; command notifications use the UI rather than contaminating RPC/stdout.

```json
{"ref":"r_ENTRY_ID","offset":0,"limit":8192}
```

Use the above with `context_recall`. Follow `nextOffset` until it is `null`. Pages preserve Unicode code points; offsets are UTF-16 character positions. The text payload is bounded to 8192 UTF-16 units/32768 UTF-8 bytes, except that a requested one-unit page may contain one two-unit code point to make progress. Recall does not rerun tools, grant writes, or return a stale archived version. It returns **current projected** text, including any native replacement.

## Configuration

User-level `context-summary.json` lives in Pi's agent directory (normally `~/.pi/agent/`; respects `PI_CODING_AGENT_DIR`). Missing settings use defaults without creating a file. Only explicit configuration commands save, with in-process serialized atomic replacement and enforced mode `0600`. Separate Pi processes use last-writer-wins; settings are not automatically merged. Other active sessions load new settings on restart or `/reload`.

Advanced settings can be edited directly, then loaded with `/reload`. Unknown keys, malformed values and invalid bounds disable summarization. Invalid files are left untouched; correct them and reload before using configuration commands.

```json
{
  "enabled": true,
  "mode": "auto",
  "model": "default",
  "reasoning": "low",
  "keepRecentTurns": 2,
  "minSourceChars": 1500,
  "minBatchChars": 8000,
  "maxInputChars": 60000,
  "maxSourcesPerBatch": 12,
  "maxBatchesPerRun": 2,
  "maxSessionCalls": 20,
  "maxOutputTokens": 2000,
  "timeoutMs": 30000,
  "cooldownMs": 60000,
  "minSavingsRatio": 0.5,
  "allowedTools": ["read", "bash", "grep", "find", "ls", "codemode"],
  "protectedTools": ["context_recall", "context_summary", "ask_user", "subagent"]
}
```

- The latest two genuine user turns are excluded from candidate selection, including tool results within those turns. Summary/custom messages and tool results do not count as user turns.
- Only uniquely paired, non-error, text-only, allowlisted outputs qualify. Codemode needs complete nested-call metadata with identifiable, successful, allowlisted children; missing arguments, protected children and sensitive paths prevent summarization.
- Secret/path patterns are **defense in depth, not a complete secret detector**. Narrow the allowlist for sensitive projects. Eligible full text and arguments are sent to the selected model; no source-prefix excerpts are substituted.
- `maxInputChars` bounds the full JSON source payload, including escaping and arguments, plus a fixed small instruction prompt outside that payload. Oversized sources are skipped, never silently truncated. Known model context/output limits are checked conservatively; unknown virtual-router target limits cannot be preflighted.
- Calls are sequential: at most two batches per job and twenty top-level summary attempts per session by default, across all branches and reloads. Failed/preflight-rejected attempts count too. No automatic retry loop. Failed, cancelled or wholly rejected jobs enter cooldown. Routers can perform additional internal requests of their own.
- The timeout is for the whole job, not each source. Cancellation has at most **250 ms** additional grace for reported final usage. Providers may still bill after cancellation or fail to return usage; this extension cannot force remote shutdown or invent missing usage.
- Savings are measured in characters after counting the summary **and** stub, not token/invoice savings. A summary that fails the savings requirement is discarded and the original remains visible.

## Correctness and limits

- Summary fingerprints bind the real source entry, assistant arguments, typed output, error state and nested provenance. Stubbing additionally requires the unchanged summary body and matching source version in the actual request seen by our context hook.
- Native edits/omissions remain authoritative. An unchanged stale summary is suppressed. An explicitly edited summary is kept as user/host-authored content but cannot authorize a stub. Omitted summaries are not reinjected or automatically regenerated for the same source version.
- Restore/resume and accepted versions are reconstructed from the **active branch**. Session-wide attempt/cost totals deliberately include other branches. Jobs recheck session, generation, trust, branch/leaf and source versions before committing; unrelated writes invalidate drafts. Tree/switch/fork/compaction/shutdown hooks cancel and await cleanup, even if another handler later vetoes the action.
- Final assistant replies are persisted **before** automatic summaries. Earlier boundary drafts are preserved; the extension never requests an additional agent turn. Pending source edits and synthetic preview IDs do not become durable recovery refs.
- Ordinary earlier context transformations are respected during planning. Later extensions can still alter requests or boundary drafts; no extension can guarantee their behavior.
- Summaries are labeled **untrusted, possibly lossy data**, not instructions or primary evidence. Use recall before relying on exact identifiers, values or historical claims. Model summarization can still make mistakes or mishandle prompt injection.
- Native omissions/compaction can make an original unavailable to recall. This extension intentionally does **not** bypass them by reading raw all-history entries. Original tool truncation also cannot be recovered beyond what Pi recorded.
- Suppression is **not erasure**: original outputs, old summaries and context-edit entries remain in Pi's append-only session file. Disk size is not reduced and editing sensitive content out of context does not remove it from disk.
- When Pi exposes `SessionManager.appendUsage`, reported physical-model usage contributes to native session totals. Otherwise it is recorded separately and disclosed in status. Recording is once per attempt, including available partial/error/cancelled usage. Status keeps `usageMayBeIncomplete: true` as a constant disclaimer, not a detected per-attempt condition: these are reported/catalog costs, not final billing or proof of subscription charges. Late usage beyond the 250 ms grace is not appended; router-internal calls and unreported remote usage may be additional.

## Development

```sh
cd extensions/pi-context-summary
npm install
npm run check
```

Requires Bun for tests. Typecheck covers production source against Pi's installed types. Tests cover the pure projection engine, configuration, stream accounting/bounds, and real Pi SDK loading, virtual routing, persisted sessions, native edits, branches, pairing, cancellation, accounting fallbacks, stale leases, and boundary composition. Test providers are in-process fakes with network blocked; no paid model calls are needed.
