/**
 * Model catalog derived from the agent's session configuration options. The
 * ACP server advertises model families (`gemini-4-argon`, `claude-opus-5-5`)
 * and a separate `thought_level` option; Pi lists each family once with the
 * efforts that family actually offers. Fixed-effort families such as
 * `gpt-oss-120b-medium` carry their effort in the id and expose no selector.
 * @module pi-agy-acp/catalog
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpTierInfo,
} from './acp-process.ts'
import { EFFORTS, type Effort } from './config.ts'
import {
  HARDCODED_MODELS,
  modelSpecFor,
  splitEffortSuffix,
} from './models.ts'

export { splitEffortSuffix }

/** One advertised model family. */
export interface CatalogModel {
  id: string
  name: string
}

/** One entry of the ACP `models.availableModels` list. */
export interface AvailableModel {
  modelId: string
  name?: string
}

/** Flatten flat or grouped ACP select option entries. */
export function flattenConfigOptions(
  options: AcpConfigOption['options'],
): AcpConfigOptionValue[] {
  if (!Array.isArray(options)) return []
  return options.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    return 'group' in entry
      ? Array.isArray(entry.options)
        ? entry.options
        : []
      : [entry]
  })
}

/** Resolved ACP `model` and `thought_level` selections for one logical Pi `(model, effort)` pair. */
export interface ResolvedAcpModelSelection {
  /** Exact `model` config option value to send to ACP (`<model>` or `<model>-<effort>`). */
  acpModelValue: string
  /** Effective effort after clamping against offered options. */
  targetEffort: Effort
  /** True when `acpModelValue` encodes the effort via suffix (skipping `thought_level`). */
  usesSuffixedModel: boolean
  /** Available raw ACP model values reported in `configOptions`, when present. */
  availableModelValues?: string[]
  /** Offered efforts from `thought_level` or suffixed variants, when present. */
  offeredEfforts?: Effort[]
}

/**
 * Dynamically map a logical `(model, effort)` request onto live ACP `configOptions`.
 * Handles both bare `<model>` + `thought_level` and effort-suffixed `<model>-<effort>`
 * (or `<model>-<effort>-effort`) model option values, skipping `thought_level` when
 * the model option itself pins the effort.
 * @returns resolved selection, or `undefined` when `model` is not offered by `configOptions`.
 */
export function resolveAcpModelSelection(
  model: string,
  effort: Effort,
  configOptions: readonly AcpConfigOption[],
): ResolvedAcpModelSelection | undefined {
  const modelOption = configOptions.find(
    (o) => o.id === 'model' || o.category === 'model',
  )
  const levelOption = configOptions.find(
    (o) => o.id === 'thought_level' || o.category === 'thought_level',
  )
  const levelEfforts =
    levelOption?.options !== undefined
      ? flattenConfigOptions(levelOption.options)
          .map((o) => o.value)
          .filter((v): v is Effort =>
            (EFFORTS as readonly string[]).includes(v),
          )
      : undefined
  const modelEntries =
    modelOption?.options !== undefined
      ? flattenConfigOptions(modelOption.options)
      : undefined
  if (modelEntries === undefined) {
    const targetEffort =
      levelEfforts !== undefined && levelEfforts.length > 0
        ? nearestEffort(effort, levelEfforts)
        : effort
    return {
      acpModelValue: model,
      targetEffort,
      usesSuffixedModel: false,
      ...(levelEfforts !== undefined ? { offeredEfforts: levelEfforts } : {}),
    }
  }
  const availableModelValues = modelEntries.map((o) => o.value)
  if (availableModelValues.includes(model)) {
    const targetEffort =
      levelEfforts !== undefined && levelEfforts.length > 0
        ? nearestEffort(effort, levelEfforts)
        : effort
    return {
      acpModelValue: model,
      targetEffort,
      usesSuffixedModel: false,
      availableModelValues,
      ...(levelEfforts !== undefined ? { offeredEfforts: levelEfforts } : {}),
    }
  }
  // Check effort-suffixed variants (e.g. `gemini-4-hydrogen-high` when `gemini-4-hydrogen` is requested).
  const byEffort = new Map<Effort, string>()
  for (const value of availableModelValues) {
    const split = splitEffortSuffix(value)
    if (split !== undefined && split.base === model && !byEffort.has(split.effort)) {
      byEffort.set(split.effort, value)
    }
  }
  if (byEffort.size === 0) return undefined
  const offeredEfforts = EFFORTS.filter((e) => byEffort.has(e))
  const targetEffort = nearestEffort(effort, offeredEfforts)
  return {
    acpModelValue: byEffort.get(targetEffort) as string,
    targetEffort,
    usesSuffixedModel: true,
    availableModelValues,
    offeredEfforts,
  }
}

