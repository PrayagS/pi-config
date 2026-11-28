import { join } from 'node:path'
import {
  BorderedLoader,
  getAgentDir,
  type ExtensionAPI,
  type ProviderModelConfig,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { AntigravityRuntime, type RuntimeHost } from './src/runtime.ts'
import {
  asQuotaDisplay,
  defaults,
  parsePreferenceValue,
  PREFERENCE_KEYS,
  readPreferences,
  SETTINGS_FILE,
  writePreferences,
  type PreferenceKey,
} from './src/config.ts'
import { spawnAcp, runCommand } from './src/host.ts'
import { appendNativeWriteEntry, registerNativeWriteEntries } from './src/native-write-entry.ts'
import { defaultHome } from './src/preflight.ts'
import { streamPi } from './src/pi-stream.ts'
import {
  displayFraction,
  formatQuota,
  formatStatus,
  formatQuotaStatus,
  quotaForModel,
} from './src/format.ts'
import type { QuotaSnapshot } from './src/quota.ts'

export default function (
  pi: ExtensionAPI,
  host: Partial<Pick<RuntimeHost, 'runCommand' | 'spawnAcp' | 'quotaNow'>> = {},
) {
  const config = defaults
  const stateHome = defaultHome()
  const configPath = join(getAgentDir(), SETTINGS_FILE)
  const launchCwd = process.cwd()
  let preferences = readPreferences(configPath, stateHome)
  let piSessionId: string | undefined
  registerNativeWriteEntries(pi)
  pi.on('tool_call', (event, ctx) => {
    if (
      preferences.nativeWrites && ctx.model?.provider === config.provider &&
      (event.toolName === 'edit' || event.toolName === 'write')
    ) return { block: true, reason: 'Use native agy file tools instead of Pi edit/write.' }
  })
  let refreshDepth = 0
  const createRuntime = () =>
    new AntigravityRuntime({
      config: {
        ...config,
        command: preferences.command,
        home: preferences.home || stateHome,
        nativeWriteRoot: preferences.nativeWrites ? launchCwd : undefined,
      },
      spawnAcp: host.spawnAcp ?? spawnAcp,
      runCommand: host.runCommand ?? runCommand,
      quotaNow: host.quotaNow,
      log: {
        info: () => {},
        warn: (message) => {
          if (preferences.debug) process.stderr.write(`[pi-agy-acp] ${message}\n`)
        },
      },
      onModelsChanged: () => {
        if (refreshDepth === 0) register()
      },
      onNativeWrite: (sessionId, activity) => {
        if (sessionId === piSessionId) appendNativeWriteEntry(pi, activity)
      },
    })
  let runtime = createRuntime()
  const models = (): ProviderModelConfig[] => {
    const input = runtime.catalog.inputModalities()
    return runtime.catalog.list().map((m) => {
      const efforts = runtime.catalog.effortsFor(m.id)
      return {
        id: m.id,
        name: m.name,
        input,
        reasoning: efforts.length > 0,
        thinkingLevelMap:
          efforts.length > 0
            ? {
                off: null,
                minimal: null,
                low: efforts.includes('low') ? 'low' : null,
                medium: efforts.includes('medium') ? 'medium' : null,
                high: efforts.includes('high') ? 'high' : null,
                xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
                max: efforts.includes('max') ? 'max' : null,
              }
            : undefined,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: runtime.contextWindowFor(m.id),
        maxTokens: runtime.maxTokensFor(m.id),
      }
    })
  }
  const register = () =>
    pi.registerProvider(config.provider, {
      name: config.displayName,
      api: 'antigravity-acp',
      baseUrl: 'acp://local',
      apiKey: 'local-agy',
      models: models(),
      streamSimple: (model, context, options) => {
        const allTools = pi.getAllTools()
        const toolFilter = (t: { name: string }) => {
          const tool = allTools.find((at) => at.name === t.name)
          // @ts-ignore - 'exposure' is a known property on tool objects
          return tool?.exposure !== 'codemode'
        }
        return streamPi(runtime, model, context, { ...options, toolFilter })
      },
      refreshModels: async (context) => {
        refreshDepth++
        try {
          if (context?.allowNetwork !== false && !context?.signal?.aborted) {
            await runtime.warmup({
              force: context?.force,
              signal: context?.signal,
            })
          }
          return models()
        } finally {
          refreshDepth--
        }
      },
    })
  register()
  let uiEpoch = 0
  let shutDown = false
  let activeRuntime: AntigravityRuntime | undefined = runtime
  let resetting: Promise<void> | undefined
  interface PendingSettle {
    runtime: AntigravityRuntime
    epoch: number
    ctx: ExtensionContext
    model: ExtensionContext['model']
  }
  let pendingSettle: PendingSettle | undefined
  const warned = new Set<string>()
  const clearStatus = (ctx?: ExtensionContext) => {
    uiEpoch++
    pendingSettle = undefined
    if (!shutDown && ctx?.hasUI) ctx.ui.setStatus(config.provider, undefined)
  }
  const updateStatus = (
    ctx: ExtensionContext,
    snapshot?: QuotaSnapshot,
    model = ctx.model,
  ) => {
    if (!shutDown && activeRuntime && ctx.hasUI && model?.provider === config.provider)
      ctx.ui.setStatus(
        config.provider,
        snapshot
          ? formatQuotaStatus(snapshot, model, preferences.quotaDisplay)
          : undefined,
      )
  }
  const reset = (purgeArtifacts = false) => {
    uiEpoch++
    warned.clear()
    pendingSettle = undefined
    activeRuntime = undefined
    if (resetting) return resetting
    const previous = runtime
    resetting = (async () => {
      try {
        await previous.dispose({ purgeArtifacts })
        if (shutDown) return
        runtime = activeRuntime = createRuntime()
      } finally {
        resetting = undefined
      }
    })()
    return resetting
  }
  pi.on('session_tree', () => activeRuntime?.resetConversations())
  pi.on('session_compact', () => activeRuntime?.resetConversations())
  pi.on('session_start', async (event, ctx) => {
    piSessionId = ctx.sessionManager.getSessionId()
    clearStatus(ctx)
    const epoch = uiEpoch
    if (resetting) await resetting.catch(() => {})
    if (shutDown) return
    if (['new', 'resume', 'fork'].includes(event.reason))
      await activeRuntime?.resetConversations()
    if (!shutDown && epoch === uiEpoch)
      updateStatus(ctx, activeRuntime?.quota.peek())
  })
  pi.on('session_shutdown', async (_event, ctx) => {
    piSessionId = undefined
    clearStatus(ctx)
    shutDown = true
    activeRuntime = undefined
    pendingSettle = undefined
    if (resetting) await resetting.catch(() => {})
    await runtime.dispose()
  })
  pi.on('cache_warming_decision', (_event, ctx) =>
    ctx.model?.provider === config.provider ? { action: 'stop' } : undefined,
  )
  pi.on('model_select', (event, ctx) => {
    const retarget =
      pendingSettle &&
      pendingSettle.runtime === activeRuntime &&
      pendingSettle.epoch === uiEpoch &&
      event.model?.provider === config.provider
        ? pendingSettle
        : undefined
    clearStatus(ctx)
    if (retarget) {
      retarget.epoch = uiEpoch
      retarget.ctx = ctx
      retarget.model = event.model
      pendingSettle = retarget
    }
    updateStatus(ctx, activeRuntime?.quota.peek(), event.model)
  })
  pi.on('agent_settled', (_event, ctx) => {
    // Pi 1.5.2 AgentSession._emitAgentSettled runs after tools and the run finish.
    runtime.settleSession(ctx.sessionManager.getSessionId())
    const current = activeRuntime
    if (!current || !ctx.hasUI || ctx.model?.provider !== config.provider) return
    if (pendingSettle?.runtime === current) {
      pendingSettle.epoch = uiEpoch
      pendingSettle.ctx = ctx
      pendingSettle.model = ctx.model
      return
    }
    const state: PendingSettle = {
      runtime: current,
      epoch: uiEpoch,
      ctx,
      model: ctx.model,
    }
    pendingSettle = state
    void current.quota
      .read(false)
      .then((snapshot) => {
        if (
          shutDown ||
          pendingSettle !== state ||
          state.runtime !== activeRuntime ||
          state.epoch !== uiEpoch ||
          snapshot.status !== 'ok'
        )
          return
        const targetCtx = state.ctx
        const model = state.model
        if (!targetCtx.hasUI || model?.provider !== config.provider) return
        updateStatus(targetCtx, snapshot, model)
        const quota = quotaForModel(snapshot, model)
        if (!quota || quota.fraction > 0.2) return
        const threshold = quota.fraction <= 0.05 ? 5 : 20
        const groupName = quota.group.name || 'Unnamed model group'
        const windowLabel =
          quota.bucket.window ||
          quota.bucket.name ||
          quota.bucket.id ||
          'quota'
        const key = `${groupName}:${quota.bucket.id}:${windowLabel}:${quota.bucket.resetTime || 'none'}:${threshold}`
        if (warned.has(key)) return
        warned.add(key)
        const percent = Math.round(
          displayFraction(quota.fraction, preferences.quotaDisplay) * 100,
        )
        const metric = `${percent}% ${preferences.quotaDisplay}`
        targetCtx.ui.notify(
          `Antigravity quota low: ${metric} (${groupName}, ${windowLabel}).`,
          'warning',
        )
      })
      .catch(() => {})
      .finally(() => {
        if (pendingSettle === state) pendingSettle = undefined
      })
  })
  const readQuotaSafe = async (): Promise<QuotaSnapshot> => {
    if (!activeRuntime)
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: [],
        error: 'Antigravity ACP runtime is disposed.',
      }
    try {
      return await activeRuntime.readQuota(true)
    } catch (err) {
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  type RefreshOutcome =
    | { status: 'ok'; count: number }
    | { status: 'cancelled' }
    | { status: 'error'; error: string }
  const refreshModelsSafe = async (
    signal?: AbortSignal,
  ): Promise<RefreshOutcome> => {
    const current = activeRuntime
    if (!current) {
      return {
        status: 'error',
        error: 'Antigravity ACP runtime is disposed.',
      }
    }
    try {
      await current.warmup({ force: true, signal })
      return { status: 'ok', count: current.catalog.list().length }
    } catch (err) {
      if (signal?.aborted) return { status: 'cancelled' }
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  const withLoader = <T>(
    ctx: ExtensionContext,
    label: string,
    cancelled: T,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    ctx.mode === 'tui' && typeof ctx.ui.custom === 'function'
      ? ctx.ui.custom<T>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, label)
          loader.onAbort = () => done(cancelled)
          void run(loader.signal).then((result) => {
            if (!loader.signal.aborted) done(result)
          })
          return loader
        })
      : run()
  const setPreference = async (
    ctx: ExtensionContext,
    key: PreferenceKey,
    value: string | boolean | undefined,
  ): Promise<boolean> => {
    if (resetting || !ctx.isIdle() || runtime.status().activeTurns > 0) {
      ctx.ui.notify('Wait until Antigravity and Pi are idle before changing ACP settings.', 'warning')
      return false
    }
    const previous = preferences
    try {
      preferences = writePreferences(configPath, stateHome, { [key]: value })
    } catch (error) {
      ctx.ui.notify(`Could not update ${configPath}: ${String(error)}`, 'error')
      return false
    }
    if (
      previous.command !== preferences.command ||
      previous.home !== preferences.home ||
      previous.nativeWrites !== preferences.nativeWrites
    ) {
      clearStatus(ctx)
      await reset()
      if (shutDown) return false
      register()
    } else {
      updateStatus(ctx, activeRuntime?.quota.peek())
    }
    return true
  }
  pi.registerCommand('agy-acp', {
    description: 'Antigravity ACP configuration, status, quota, refresh, or reset',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart()
      const items = [
        'status',
        'config',
        ...PREFERENCE_KEYS.map((key) => `config ${key}`),
        'quota',
        'quota used',
        'quota remaining',
        'native-writes',
        'native-writes on',
        'native-writes off',
        'refresh',
        'reset',
      ]
        .filter((command) => command.startsWith(normalized))
        .map((value) => ({ value, label: value }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      if (shutDown) return
      const tokens = args.trim().split(/\s+/).filter(Boolean)
      const command = tokens[0] ?? ''
      if (command === 'config') {
        const effective = {
          ...preferences,
          command: preferences.command || '(auto-discovered)',
          home: preferences.home || stateHome,
        }
        if (tokens.length === 1) {
          ctx.ui.notify(`${configPath}\n${JSON.stringify(effective, null, 2)}`, 'info')
          return
        }
        const [, name, raw] = /^config\s+(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim()) ?? []
        const key = PREFERENCE_KEYS.find((item) => item === name)
        if (key === undefined) {
          ctx.ui.notify(`Usage: /agy-acp config [${PREFERENCE_KEYS.join('|')} [value]]`, 'warning')
          return
        }
        if (raw === undefined) {
          ctx.ui.notify(`${key}: ${effective[key]} (${configPath})`, 'info')
          return
        }
        let value: string | boolean | undefined
        try {
          value = parsePreferenceValue(key, raw)
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'warning')
          return
        }
        if (await setPreference(ctx, key, value))
          ctx.ui.notify(`Saved ${key}: ${value ?? 'default'} to ${configPath}`, 'info')
        return
      }
      if (command === 'native-writes') {
        const setting = tokens[1]
        if (tokens.length === 1) {
          ctx.ui.notify(`Antigravity native writes: ${preferences.nativeWrites ? 'on' : 'off'} (${configPath})`, 'info')
        } else if (tokens.length !== 2 || (setting !== 'on' && setting !== 'off')) {
          ctx.ui.notify('Usage: /agy-acp native-writes [on|off]', 'warning')
        } else if (await setPreference(ctx, 'nativeWrites', setting === 'on')) {
          ctx.ui.notify(`Antigravity native writes: ${setting} (saved to ${configPath})`, 'info')
        }
        return
      }
      const requestedDisplay =
        command === 'quota' && tokens.length === 2
          ? asQuotaDisplay(tokens[1])
          : undefined
      if (command === 'refresh' && tokens.length === 1) {
        const outcome = await withLoader<RefreshOutcome>(
          ctx,
          'Refreshing Antigravity models...',
          { status: 'cancelled' },
          refreshModelsSafe,
        )
        if (shutDown) return
        if (outcome.status === 'cancelled') {
          ctx.ui.notify('Model refresh cancelled', 'info')
          return
        }
        if (outcome.status === 'error') {
          ctx.ui.notify(
            `Antigravity model refresh failed: ${outcome.error}`,
            'error',
          )
          return
        }
        ctx.ui.notify(
          `Refreshed Antigravity catalog (${outcome.count} model${outcome.count === 1 ? '' : 's'})`,
          'info',
        )
        return
      }
      if (command === 'reset' && tokens.length === 1) {
        clearStatus(ctx)
        await reset(true)
        if (!shutDown) ctx.ui.notify('Antigravity ACP sessions reset', 'info')
        return
      }
      const isStatus =
        (command === '' || command === 'status') && tokens.length <= 1
      const isQuota =
        command === 'quota' &&
        (tokens.length === 1 || requestedDisplay !== undefined)
      if (!isStatus && !isQuota) {
        ctx.ui.notify(
          'Usage: /agy-acp [status|config|native-writes [on|off]|quota [used|remaining]|refresh|reset]',
          'warning',
        )
        return
      }
      if (requestedDisplay !== undefined && !(await setPreference(ctx, 'quotaDisplay', requestedDisplay)))
        return
      let snapshot: QuotaSnapshot | null = null
      const epoch = uiEpoch
      if (command === 'quota') {
        // readQuotaSafe converts runtime errors into snapshots so loaders always close cleanly.
        snapshot = await withLoader<QuotaSnapshot | null>(
          ctx,
          'Fetching Antigravity quota...',
          null,
          () => readQuotaSafe(),
        )
        if (shutDown) return
        if (snapshot === null) {
          if (epoch === uiEpoch) updateStatus(ctx, activeRuntime?.quota.peek())
          ctx.ui.notify('Quota check cancelled', 'info')
          return
        }
      }
      const notice = snapshot
        ? formatQuota(snapshot, undefined, preferences.quotaDisplay)
        : formatStatus(
            runtime.status(
              ctx.model?.provider === config.provider
                ? ctx.model.id
                : undefined,
            ),
          )
      if (epoch === uiEpoch)
        updateStatus(ctx, snapshot ?? activeRuntime?.quota.peek())
      ctx.ui.notify(notice.text, notice.level)
    },
  })
}
