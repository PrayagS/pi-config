import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface SummaryConfig {
  enabled: boolean;
  mode: "auto" | "manual";
  model: string;
  reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  keepRecentTurns: number;
  minSourceChars: number;
  minBatchChars: number;
  maxInputChars: number;
  maxSourcesPerBatch: number;
  maxBatchesPerRun: number;
  maxSessionCalls: number;
  maxOutputTokens: number;
  timeoutMs: number;
  cooldownMs: number;
  minSavingsRatio: number;
  allowedTools: string[];
  protectedTools: string[];
}

export const DEFAULT_CONFIG: SummaryConfig = {
  enabled: true,
  mode: "auto",
  model: "default",
  reasoning: "low",
  keepRecentTurns: 2,
  minSourceChars: 1500,
  minBatchChars: 8000,
  maxInputChars: 60000,
  maxSourcesPerBatch: 12,
  maxBatchesPerRun: 2,
  maxSessionCalls: 20,
  maxOutputTokens: 2000,
  timeoutMs: 30000,
  cooldownMs: 60000,
  minSavingsRatio: 0.5,
  allowedTools: ["read", "bash", "grep", "find", "ls", "codemode"],
  protectedTools: ["context_recall", "context_summary", "ask_user", "subagent"],
};

export function validateConfig(value: unknown): SummaryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration object");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Expected a plain configuration object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown setting: ${key}`);
  const c = { ...DEFAULT_CONFIG, ...input } as SummaryConfig;
  if (typeof c.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (!["auto", "manual"].includes(c.mode)) throw new Error("mode must be auto or manual");
  if (typeof c.model !== "string" || !c.model.trim() || (c.model !== "default" && !/^[^\s/]+\/[^\s]+$/.test(c.model))) throw new Error("model must be default or provider/model-id");
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(c.reasoning)) throw new Error("Invalid reasoning level");
  const bounds: Record<string, [number, number]> = {
    keepRecentTurns: [1, 100], minSourceChars: [100, 100000], minBatchChars: [100, 1000000],
    maxInputChars: [1000, 200000], maxSourcesPerBatch: [1, 32], maxBatchesPerRun: [1, 8],
    maxSessionCalls: [1, 1000], maxOutputTokens: [128, 16000], timeoutMs: [1000, 120000], cooldownMs: [1000, 3600000],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = c[key as keyof SummaryConfig];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  if (c.minBatchChars > c.maxInputChars) throw new Error("minBatchChars must not exceed maxInputChars");
  if (typeof c.minSavingsRatio !== "number" || !Number.isFinite(c.minSavingsRatio) || c.minSavingsRatio < 0.1 || c.minSavingsRatio > 0.95) throw new Error("minSavingsRatio must be between 0.1 and 0.95");
  for (const key of ["allowedTools", "protectedTools"] as const) {
    if (!Array.isArray(c[key]) || c[key].length > 100 || c[key].some(n => typeof n !== "string" || !n.trim())) throw new Error(`${key} must contain tool names`);
    c[key] = [...new Set(c[key].map(n => n.trim()))];
  }
  return c;
}

export async function loadConfig(file: string): Promise<{ config: SummaryConfig; warning?: string }> {
  try { return { config: validateConfig(JSON.parse(await readFile(file, "utf8"))) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: validateConfig({}) };
    return { config: validateConfig({ enabled: false }), warning: "Invalid or unreadable context-summary configuration; summarization disabled. Correct the configuration before enabling." };
  }
}

export async function saveConfig(file: string, config: SummaryConfig): Promise<void> {
  const validated = validateConfig(config);
  await withFileMutationQueue(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => undefined); }
  });
}