function normalizeTier(
  tier: AcpTierInfo | undefined,
): { id?: string; name: string } | undefined {
  const name = typeof tier?.name === 'string' ? tier.name.trim() : ''
  if (!name) return undefined
  const id = typeof tier?.id === 'string' ? tier.id.trim() : ''
  return { name, ...(id ? { id } : {}) }
}

/**
 * Pick the offered effort closest to the requested one.
 * @param wanted - requested effort.
 * @param offered - efforts the model exposes.
 * @returns one of `offered`, or `wanted` when nothing is offered.
 */
export function nearestEffort(
  wanted: Effort,
  offered: readonly Effort[],
): Effort {
  if (offered.includes(wanted)) return wanted
  const distance = (effort: Effort): number =>
    Math.abs(EFFORTS.indexOf(effort) - EFFORTS.indexOf(wanted))
  let best: Effort | undefined
  for (const effort of offered) {
    if (best === undefined || distance(effort) < distance(best)) best = effort
  }
  return best ?? wanted
}

/** Observed catalog with a disk cache and hardcoded cold-start defaults. */
export class ModelCatalog {
  private models: CatalogModel[]
  private tierInfo: { id?: string; name: string } | undefined
  private efforts: Effort[] = []
  /** Efforts per model family; an empty array marks a fixed-effort or non-selectable model. */
  private byModel = new Map<string, Effort[]>()
  /** Server-reported `agentCapabilities.promptCapabilities.image` from `initialize`. */
  private supportsImageInput: boolean | undefined
  /** Latest `availableModels` snapshot, kept for later option updates. */
  private available: readonly AvailableModel[] | undefined
  /** Current on-disk `agy` binary fingerprint, if resolved. */
  private currentFingerprint: string | undefined
  /** Fingerprint of the `agy` binary that produced the cached catalog. */
  private observedFingerprint: string | undefined
  /** Whether the current models came from a disk cache file. */
  private loadedFromCache = false
  /** Whether a live ACP session has reported the catalog in this process. */
  observed = false
  private readonly cachePath: string

  /**
   * @param cachePath - JSON cache file.
   * @param binaryFingerprint - current `agy` binary fingerprint, if resolved.
   */
  constructor(cachePath: string, binaryFingerprint?: string) {
    this.cachePath = cachePath
    this.currentFingerprint = binaryFingerprint
    const cached = this.load()
    if (cached !== undefined) {
      this.models = cached
      this.loadedFromCache = true
    } else {
      this.models = HARDCODED_MODELS.map(({ id, name }) => ({ id, name }))
      const effortSet = new Set<Effort>()
      for (const model of HARDCODED_MODELS) {
        this.byModel.set(model.id, [...model.efforts])
        for (const effort of model.efforts) effortSet.add(effort)
      }
      this.efforts = EFFORTS.filter((e) => effortSet.has(e))
    }
  }

  /** Whether disk-cached models match the current `agy` binary fingerprint. */
  hasFreshCache(): boolean {
    return (
      this.loadedFromCache &&
      this.models.length > 0 &&
      (this.currentFingerprint === undefined ||
        this.observedFingerprint === this.currentFingerprint)
    )
  }

  /** Whether the catalog is current without probing ACP. */
  isCurrent(): boolean {
    return this.observed || this.hasFreshCache()
  }

