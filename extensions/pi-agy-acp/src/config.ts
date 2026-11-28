import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** One Antigravity reasoning effort. */
export type Effort = (typeof EFFORTS)[number]

/** Supported quota percentage display conventions. */
export const QUOTA_DISPLAY_MODES = ['used', 'remaining'] as const
/** Quota percentage display convention (`used` counts up from 0%, `remaining` counts down from 100%). */
export type QuotaDisplay = (typeof QUOTA_DISPLAY_MODES)[number]
/** Default quota percentage display convention when no env var or saved preference is set. */
export const DEFAULT_QUOTA_DISPLAY: QuotaDisplay = 'used'

/** Validated plugin configuration. */
export interface Config {
  /** Provider route id shown in the model picker. */
  provider: string
  /** Display name of the provider group. */
  displayName: string
  /** Absolute path of the `agy` executable; empty resolves `~/.local/bin/agy`, then `agy` on PATH. */
  command: string
  /** Isolated Antigravity home for ACP sessions; empty uses `~/.pi/agent/cache/antigravity-acp`. */
  home: string
  /** Absolute project directory for opt-in native agy file writes. */
  nativeWriteRoot?: string
  /** Effort applied when a request carries none. */
  defaultEffort: Effort
  /** Maximum concurrent ACP sessions kept alive across conversations, subagents, and auxiliary calls. */
  maxLiveSessions: number
  /** Idle time after which inactive ACP sessions and an otherwise idle ACP process are closed. */
  idleSessionTtlMs: number
  /** Window that groups parallel tool calls into one Pi step. */
  parkSettleMs: number
  /** SSE keepalive interval for parked tool calls. */
  keepAliveMs: number
  /** Delay in ms before a parked tool call detaches via cancel-and-drain before agy's 180s MCP deadline. */
  detachAfterMs: number
  /** Maximum ms to wait for `session/cancel` or mid-turn steer acknowledgement. */
  cancelTimeoutMs: number
  /** Automatic continuations after an output-length stop (long decode). */
  longDecodeContinuations: number
  /** Minimum interval between quota refreshes through `agy -p /usage`. */
  quotaTtlMs: number
}

export const defaults: Config = {
  provider: 'antigravity-acp',
  displayName: 'Antigravity ACP',
  command: '',
  home: '',
  defaultEffort: 'high',
  maxLiveSessions: 16,
  idleSessionTtlMs: 1800000,
  parkSettleMs: 250,
  keepAliveMs: 15000,
  detachAfterMs: 140000,
  cancelTimeoutMs: 15000,
  longDecodeContinuations: 3,
  quotaTtlMs: 120000,
}

export function asEffort(value: string | undefined): Effort | undefined {
  return EFFORTS.includes(value as Effort) ? (value as Effort) : undefined
}

export function asQuotaDisplay(
  value: string | undefined,
): QuotaDisplay | undefined {
  const normalized = value?.trim().toLowerCase()
  return QUOTA_DISPLAY_MODES.includes(normalized as QuotaDisplay)
    ? (normalized as QuotaDisplay)
    : undefined
}

export const SETTINGS_FILE = 'antigravity-acp.json'

export interface Preferences {
  command: string
  home: string
  quotaDisplay: QuotaDisplay
  debug: boolean
  nativeWrites: boolean
}

export const PREFERENCE_KEYS = ['command', 'home', 'quotaDisplay', 'debug', 'nativeWrites'] as const
export type PreferenceKey = typeof PREFERENCE_KEYS[number]

function readSettingsFile(path: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`Expected a JSON object in ${path}`)
  return parsed as Record<string, unknown>
}

/** Read a JSON file as a plain object, returning `{}` when missing or invalid. */
export function readJson(path: string): Record<string, unknown> {
  try {
    return readSettingsFile(path) ?? {}
  } catch {
    return {}
  }
}

function absolutePreferencePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return
  const path = /^[~][\\/]/.test(value) ? join(homedir(), value.slice(2)) : value
  if (isAbsolute(path)) return path
}

function parsePreferences(settings: Record<string, unknown>): Preferences {
  return {
    command: absolutePreferencePath(settings.command) ?? '',
    home: absolutePreferencePath(settings.home) ?? '',
    quotaDisplay: typeof settings.quotaDisplay === 'string'
      ? asQuotaDisplay(settings.quotaDisplay) ?? DEFAULT_QUOTA_DISPLAY
      : DEFAULT_QUOTA_DISPLAY,
    debug: settings.debug === true,
    nativeWrites: settings.nativeWrites === true,
  }
}

function legacyPreferences(stateHome: string): Record<string, unknown> {
  const { nativeWrites, quotaDisplay } = readJson(join(stateHome, 'settings.json'))
  return { nativeWrites, quotaDisplay }
}

/** Read previous saved preferences only if the new config does not exist. */
export function readPreferences(path: string, stateHome: string): Preferences {
  try {
    return parsePreferences(readSettingsFile(path) ?? legacyPreferences(stateHome))
  } catch {
    return parsePreferences({})
  }
}

/** Parse one slash-command value. `default` removes the corresponding override. */
export function parsePreferenceValue(key: PreferenceKey, text: string): string | boolean | undefined {
  if (text === 'default') return undefined
  if (key === 'command' || key === 'home') {
    const path = absolutePreferencePath(text)
    if (path !== undefined) return path
    throw new Error(`${key} requires an absolute path or default.`)
  }
  if (key === 'quotaDisplay') {
    const display = asQuotaDisplay(text)
    if (display !== undefined) return display
    throw new Error('quotaDisplay requires used, remaining, or default.')
  }
  if (text === 'on' || text === 'true') return true
  if (text === 'off' || text === 'false') return false
  throw new Error(`${key} requires on, off, or default.`)
}

export function writePreferences(
  path: string,
  stateHome: string,
  patch: Partial<Record<PreferenceKey, string | boolean | undefined>>,
): Preferences {
  // Do not overwrite an unreadable or malformed config with a partial update.
  const settings = { ...(readSettingsFile(path) ?? legacyPreferences(stateHome)), ...patch }
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tempPath = join(dir, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(tempPath, path)
  } finally {
    try {
      unlinkSync(tempPath)
    } catch {
      // Best-effort cleanup; after rename this path no longer exists.
    }
  }
  return parsePreferences(settings)
}
