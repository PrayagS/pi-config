# notify

Pi extension that sends terminal-native notifications when agent finishes and is ready for input.

## Supported targets

- OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
- OSC 99: Kitty
- tmux passthrough
- Windows Terminal toast via PowerShell

Current behavior: on `agent_end`, send notification titled `Pi` with body `Ready for input`.