  /** Whether the agent supports native image prompt blocks. */
  supportsImage(): boolean {
    return this.supportsImageInput !== false
  }

  /** Input modalities advertised to Pi, derived from `initialize` `promptCapabilities.image`. */
  inputModalities(): ('text' | 'image')[] {
    return this.supportsImage() ? ['text', 'image'] : ['text']
  }

  /**
   * Record `agentCapabilities.promptCapabilities.image` from ACP `initialize`.
   * @returns whether the advertised input modalities changed.
   */
  observeImageSupport(supported: boolean | undefined): boolean {
    if (typeof supported !== 'boolean') return false
    const before = this.supportsImageInput !== false
    const changed = this.supportsImageInput !== supported
    if (!changed) return false
    this.supportsImageInput = supported
    this.save()
    return before !== supported
  }

  /**
   * Reconcile cached state against the current `agy` binary fingerprint.
   * Marks the catalog stale when the binary changed so the next warmup or
   * session re-probes fresh models.
   * @returns whether cached state was invalidated.
   */
  syncBinaryFingerprint(fingerprint: string | undefined): boolean {
    if (!fingerprint || this.currentFingerprint === fingerprint) return false
    this.currentFingerprint = fingerprint
    if (this.observedFingerprint === fingerprint) return false
    const wasObserved = this.observed
    this.observed = false
    return wasObserved
  }

  /**
   * Hardcoded context window for one model family (1M for Gemini/Claude families).
   * @param modelId - family id.
   */
  contextWindowFor(modelId: string): number {
    return modelSpecFor(modelId).contextWindow
  }

  /**
   * Hardcoded max output tokens for one model family.
   * @param modelId - family id.
   */
  maxTokensFor(modelId: string): number {
    return modelSpecFor(modelId).maxTokens
  }

  /** Current families. */
  list(): readonly CatalogModel[] {
    return this.models
  }

  /** Last subscription plan reported by ACP, including the disk cache. */
  tier(): Readonly<{ id?: string; name: string }> | undefined {
    return this.tierInfo
  }

  /** Efforts the account offers globally, in escalation order. */
  effortList(): readonly Effort[] {
    return this.efforts
  }

  /**
   * Efforts one family actually offers. Empty means the family is a single
   * fixed variant (for example `gpt-oss-120b-medium`) or offers no selector.
   * @param id - family id.
   * @returns offered efforts.
   */
  effortsFor(id: string): readonly Effort[] {
    const observed = this.byModel.get(id)
    if (observed !== undefined) return observed
    return this.fixedEffort(id) === undefined ? this.efforts : []
  }

  /**
   * Whether a model accepts `thought_level` writes on a live ACP session.
   * Fixed-effort models and models observed with zero effort variants return false.
   */
  supportsEffortSelection(id: string): boolean {
    const observed = this.byModel.get(id)
    if (observed !== undefined) return observed.length > 0
    return this.fixedEffort(id) === undefined
  }

  /**
   * Effort baked into a fixed-variant id.
   * @param id - family id.
   * @returns the effort, or undefined for a selectable family.
   */
  fixedEffort(id: string): Effort | undefined {
    return splitEffortSuffix(id)?.effort
  }

