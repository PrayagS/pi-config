/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - OSC 9 via DCS passthrough: tmux
 * - BEL: universal bell (urgency hint / tab flash)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`)
}

function notifyOSC99(title: string, body: string): void {
  // Kitty OSC 99: first payload sets the title (d=0 = more data coming),
  // second payload sets the body (d defaults to 1 = done).
  process.stdout.write(`\x1b]99;i=1:d=0:p=title;${title}\x1b\\`)
  process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`)
}

function notifyTmux(title: string, body: string): void {
  // Detect the outer terminal to pick the best OSC protocol, then wrap in
  // tmux DCS passthrough (\x1bPtmux;…\x1b\\).  All ESC bytes inside the
  // passthrough must be doubled; the inner OSC must be terminated with BEL
  // (\x07) before the DCS ST (\x1b\\).
  if (process.env.KITTY_LISTEN_ON) {
    // Outer terminal is Kitty — use OSC 99
    process.stdout.write(
      `\x1bPtmux;\x1b\x1b]99;i=1:d=0:p=title;${title}\x1b\x1b\\\x1b\\`
    )
    process.stdout.write(
      `\x1bPtmux;\x1b\x1b]99;i=1:p=body;${body}\x1b\x1b\\\x1b\\`
    )
  } else if (
    process.env.GHOSTTY_RESOURCES_DIR ||
    process.env.ITERM_SESSION_ID ||
    process.env.WEZTERM_EXECUTABLE
  ) {
    // Outer terminal supports OSC 777 (Ghostty, iTerm2, WezTerm)
    process.stdout.write(
      `\x1bPtmux;\x1b\x1b]777;notify;${title};${body}\x07\x1b\\`
    )
  } else {
    // Fallback: OSC 9 (body only, widely supported)
    process.stdout.write(`\x1bPtmux;\x1b\x1b]9;${body}\x07\x1b\\`)
  }
}

function notifyBell(): void {
  process.stdout.write("\x07")
}

function notify(title: string, body: string): void {
  if (process.env.TMUX) {
    notifyTmux(title, body)
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body)
  } else {
    notifyOSC777(title, body)
  }
  notifyBell()
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    notify("Pi", "Ready for input")
  })
}
