/**
 * Configuration management using bunfig
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DcpConfigWithPruneRuleObjects,
  DcpConfigWithRuleRefs,
  PruneRule,
  isPruneRuleObject,
  type DcpConfig,
  type ProtectedToolsConfig,
} from "./types";
import {
  DEFAULT_PROTECTED_TOOLS,
  COMPRESS_PROTECTED_TOOLS,
  mergeProtectedTools,
} from "./protected-tools";
import { loadConfig as bunfigLoad } from "bunfig";
import { getRule, getRuleNames } from "./registry";
import { getLogger } from "./logger";
import { DEFAULT_CONTEXT_LIMITS, validateContextLimits } from "./context-limits";

/**
 * Default configuration
 */
const DEFAULT_CONFIG: DcpConfigWithRuleRefs = {
  enabled: true,
  debug: false,
  rules: ["deduplication", "superseded-writes", "error-purging", "tool-pairing", "recency"],
  keepRecentCount: 10,
  turnProtection: { enabled: true, turns: 3 },
  summaryBuffer: true,
  contextLimits: DEFAULT_CONTEXT_LIMITS,
  protectedTools: {
    global: [],
    compress: [],
  },
};

/**
 * Load configuration from extension settings, files, or defaults
 * Priority (highest to lowest):
 * 1. CLI flags (--dcp-enabled, --dcp-debug)
 * 2. Config file in current directory (dcp.config.ts, etc.)
 * 3. Config file in home directory (~/.dcprc)
 * 4. Default configuration
 */
export async function loadConfig(pi: ExtensionAPI): Promise<DcpConfigWithPruneRuleObjects> {
  // bunfig automatically searches for config files in cwd and home directory
  // It supports: dcp.config.{ts,js,json,toml,yaml}, .dcprc{,.json,.toml,.yaml}
  // and package.json with "dcp" key
  const config = await bunfigLoad<DcpConfigWithRuleRefs>({
    name: "pi-dcp",
    cwd: process.cwd(),
    defaultConfig: DEFAULT_CONFIG,
    checkEnv: true, // Allow DCP_ENABLED, DCP_DEBUG, etc.
  });

  // Apply flag overrides (highest priority)
  const enabled = pi.getFlag("--dcp-enabled");
  const debug = pi.getFlag("--dcp-debug");

  // Filter out invalid rules
  const availableRuleNames = getRuleNames();

  const invalidRuleNames: string[] = [];

  const rules: PruneRule[] = config.rules
    .filter((rule) => {
      if (isPruneRuleObject(rule)) {
        return true; // Keep non-string rules (custom rule objects)
      }
      if (typeof rule === "string" && availableRuleNames.includes(rule)) {
        return true; // Valid rule name
      }
      invalidRuleNames.push(typeof rule === "string" ? rule : JSON.stringify(rule));
      return false; // Remove invalid rule names
    })
    .map((rule) => {
      if (typeof rule === "string") {
        return getRule(rule)!; // Non-null due to filtering above
      }
      return rule;
      // convert string rule name to rule object
    });

  if (enabled !== undefined) {
    config.enabled = enabled as boolean;
  }
  if (debug !== undefined) {
    config.debug = debug as boolean;
  }

  // Log invalid rules if debug is enabled
  if (config.debug && invalidRuleNames.length > 0) {
    getLogger().warn(
      `The following configured rules are invalid and will be ignored: ${invalidRuleNames.join(", ")}`
    );
  }

  // Validate contextLimits
  const limitErrors = validateContextLimits(config.contextLimits);
  if (limitErrors.length > 0) {
    getLogger().warn(`Invalid contextLimits config, using defaults: ${limitErrors.join("; ")}`);
    config.contextLimits = DEFAULT_CONTEXT_LIMITS;
  }

  return {
    ...config,
    rules,
  };
}

/**
 * Get default configuration (useful for testing or displaying defaults)
 */
export function getDefaultConfig(): DcpConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Resolve the effective protected tool lists from config.
 * Merges user config with built-in defaults.
 *
 * Returns:
 * - `global` — applies to all pruning (auto rules + LLM tools)
 * - `compress` — additional tools protected during compression (merged with global)
 */
export function resolveProtectedTools(userConfig?: ProtectedToolsConfig): {
  global: string[];
  compress: string[];
} {
  const userGlobal = userConfig?.global ?? [];
  const userCompress = userConfig?.compress ?? [];

  const globalList = mergeProtectedTools(DEFAULT_PROTECTED_TOOLS, userGlobal);
  const compressList = mergeProtectedTools(globalList, COMPRESS_PROTECTED_TOOLS, userCompress);

  return { global: globalList, compress: compressList };
}

/**
 * Generate sample configuration file content
 * Used by the init command to create dcp.config.ts
 */
export function generateConfigFileContent(options?: { simplified?: boolean }): string {
  const simplified = options?.simplified ?? false;

  if (simplified) {
    return `/**
 * DCP (Dynamic Context Pruning) Configuration
 * 
 * Place this file as:
 * - ./dcp.config.ts (project-specific)
 * - ~/.dcprc (user-wide)
 */

import type { DcpConfig } from "~/.pi/agent/extensions/pi-dcp/src/types";

export default {
	enabled: true,
	debug: false,
	rules: ["deduplication", "superseded-writes", "error-purging", "tool-pairing", "recency"],
	keepRecentCount: 10,
} satisfies DcpConfig;
`;
  }

  return `/**
 * DCP (Dynamic Context Pruning) Configuration
 * 
 * This file configures the pi-dcp extension for intelligent context pruning.
 * 
 * Place this file as:
 * - ./dcp.config.ts (project-specific configuration)
 * - ~/.dcprc (user-wide configuration)
 * 
 * All fields are optional - defaults will be used for missing values.
 */

import type { DcpConfig } from "~/.pi/agent/extensions/pi-dcp/src/types";

export default {
	// Enable/disable DCP entirely
	enabled: true,

	// Enable debug logging to see what gets pruned
	debug: false,

	// Rules to apply (in order of execution)
	// Available built-in rules:
	// - "deduplication": Remove duplicate tool outputs
	// - "superseded-writes": Remove older file versions
	// - "error-purging": Remove resolved errors
	// - "tool-pairing": Preserve tool_use/tool_result pairing (CRITICAL)
	// - "recency": Always keep recent messages
	rules: [
		"deduplication",
		"superseded-writes",
		"error-purging",
		"tool-pairing",
		"recency",
	],

	// Number of recent messages to always keep (for recency rule)
	keepRecentCount: 10,

	// Protected tools — shielded from pruning. Supports globs (e.g. "subagent*")
	// Built-in defaults: dcp_*, todo, subagent*, context_*, plannotator_submit_plan
	// protectedTools: {
	//   global: [],       // Additional tools protected from ALL pruning
	//   compress: [],     // Additional tools protected from compression only
	// },
} satisfies DcpConfig;
`;
}

/**
 * Write configuration file to the specified path
 *
 * @param path - Full path where to write the config file
 * @param options - Options for file generation
 * @returns Promise that resolves when file is written
 */
export async function writeConfigFile(
  path: string,
  options?: { force?: boolean; simplified?: boolean }
): Promise<void> {
  const fs = await import("fs/promises");
  const force = options?.force ?? false;

  // Check if file already exists
  if (!force) {
    try {
      await fs.access(path);
      throw new Error("Config file already exists. Use force option to overwrite.");
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      // File doesn't exist, proceed
    }
  }

  const content = generateConfigFileContent(options);
  await fs.writeFile(path, content, "utf-8");
}