  /**
   * Fold session configuration options and the session's model inventory into
   * the catalog.
   * @param options - options from `session/new` or `config_option_update`.
   * @param available - `models.availableModels` from `session/new`.
   * @param tier - subscription metadata from `session/new`.
   * @returns whether the family list changed.
   */
  observe(
    options: readonly AcpConfigOption[] | undefined,
    available?: readonly AvailableModel[] | undefined,
    tier?: AcpTierInfo,
  ): boolean {
    const nextTier = normalizeTier(tier)
    const tierChanged =
      nextTier !== undefined &&
      JSON.stringify(nextTier) !== JSON.stringify(this.tierInfo)
    if (tierChanged) this.tierInfo = nextTier
    if (available !== undefined && available.length > 0)
      this.available = available
    if (options === undefined) {
      if (tierChanged) this.save()
      return false
    }
    const modelOption = options.find(
      (o) => o.id === 'model' || o.category === 'model',
    )
    const levelOption = options.find(
      (o) => o.id === 'thought_level' || o.category === 'thought_level',
    )
    const beforeEfforts = JSON.stringify(this.efforts)
    const levelEfforts =
      levelOption?.options !== undefined
        ? flattenConfigOptions(levelOption.options)
            .map((o) => o.value)
            .filter((v): v is Effort =>
              (EFFORTS as readonly string[]).includes(v),
            )
        : []
    const modelEntries = flattenConfigOptions(modelOption?.options)
    let next = this.models
    const optionEffortsByBase = new Map<string, Set<Effort>>()
    if (modelEntries.length > 0) {
      // Group multi-effort suffixed configOptions (e.g. `foo-low`, `foo-high`)
      // into one logical family `foo` while preserving single fixed-effort models
      // (e.g. `gpt-oss-120b-medium`) as standalone entries.
      const suffixGroups = new Map<
        string,
        { entries: AcpConfigOptionValue[]; efforts: Set<Effort> }
      >()
      const rawValues = new Set(modelEntries.map((o) => o.value))
      for (const entry of modelEntries) {
        const split = splitEffortSuffix(entry.value)
        if (split === undefined || rawValues.has(split.base)) continue
        let group = suffixGroups.get(split.base)
        if (group === undefined) {
          group = { entries: [], efforts: new Set() }
          suffixGroups.set(split.base, group)
        }
        group.entries.push(entry)
        group.efforts.add(split.effort)
      }
      const emitted = new Set<string>()
      const grouped: CatalogModel[] = []
      for (const entry of modelEntries) {
        const split = splitEffortSuffix(entry.value)
        const group =
          split !== undefined ? suffixGroups.get(split.base) : undefined
        if (split !== undefined && group !== undefined && group.efforts.size > 1) {
          if (emitted.has(split.base)) continue
          emitted.add(split.base)
          optionEffortsByBase.set(split.base, group.efforts)
          const baseName = (entry.name ?? split.base)
            .replace(/\s*\([^)]*\)\s*$/u, '')
            .replace(/\s+(low|medium|high|xhigh|max)(\s+effort)?$/iu, '')
            .trim()
          grouped.push({ id: split.base, name: baseName || split.base })
          continue
        }
        if (emitted.has(entry.value)) continue
        emitted.add(entry.value)
        grouped.push({ id: entry.value, name: entry.name ?? entry.value })
      }
      next = grouped
    }
    this.observed = true
    const changed = JSON.stringify(next) !== JSON.stringify(this.models)
    if (changed) this.models = next
    const fingerprintChanged =
      modelEntries.length > 0 &&
      this.currentFingerprint !== undefined &&
      this.observedFingerprint !== this.currentFingerprint
    if (fingerprintChanged) this.observedFingerprint = this.currentFingerprint
    let prunedChanged = false
    if (modelEntries.length > 0) {
      const activeIds = new Set(this.models.map((m) => m.id))
      for (const id of [...this.byModel.keys()]) {
        if (!activeIds.has(id)) {
          this.byModel.delete(id)
          prunedChanged = true
        }
      }
    }
    let optionDerivedChanged = false
    for (const [base, set] of optionEffortsByBase) {
      const offered = EFFORTS.filter((e) => set.has(e))
      if (JSON.stringify(this.byModel.get(base)) !== JSON.stringify(offered)) {
        this.byModel.set(base, offered)
        optionDerivedChanged = true
      }
    }
    const derivedChanged = this.deriveEfforts() || optionDerivedChanged
    const union = new Set<Effort>(levelEfforts)
    for (const model of this.models) {
      const values = this.byModel.get(model.id)
      if (values !== undefined) {
        for (const effort of values) union.add(effort)
      }
    }
    if (union.size > 0) {
      this.efforts = EFFORTS.filter((e) => union.has(e))
    }
    const effortsChanged =
      prunedChanged ||
      derivedChanged ||
      beforeEfforts !== JSON.stringify(this.efforts)
    if (changed || effortsChanged || tierChanged || fingerprintChanged)
      this.save()
    return changed || effortsChanged
  }

  /** Recompute per-family efforts from the latest inventory. */
  private deriveEfforts(): boolean {
    if (this.available === undefined) return false
    const byBase = new Map<string, Set<Effort>>()
    for (const entry of this.available) {
      const split = splitEffortSuffix(entry.modelId)
      if (split === undefined) continue
      let set = byBase.get(split.base)
      if (set === undefined) {
        set = new Set<Effort>()
        byBase.set(split.base, set)
      }
      set.add(split.effort)
    }
    let changed = false
    for (const model of this.models) {
      const matched = byBase.get(model.id)
      const offered =
        matched !== undefined
          ? EFFORTS.filter((effort) => matched.has(effort))
          : []
      if (offered.length > 0) {
        if (
          JSON.stringify(this.byModel.get(model.id)) !== JSON.stringify(offered)
        ) {
          this.byModel.set(model.id, offered)
          changed = true
        }
        continue
      }
      const present = this.available.some((entry) => entry.modelId === model.id)
      if (!present) continue
      const prevEfforts = this.effortsFor(model.id)
      if (this.byModel.get(model.id)?.length !== 0) {
        this.byModel.set(model.id, [])
        if (prevEfforts.length !== 0) changed = true
      }
    }
    return changed
  }

  private save(): void {
    const dir = dirname(this.cachePath)
    const tempPath = join(
      dir,
      `.${basename(this.cachePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`,
    )
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        tempPath,
        `${JSON.stringify(
          {
            models: this.models,
            efforts: this.efforts,
            byModel: Object.fromEntries(this.byModel),
            tier: this.tierInfo,
            ...(this.supportsImageInput !== undefined
              ? { supportsImage: this.supportsImageInput }
              : {}),
            ...(this.observedFingerprint !== undefined
              ? { binaryFingerprint: this.observedFingerprint }
              : {}),
          },
          null,
          2,
        )}\n`,
      )
      renameSync(tempPath, this.cachePath)
    } catch (_cacheWrite) {
      try {
        unlinkSync(tempPath)
      } catch {
        // Best-effort cleanup.
      }
      // The cache only speeds up the next cold start.
    }
  }

  private load(): CatalogModel[] | undefined {
    if (!existsSync(this.cachePath)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as {
        models?: CatalogModel[]
        efforts?: string[]
        byModel?: Record<string, string[]>
        tier?: AcpTierInfo
        supportsImage?: unknown
        binaryFingerprint?: unknown
      } | null
      if (parsed === null || typeof parsed !== 'object') return undefined
      const storedFingerprint =
        typeof parsed.binaryFingerprint === 'string' &&
        parsed.binaryFingerprint.length > 0
          ? parsed.binaryFingerprint
          : undefined
      this.observedFingerprint = storedFingerprint
      this.tierInfo = normalizeTier(parsed.tier)
      if (typeof parsed.supportsImage === 'boolean') {
        this.supportsImageInput = parsed.supportsImage
      }
      if (Array.isArray(parsed.efforts)) {
        const efforts = parsed.efforts.filter((v): v is Effort =>
          (EFFORTS as readonly string[]).includes(v),
        )
        if (efforts.length > 0) this.efforts = efforts
      }
      if (parsed.byModel !== null && typeof parsed.byModel === 'object') {
        for (const [id, values] of Object.entries(parsed.byModel)) {
          if (!Array.isArray(values)) continue
          const efforts = values.filter((v): v is Effort =>
            (EFFORTS as readonly string[]).includes(v),
          )
          this.byModel.set(id, efforts)
        }
      }
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter(
            (m) => typeof m?.id === 'string' && typeof m?.name === 'string',
          )
        : []
      return models.length > 0 ? models : undefined
    } catch (_cacheRead) {
      // A corrupt cache falls back to hardcoded defaults until live ACP discovery runs.
      return undefined
    }
  }
}
