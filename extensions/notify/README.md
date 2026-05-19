# notify

Pi extension that sends terminal-native notifications when agent finishes and is ready for input.

## Supported targets

- OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
- OSC 99: Kitty
- tmux passthrough:
  - OSC 99 when the outer terminal is Kitty
  - OSC 777 when the outer terminal is Ghostty, iTerm2, or WezTerm
  - OSC 9 body-only fallback otherwise
- BEL terminal bell after terminal-native notification, for urgency hints / tab flash
- Zed terminal: BEL-only (`ZED_TERM=true`)

Current behavior: on `agent_end`, send notification titled `Pi` with body `Ready for input`, then emit BEL. Windows Terminal PowerShell toast support has been removed.
