# Caffeinate

Prevents macOS idle system sleep while Pi is working.

The extension starts macOS's built-in command when an agent run begins:

```text
/usr/bin/caffeinate -i -w <pi-pid>
```

`-i` prevents idle system sleep but still allows the display to sleep. `-w` also releases the assertion if the Pi process exits unexpectedly. The extension stops `caffeinate` on `agent_settled`, after retries, compaction, and queued follow-up work have finished, and on session shutdown.

There are no settings, commands, or third-party dependencies. The extension silently does nothing outside macOS.
